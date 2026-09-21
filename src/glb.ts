import { NodeIO, Primitive, type Accessor, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { convertPrimitiveToTriangles, getGLPrimitiveCount, simplify, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptEncoder, MeshoptSimplifier, MeshoptDecoder } from "meshoptimizer";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { PartLODUnsupported, simplifyPartGLB } from "./part-lod.js";
import { validateFeatureMetadata } from "./features.js";
import { loadGLTFResourceGraph, parseGLB } from "./resource-graph.js";
import { fileSize, readFirstBytes, removeIfExists, sha256Buffer, sha256File, writeAtomic } from "./fs-utils.js";
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

export type LODQualityFailureCode =
  | "unsupported-primitive"
  | "no-reduction"
  | "semantic-change"
  | "error-limit"
  | "external-resource";

export class LODQualityError extends Error {
  public readonly code: LODQualityFailureCode;

  public constructor(code: LODQualityFailureCode, message: string) {
    super(message);
    this.name = "LODQualityError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createIO(): NodeIO {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}

let dracoDecoderPromise: Promise<unknown> | undefined;
let dracoEncoderPromise: Promise<unknown> | undefined;

export async function createDecodeIO(): Promise<NodeIO> {
  dracoDecoderPromise ??= draco3d.createDecoderModule();
  dracoEncoderPromise ??= draco3d.createEncoderModule();
  const [decoder, encoder] = await Promise.all([dracoDecoderPromise, dracoEncoderPromise, MeshoptEncoder.ready]);
  return createIO().registerDependencies({
    "draco3d.decoder": decoder,
    "draco3d.encoder": encoder,
    "meshopt.encoder": MeshoptEncoder,
  });
}

export async function readGLB(path: string, io?: NodeIO): Promise<Document> {
  const reader = io ?? (await createDecodeIO());
  const magic = await readFirstBytes(path, 4);
  if (!magic.equals(GLB_MAGIC)) throw new Error(`file is not a GLB: ${path}`);
  try {
    const document = await reader.read(path);
    try {
      assertNoExternalResources(document, path);
      return document;
    } catch (error) {
      document.getRoot().dispose();
      throw error;
    }
  } catch (error) {
    if (error instanceof LODQualityError) throw error;
    throw new Error(`cannot decode GLB ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateGLB(path: string, io?: NodeIO): Promise<void> {
  const document = await readGLB(path, io);
  document.getRoot().dispose();
}

export async function validateGLBBytes(bytes: Uint8Array, io: NodeIO, label: string): Promise<Document> {
  if (bytes.byteLength < GLB_MAGIC.byteLength || !Buffer.from(bytes.subarray(0, 4)).equals(GLB_MAGIC)) {
    throw new Error(`file is not a GLB: ${label}`);
  }
  try {
    const document = await io.readBinary(bytes);
    try {
      assertNoExternalResources(document, label);
      return document;
    } catch (error) {
      document.getRoot().dispose();
      throw error;
    }
  } catch (error) {
    if (error instanceof LODQualityError) throw error;
    throw new Error(`cannot decode GLB ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function simplifyGLB(
  inputPath: string,
  outputPathForLevel: (level: number) => string,
  levels: PresetLevel[],
): Promise<GLBResult> {
  if (await prototypeHasPartFeatures(inputPath)) return simplifyPartPrototype(inputPath, outputPathForLevel, levels);
  const io = await createDecodeIO();
  const sourceDocument = await readGLB(inputPath, io);
  await MeshoptSimplifier.ready;
  const sourceStats = inspectDocument(sourceDocument);
  if (sourceStats.unsupportedPrimitives > 0) {
    throw new LODQualityError(
      "unsupported-primitive",
      `cannot simplify ${inputPath}: unsupported primitive modes ${sourceStats.unsupportedModes.join(", ")}; use the base-only preset`,
    );
  }
  if (sourceStats.triangleCount === 0) {
    throw new LODQualityError("no-reduction", `cannot simplify ${inputPath}: the prototype contains no triangle primitives`);
  }
  const sourceBytes = await fileSize(inputPath);
  const sourceHash = await sha256File(inputPath);
  const geometricScale = computeDocumentScale(sourceDocument);
  if (geometricScale <= Number.EPSILON) {
    throw new LODQualityError("no-reduction", `cannot simplify ${inputPath}: triangle positions have no measurable extent`);
  }
  for (const mesh of sourceDocument.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (isTriangleMode(primitive.getMode()) && !primitive.getIndices()) {
        throw new LODQualityError(
          "no-reduction",
          `cannot simplify ${inputPath}: triangle primitives must be indexed before simplification`,
        );
      }
    }
  }
  const sourceSemantics = captureSemanticSnapshot(sourceDocument);
  sourceDocument.getRoot().dispose();
  const reports: LevelReport[] = [];
  const writtenOutputs: string[] = [];

  try {
    for (const level of levels) {
      const candidate = await readGLB(inputPath, io);
      try {
        const normalizedError = level.maxErrorMeters / geometricScale;
        let measuredError = await estimateError(candidate, level, normalizedError);
        await candidate.transform(
          simplify({
            simplifier: MeshoptSimplifier,
            ratio: level.ratio,
            error: normalizedError,
            lockBorder: level.lockBorder,
          }),
        );
        let outputStats = inspectDocument(candidate);
        if (sourceStats.triangleCount > 0 && outputStats.triangleCount >= sourceStats.triangleCount) {
          const sloppy = simplifySloppyFallback(candidate, level, normalizedError);
          if (!sloppy.reduced) {
            throw new LODQualityError(
              "no-reduction",
              `LOD${level.level} did not reduce triangles (${sourceStats.triangleCount} -> ${outputStats.triangleCount})`,
            );
          }
          measuredError = Math.max(measuredError, sloppy.geometricErrorMeters);
          outputStats = inspectDocument(candidate);
        }
        assertSemanticSnapshot(sourceSemantics, candidate, level.level);
        if (sourceStats.triangleCount > 0 && outputStats.triangleCount >= sourceStats.triangleCount) {
          throw new LODQualityError(
            "no-reduction",
            `LOD${level.level} did not reduce triangles (${sourceStats.triangleCount} -> ${outputStats.triangleCount})`,
          );
        }
        const tolerance = Math.max(1e-6, level.maxErrorMeters * 1e-4);
        if (measuredError > level.maxErrorMeters + tolerance) {
          throw new LODQualityError(
            "error-limit",
            `LOD${level.level} geometric error ${measuredError}m exceeds ${level.maxErrorMeters}m`,
          );
        }
        const bytes = await io.writeBinary(candidate);
        const outputPath = outputPathForLevel(level.level);
        const decodedOutput = await validateGLBBytes(bytes, io, outputPath);
        try {
          assertSemanticSnapshot(sourceSemantics, decodedOutput, level.level);
        } finally {
          decodedOutput.getRoot().dispose();
        }
        await writeAtomic(outputPath, bytes);
        writtenOutputs.push(outputPath);
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
      } finally {
        candidate.getRoot().dispose();
      }
    }
  } catch (error) {
    for (const outputPath of writtenOutputs) await removeIfExists(outputPath);
    throw error;
  }

  return { sourceBytes, sourceHash, sourceStats, levels: reports };
}

async function simplifyPartPrototype(inputPath: string, outputPathForLevel: (level: number) => string, levels: PresetLevel[]): Promise<GLBResult> {
  await validateFeatureMetadata(await loadGLTFResourceGraph(dirname(inputPath), [basename(inputPath)]));
  const source = await readFile(inputPath);
  const reports: LevelReport[] = [];
  const outputs: string[] = [];
  let sourceStats: PrototypeStats | undefined;
  const io = await createDecodeIO();
  try {
    for (const level of levels) {
      const result = await simplifyPartGLB(source, level);
      sourceStats = result.sourceStats;
      const output = outputPathForLevel(level.level);
      const decoded = await validateGLBBytes(result.bytes, io, output);
      decoded.getRoot().dispose();
      await writeAtomic(output, result.bytes);
      outputs.push(output);
      await validateFeatureMetadata(await loadGLTFResourceGraph(dirname(output), [basename(output)]));
      reports.push({ level: level.level, path: output, inputBytes: source.length, outputBytes: result.bytes.length,
        inputTriangles: result.sourceStats.triangleCount, outputTriangles: result.stats.triangleCount,
        inputVertices: result.sourceStats.vertexCount, outputVertices: result.stats.vertexCount,
        targetRatio: level.ratio, targetErrorMeters: level.maxErrorMeters, geometricErrorMeters: result.error,
        method: "meshopt-simplify", sha256: await sha256Buffer(result.bytes), status: "succeeded" });
    }
  } catch (error) {
    for (const output of outputs) await removeIfExists(output);
    if (error instanceof PartLODUnsupported) throw new LODQualityError(error.message.startsWith("no-reduction") ? "no-reduction" : "semantic-change", error.message);
    throw error;
  }
  return { sourceBytes: source.length, sourceHash: await sha256Buffer(source), sourceStats: sourceStats ?? await inspectGLB(inputPath), levels: reports };
}

// 在 glTF-Transform 解码前检查原始 JSON，防止未知扩展被忽略后误入减面。
export async function prototypeHasPartFeatures(path: string): Promise<boolean> {
  const json = parseGLB(await readFile(path), path).json;
  const tables = json.extensions?.EXT_structural_metadata?.propertyTables ?? [];
  if (tables.some((table: { class?: string }) => table.class === "model_components") || (json.nodes ?? []).some((node: { extensions?: Record<string, unknown> }) => node.extensions?.EXT_mesh_gpu_instancing || node.extensions?.EXT_instance_features)) throw new Error(`LOD input must be a canonical prototype, not an assembled component/instance model: ${path}`);
  return tables.length > 0 || (json.extensionsUsed ?? []).some((name: string) => ["EXT_mesh_features", "EXT_instance_features", "EXT_structural_metadata"].includes(name));
}

interface SloppyFallbackResult {
  reduced: boolean;
  geometricErrorMeters: number;
}

/**
 * Meshopt's topology-preserving simplifier can reject meshes whose UV/normal
 * seams leave every candidate edge on a border.  simplifySloppy still uses
 * Meshopt's error metric, but permits those edges to collapse.  We only use
 * it after the regular simplifier produced no reduction and keep the original
 * vertex streams so the scene semantic snapshot remains unchanged.
 */
function simplifySloppyFallback(document: Document, level: PresetLevel, normalizedError: number): SloppyFallbackResult {
  let reduced = false;
  let maximumError = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      if (!position || !indices) continue;
      const indexArray = toUint32(indices.getArray());
      const targetCount = Math.floor((level.ratio * indexArray.length) / 3) * 3;
      if (targetCount >= indexArray.length || targetCount < 3) continue;
      const [simplified, error] = MeshoptSimplifier.simplifySloppy(
        indexArray,
        position.getArray(),
        3,
        null,
        targetCount,
        normalizedError,
      );
      if (simplified.length >= indexArray.length) continue;
      indices.setArray(simplified);
      reduced = true;
      maximumError = Math.max(maximumError, error * MeshoptSimplifier.getScale(position.getArray(), 3));
    }
  }
  return { reduced, geometricErrorMeters: maximumError };
}

export async function inspectGLB(path: string): Promise<PrototypeStats> {
  const document = await readGLB(path);
  try {
    return inspectDocument(document);
  } finally {
    document.getRoot().dispose();
  }
}

export function inspectDocument(document: Document): PrototypeStats {
  let primitives = 0;
  let triangleCount = 0;
  let vertexCount = 0;
  let unsupportedPrimitives = 0;
  const unsupportedModes = new Set<number>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const mode = primitive.getMode();
      const primitiveCount = getGLPrimitiveCount(primitive);
      if (mode === Primitive.Mode.TRIANGLES || mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN) {
        triangleCount += primitiveCount;
      } else {
        unsupportedPrimitives += 1;
        unsupportedModes.add(mode);
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
    unsupportedModes: [...unsupportedModes].sort((left, right) => left - right),
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
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() === Primitive.Mode.TRIANGLE_STRIP || primitive.getMode() === Primitive.Mode.TRIANGLE_FAN) {
        convertPrimitiveToTriangles(primitive);
      }
    }
  }
  let maximum = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
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

function assertNoExternalResources(document: Document, path: string): void {
  const externalTextures = document
    .getRoot()
    .listTextures()
    .map((texture) => texture.getURI())
    .filter((uri) => uri.length > 0 && !uri.startsWith("data:"));
  const externalBuffers = document
    .getRoot()
    .listBuffers()
    .map((buffer) => buffer.getURI())
    .filter((uri) => uri.length > 0 && !uri.startsWith("data:"));
  const externalResources = [...externalTextures, ...externalBuffers];
  if (externalResources.length > 0) {
    throw new LODQualityError(
      "external-resource",
      `GLB ${path} references external resources (${externalResources.join(", ")}); embed them before running model-lod-worker`,
    );
  }
}

interface SemanticSnapshot {
  rootExtras: Record<string, unknown>;
  defaultScene: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  scenes: unknown[];
  nodes: unknown[];
  meshes: unknown[];
  materials: unknown[];
  textures: unknown[];
  skins: unknown[];
  animations: unknown[];
}

function captureSemanticSnapshot(document: Document): string {
  const root = document.getRoot();
  const scenes = root.listScenes();
  const nodes = root.listNodes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();
  const textures = root.listTextures();
  const cameras = root.listCameras();
  const skins = root.listSkins();
  const animations = root.listAnimations();
  const indexOf = <T>(items: T[], item: T | null): number => (item ? items.indexOf(item) : -1);
  const textureIndex = (texture: ReturnType<typeof root.listTextures>[number] | null): number => indexOf(textures, texture);

  const snapshot: SemanticSnapshot = {
    rootExtras: root.getExtras(),
    defaultScene: indexOf(scenes, root.getDefaultScene()),
    extensionsUsed: root.listExtensionsUsed().map((extension) => extension.extensionName).sort(),
    extensionsRequired: root.listExtensionsRequired().map((extension) => extension.extensionName).sort(),
    scenes: scenes.map((scene) => ({
      name: scene.getName(),
      extras: scene.getExtras(),
      children: scene.listChildren().map((node) => indexOf(nodes, node)),
    })),
    nodes: nodes.map((node) => ({
      name: node.getName(),
      extras: node.getExtras(),
      translation: [...node.getTranslation()],
      rotation: [...node.getRotation()],
      scale: [...node.getScale()],
      weights: [...node.getWeights()],
      mesh: indexOf(meshes, node.getMesh()),
      camera: indexOf(cameras, node.getCamera()),
      skin: indexOf(skins, node.getSkin()),
      children: node.listChildren().map((child) => indexOf(nodes, child)),
    })),
    meshes: meshes.map((mesh) => ({
      name: mesh.getName(),
      extras: mesh.getExtras(),
      primitives: mesh.listPrimitives().map((primitive) => ({
        mode: semanticPrimitiveMode(primitive.getMode()),
        material: indexOf(materials, primitive.getMaterial()),
        semantics: [...primitive.listSemantics()].sort(),
        targets: primitive.listTargets().length,
        extras: primitive.getExtras(),
      })),
    })),
    materials: materials.map((material) => ({
      name: material.getName(),
      extras: material.getExtras(),
      alphaMode: material.getAlphaMode(),
      alphaCutoff: material.getAlphaCutoff(),
      doubleSided: material.getDoubleSided(),
      baseColorFactor: [...material.getBaseColorFactor()],
      emissiveFactor: [...material.getEmissiveFactor()],
      normalScale: material.getNormalScale(),
      occlusionStrength: material.getOcclusionStrength(),
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      textures: {
        baseColor: textureIndex(material.getBaseColorTexture()),
        emissive: textureIndex(material.getEmissiveTexture()),
        normal: textureIndex(material.getNormalTexture()),
        occlusion: textureIndex(material.getOcclusionTexture()),
        metallicRoughness: textureIndex(material.getMetallicRoughnessTexture()),
      },
    })),
    textures: textures.map((texture) => ({
      name: texture.getName(),
      extras: texture.getExtras(),
      mimeType: texture.getMimeType(),
      uri: texture.getURI(),
      imageBytes: texture.getImage()?.byteLength ?? 0,
    })),
    skins: skins.map((skin) => ({
      name: skin.getName(),
      extras: skin.getExtras(),
      skeleton: indexOf(nodes, skin.getSkeleton()),
      joints: skin.listJoints().map((joint) => indexOf(nodes, joint)),
      hasInverseBindMatrices: skin.getInverseBindMatrices() !== null,
    })),
    animations: animations.map((animation) => ({
      name: animation.getName(),
      extras: animation.getExtras(),
      channels: animation.listChannels().length,
      samplers: animation.listSamplers().length,
    })),
  };
  return stableJSONStringify(snapshot);
}

/**
 * Captures the parts of a GLB that an optimization transform must preserve.
 * Compression is intentionally excluded from this snapshot because it adds
 * extensions, quantizes accessors and may move position precision into node
 * transforms while leaving the rendered scene structure unchanged.
 */
export function captureOptimizationSnapshot(document: Document): string {
  const root = document.getRoot();
  const scenes = root.listScenes();
  const nodes = root.listNodes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();
  const textures = root.listTextures();
  const cameras = root.listCameras();
  const skins = root.listSkins();
  const indexOf = <T>(items: T[], item: T | null): number => (item ? items.indexOf(item) : -1);
  const textureIndex = (texture: ReturnType<typeof root.listTextures>[number] | null): number => indexOf(textures, texture);

  return stableJSONStringify({
    rootExtras: root.getExtras(),
    defaultScene: indexOf(scenes, root.getDefaultScene()),
    scenes: scenes.map((scene) => ({
      name: scene.getName(),
      extras: scene.getExtras(),
      children: scene.listChildren().map((node) => indexOf(nodes, node)),
    })),
    nodes: nodes.map((node) => ({
      name: node.getName(),
      extras: node.getExtras(),
      mesh: indexOf(meshes, node.getMesh()),
      camera: indexOf(cameras, node.getCamera()),
      skin: indexOf(skins, node.getSkin()),
      children: node.listChildren().map((child) => indexOf(nodes, child)),
    })),
    meshes: meshes.map((mesh) => ({
      name: mesh.getName(),
      extras: mesh.getExtras(),
      primitives: mesh.listPrimitives().map((primitive) => ({
        mode: primitive.getMode(),
        material: indexOf(materials, primitive.getMaterial()),
        semantics: [...primitive.listSemantics()].sort(),
        targets: primitive.listTargets().length,
        extras: primitive.getExtras(),
      })),
    })),
    materials: materials.map((material) => ({
      name: material.getName(),
      extras: material.getExtras(),
      alphaMode: material.getAlphaMode(),
      alphaCutoff: material.getAlphaCutoff(),
      doubleSided: material.getDoubleSided(),
      baseColorFactor: [...material.getBaseColorFactor()],
      emissiveFactor: [...material.getEmissiveFactor()],
      normalScale: material.getNormalScale(),
      occlusionStrength: material.getOcclusionStrength(),
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      textures: {
        baseColor: textureIndex(material.getBaseColorTexture()),
        emissive: textureIndex(material.getEmissiveTexture()),
        normal: textureIndex(material.getNormalTexture()),
        occlusion: textureIndex(material.getOcclusionTexture()),
        metallicRoughness: textureIndex(material.getMetallicRoughnessTexture()),
      },
    })),
    textures: textures.map((texture) => ({ name: texture.getName(), extras: texture.getExtras() })),
    skins: skins.map((skin) => ({
      name: skin.getName(),
      extras: skin.getExtras(),
      skeleton: indexOf(nodes, skin.getSkeleton()),
      joints: skin.listJoints().map((joint) => indexOf(nodes, joint)),
      hasInverseBindMatrices: skin.getInverseBindMatrices() !== null,
    })),
    animations: root.listAnimations().map((animation) => ({
      name: animation.getName(),
      extras: animation.getExtras(),
      channels: animation.listChannels().length,
      samplers: animation.listSamplers().length,
    })),
  });
}

export function assertOptimizationSnapshot(expected: string, document: Document, label: string): void {
  if (captureOptimizationSnapshot(document) !== expected) {
    throw new LODQualityError(
      "semantic-change",
      `${label} changed scene structure (nodes, materials, textures, extras, primitive boundaries, or animation bindings)`,
    );
  }
}

function assertSemanticSnapshot(expected: string, document: Document, level: number): void {
  const actual = captureSemanticSnapshot(document);
  if (actual !== expected) {
    throw new LODQualityError(
      "semantic-change",
      `LOD${level} changed scene semantics (nodes, materials, textures, extras, primitive boundaries, or transforms)`,
    );
  }
}

function semanticPrimitiveMode(mode: number): string {
  if (isTriangleMode(mode)) return "triangles";
  return String(mode);
}

function isTriangleMode(mode: number): boolean {
  return mode === Primitive.Mode.TRIANGLES || mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN;
}

function stableJSONStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJSONStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSONStringify(record[key])}`)
    .join(",")}}`;
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
