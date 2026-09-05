import { NodeIO, Primitive, type Accessor, type Document, type Primitive as PrimitiveType } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { cloneDocument, getGLPrimitiveCount, simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptDecoder } from "meshoptimizer";
import { fileSize, readFirstBytes, sha256Buffer, sha256File, writeAtomic } from "./fs-utils.js";
import type { LevelReport, PresetLevel, PrototypeStats } from "./types.js";

const GLB_MAGIC = Buffer.from("glTF", "ascii");

export interface SimplifiedLevel {
  bytes: Uint8Array;
  geometricErrorMeters: number;
  stats: PrototypeStats;
}

export interface GLBResult {
  sourceBytes: number;
  sourceHash: string;
  sourceStats: PrototypeStats;
  levels: LevelReport[];
}

export function createIO(): NodeIO {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}

export async function validateGLB(path: string, io = createIO()): Promise<void> {
  const magic = await readFirstBytes(path, 4);
  if (!magic.equals(GLB_MAGIC)) throw new Error(`file is not a GLB: ${path}`);
  try {
    await io.read(path);
  } catch (error) {
    throw new Error(`cannot decode GLB ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function simplifyGLB(
  inputPath: string,
  outputPathForLevel: (level: number) => string,
  levels: PresetLevel[],
): Promise<GLBResult> {
  const io = createIO();
  await validateGLB(inputPath, io);
  await MeshoptSimplifier.ready;
  const sourceDocument = await io.read(inputPath);
  const sourceStats = inspectDocument(sourceDocument);
  const sourceBytes = await fileSize(inputPath);
  const sourceHash = await sha256File(inputPath);
  const geometricScale = Math.max(computeDocumentScale(sourceDocument), Number.EPSILON);
  const reports: LevelReport[] = [];

  for (const level of levels) {
    const candidate = cloneDocument(sourceDocument);
    const normalizedError = level.maxErrorMeters / geometricScale;
    const measuredError = await estimateError(candidate, level, normalizedError);
    await candidate.transform(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: level.ratio,
        error: normalizedError,
        lockBorder: level.lockBorder,
      }),
    );
    const outputStats = inspectDocument(candidate);
    if (sourceStats.triangleCount > 0 && outputStats.triangleCount >= sourceStats.triangleCount) {
      throw new Error(
        `LOD${level.level} did not reduce triangles (${sourceStats.triangleCount} -> ${outputStats.triangleCount})`,
      );
    }
    const bytes = await io.writeBinary(candidate);
    const outputPath = outputPathForLevel(level.level);
    await writeAtomic(outputPath, bytes);
    await validateGLB(outputPath, io);
    reports.push({
      level: level.level,
      path: outputPath,
      inputBytes: sourceBytes,
      outputBytes: bytes.byteLength,
      inputTriangles: sourceStats.triangleCount,
      outputTriangles: outputStats.triangleCount,
      inputVertices: sourceStats.vertexCount,
      outputVertices: outputStats.vertexCount,
      targetRatio: level.ratio,
      targetErrorMeters: level.maxErrorMeters,
      geometricErrorMeters: measuredError,
      method: "meshopt-simplify",
      sha256: await sha256Buffer(bytes),
      status: "succeeded",
    });
  }

  return { sourceBytes, sourceHash, sourceStats, levels: reports };
}

export async function inspectGLB(path: string): Promise<PrototypeStats> {
  const io = createIO();
  await validateGLB(path, io);
  return inspectDocument(await io.read(path));
}

export function inspectDocument(document: Document): PrototypeStats {
  let primitives = 0;
  let triangleCount = 0;
  let vertexCount = 0;
  let unsupportedPrimitives = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const mode = primitive.getMode();
      const primitiveCount = getGLPrimitiveCount(primitive);
      if (mode === Primitive.Mode.TRIANGLES || mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN) {
        triangleCount += primitiveCount;
      } else {
        unsupportedPrimitives += 1;
      }
      const position = primitive.getAttribute("POSITION");
      vertexCount += position?.getCount() ?? 0;
    }
  }
  return {
    meshes: document.getRoot().listMeshes().length,
    primitives,
    triangleCount,
    vertexCount,
    unsupportedPrimitives,
  };
}

function computeDocumentScale(document: Document): number {
  let scale = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      if (!position) continue;
      const values = readAccessorElements(position, 3);
      scale = Math.max(scale, MeshoptSimplifier.getScale(values, 3));
    }
  }
  return scale;
}

async function estimateError(document: Document, level: PresetLevel, normalizedError: number): Promise<number> {
  await document.transform(weld({ overwrite: false }));
  let maximum = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (!isTrianglePrimitive(primitive)) continue;
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      if (!position || !indices) continue;
      const positionArray = readAccessorElements(position, 3);
      const indexArray = toUint32(indices.getArray());
      const targetCount = Math.floor((level.ratio * indexArray.length) / 3) * 3;
      if (targetCount >= indexArray.length || targetCount < 3) continue;
      const [, error] = MeshoptSimplifier.simplify(
        indexArray,
        positionArray,
        3,
        targetCount,
        normalizedError,
        level.lockBorder ? ["LockBorder"] : [],
      );
      maximum = Math.max(maximum, error * MeshoptSimplifier.getScale(positionArray, 3));
    }
  }
  return maximum;
}

function isTrianglePrimitive(primitive: PrimitiveType): boolean {
  const mode = primitive.getMode();
  return mode === Primitive.Mode.TRIANGLES || mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN;
}

function readAccessorElements(accessor: Accessor, elementSize: number): Float32Array {
  const result = new Float32Array(accessor.getCount() * elementSize);
  const element: number[] = [];
  for (let index = 0; index < accessor.getCount(); index += 1) {
    accessor.getElement(index, element);
    for (let component = 0; component < elementSize; component += 1) {
      result[index * elementSize + component] = element[component] ?? 0;
    }
  }
  return result;
}

function toUint32(array: ArrayLike<number> | null): Uint32Array {
  if (!array) return new Uint32Array();
  return Uint32Array.from(array);
}
