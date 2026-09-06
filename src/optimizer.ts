import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { assertDifferentRoots, copyTree, createTemporarySibling, commitDirectory, ensureDirectoryEmpty, fileSize, hashDirectory, pathExists, readJSON, removeIfExists, resolveExistingSafe, resolveSafe, safeRelativePath, sha256File, writeAtomic, writeJSONAtomic } from "./fs-utils.js";
import { dirname, join, resolve, sep } from "node:path";
import { arch, platform, tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import type { Document, Texture } from "@gltf-transform/core";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import {
  assertOptimizationSnapshot,
  captureOptimizationSnapshot,
  createDecodeIO,
  readGLB,
  validateGLBBytes,
} from "./glb.js";
import type {
  OptimizationAsset,
  OptimizationCLIOptions,
  OptimizationManifest,
  OptimizationManifestPrototype,
  OptimizationReport,
  OptimizationReportAsset,
  OptimizationToolchain,
  PrototypeLOD,
  PrototypeManifestEntry,
  SceneManifest,
} from "./types.js";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

export const OPTIMIZER_VERSION = "0.2.0";
export const OPTIMIZATION_PROFILE = "web-v1" as const;
const TOOLCHAIN_NAME = "meshoptimizer-gltf-transform-basisu";
const BASISU_VERSION = "1.16.3";
const SCENE_HASH_EXCLUSIONS = ["scene.json", "build-report.json", "merge-report.json", "source-manifest.json"];

interface OptimizationSnapshot {
  root: string;
  scene: SceneManifest;
  prototypePath: string;
  prototypes: PrototypeManifestEntry[];
  prototypeManifestHash: string;
}

interface OptimizedGLB {
  sourceSha256: string;
  outputSha256: string;
  sourceBytes: number;
  outputBytes: number;
  geometryCompression: "meshopt" | "none";
  textureCompression: "ktx2" | "none";
  textureCount: number;
  compressedTextureCount: number;
}

interface TextureUsage {
  nonColor: boolean;
  normal: boolean;
}

export async function runOptimizer(options: OptimizationCLIOptions): Promise<OptimizationReport> {
  const inputRoot = resolve(options.input);
  const outputRoot = resolve(options.output);
  assertDifferentRoots(inputRoot, outputRoot);
  const snapshot = await loadOptimizationSnapshot(inputRoot);
  if (snapshot.scene.optimizationManifest) {
    throw new Error("input scene already contains optimizationManifest; run model-opt-worker from the raw runtime assembly output");
  }
  if (snapshot.scene.geometryCompression && snapshot.scene.geometryCompression !== "none") {
    throw new Error("input scene already declares geometry compression; run model-opt-worker from an unoptimized scene");
  }
  if (snapshot.scene.textureCompression && snapshot.scene.textureCompression !== "none") {
    throw new Error("input scene already declares texture compression; run model-opt-worker from an unoptimized scene");
  }

  if (await pathExists(outputRoot)) {
    await ensureDirectoryEmpty(outputRoot);
    await removeIfExists(outputRoot);
  }
  const workRoot = await createTemporarySibling(outputRoot);
  const startedAt = new Date().toISOString();
  const optimizerBinarySha256 = await sha256File(fileURLToPath(import.meta.url));
  const toolchain: OptimizationToolchain = {
    name: TOOLCHAIN_NAME,
    version: `optimizer-${OPTIMIZER_VERSION}+@gltf-transform@4.5.0+meshoptimizer@1.2.0+basisu@${BASISU_VERSION}`,
    binarySha256: optimizerBinarySha256,
    basisuVersion: BASISU_VERSION,
  };
  const report: OptimizationReport = {
    schema: "model-optimizer.optimization-report",
    version: 1,
    status: "failed",
    profile: OPTIMIZATION_PROFILE,
    inputRoot,
    outputRoot,
    inputSceneHash: snapshot.scene.sceneHash,
    toolchain,
    startedAt,
    assets: [],
  };

  try {
    await copyTree(inputRoot, workRoot);
    await removeIfExists(join(workRoot, "optimization-manifest.json"));
    await removeIfExists(join(workRoot, "optimization-report.json"));
    await removeIfExists(join(workRoot, "optimization-toolchain.lock.json"));

    const io = await createDecodeIO();
    const outputPrototypes = structuredClone(snapshot.prototypes) as PrototypeManifestEntry[];
    const optimizedByPath = new Map<string, OptimizedGLB>();
    const reportByPath = new Map<string, OptimizationReportAsset>();
    let hasGeometryCompression = false;
    let textureCount = 0;
    let compressedTextureCount = 0;

    for (const prototype of outputPrototypes) {
      const canonicalPath = normalizeRelativePath(prototype.canonicalGLB);
      let canonical = optimizedByPath.get(canonicalPath);
      if (!canonical) {
        canonical = await optimizeAsset(snapshot.root, workRoot, canonicalPath, io, toolchain);
        optimizedByPath.set(canonicalPath, canonical);
        hasGeometryCompression ||= canonical.geometryCompression === "meshopt";
        textureCount += canonical.textureCount;
        compressedTextureCount += canonical.compressedTextureCount;
      }
      prototype.contentSha256 = canonical.outputSha256;

      for (const lod of prototype.lods ?? []) {
        const lodPath = normalizeRelativePath(lod.path);
        let optimized = optimizedByPath.get(lodPath);
        if (!optimized) {
          optimized = await optimizeAsset(snapshot.root, workRoot, lodPath, io, toolchain);
          optimizedByPath.set(lodPath, optimized);
          hasGeometryCompression ||= optimized.geometryCompression === "meshopt";
          textureCount += optimized.textureCount;
          compressedTextureCount += optimized.compressedTextureCount;
        }
        updateLODMetadata(lod, optimized, canonical.outputSha256);
        reportByPath.set(`${prototype.prototypeId}:${lod.level}`, {
          prototypeId: prototype.prototypeId,
          level: lod.level,
          path: lodPath,
          sourceSha256: optimized.sourceSha256,
          outputSha256: optimized.outputSha256,
          sourceBytes: optimized.sourceBytes,
          outputBytes: optimized.outputBytes,
          geometryCompression: optimized.geometryCompression,
          textureCompression: optimized.textureCompression,
          textureCount: optimized.textureCount,
          compressedTextureCount: optimized.compressedTextureCount,
        });
      }
    }

    const geometryCompression = hasGeometryCompression ? "meshopt" : "none";
    const textureCompression = textureCount > 0 && compressedTextureCount === textureCount ? "ktx2" : "none";
    if (textureCount > 0 && textureCompression !== "ktx2") {
      throw new Error(`web-v1 did not produce KTX2 for every texture (${compressedTextureCount}/${textureCount})`);
    }

    await writeJSONAtomic(resolveSafe(workRoot, snapshot.scene.prototypeManifest), outputPrototypes);
    await writeJSONAtomic(join(workRoot, "optimization-toolchain.lock.json"), {
      schema: "model-optimizer.optimization-toolchain",
      version: 1,
      package: "model-optimizer",
      packageVersion: OPTIMIZER_VERSION,
      profile: OPTIMIZATION_PROFILE,
      geometryCompression,
      textureCompression,
      toolchain,
    });

    const manifestPrototypes: OptimizationManifestPrototype[] = outputPrototypes.map((prototype) => ({
      prototypeId: prototype.prototypeId,
      assets: (prototype.lods ?? []).map((lod) => {
        const asset = reportByPath.get(`${prototype.prototypeId}:${lod.level}`);
        if (!asset) throw new Error(`missing optimization record for ${prototype.prototypeId} LOD${lod.level}`);
        return toOptimizationAsset(asset);
      }),
    }));
    const optimizationManifest: OptimizationManifest = {
      schema: "model-optimizer.optimization-manifest",
      version: 1,
      profile: OPTIMIZATION_PROFILE,
      inputSceneHash: snapshot.scene.sceneHash,
      inputPrototypeManifestHash: snapshot.prototypeManifestHash,
      geometryCompression,
      textureCompression,
      toolchain,
      prototypes: manifestPrototypes,
    };
    await writeJSONAtomic(join(workRoot, "optimization-manifest.json"), optimizationManifest);

    const scene = { ...snapshot.scene } as SceneManifest & Record<string, unknown>;
    scene.sceneHash = "";
    scene.geometryCompression = geometryCompression;
    scene.textureCompression = textureCompression;
    scene.optimizationManifest = "optimization-manifest.json";
    scene.reportPath = "optimization-report.json";
    await writeJSONAtomic(join(workRoot, "scene.json"), scene);
    scene.sceneHash = await hashScene(workRoot, scene.reportPath);
    await writeJSONAtomic(join(workRoot, "scene.json"), scene);

    report.assets = [...reportByPath.values()].sort((left, right) => {
      const byPrototype = left.prototypeId.localeCompare(right.prototypeId);
      return byPrototype || left.level - right.level;
    });
    report.outputSceneHash = scene.sceneHash;
    report.status = "succeeded";
    report.finishedAt = new Date().toISOString();
    await writeJSONAtomic(join(workRoot, "optimization-report.json"), report);
    await validateOutput(workRoot, scene);
    await commitDirectory(workRoot, outputRoot);
    return report;
  } catch (error) {
    report.errors = [error instanceof Error ? error.message : String(error)];
    report.finishedAt = new Date().toISOString();
    await removeIfExists(workRoot);
    throw Object.assign(new Error(report.errors[0]), { report });
  }
}

async function optimizeAsset(
  inputRoot: string,
  outputRoot: string,
  relativePath: string,
  io: Awaited<ReturnType<typeof createDecodeIO>>,
  toolchain: OptimizationToolchain,
): Promise<OptimizedGLB> {
  const inputPath = await resolveExistingSafe(inputRoot, relativePath);
  const outputPath = resolve(outputRoot, relativePath);
  const sourceSha256 = await sha256File(inputPath);
  const sourceBytes = await fileSize(inputPath);
  const document = await readGLB(inputPath, io);
  const semanticSnapshot = captureOptimizationSnapshot(document);
  try {
    await MeshoptEncoder.ready;
    document.disposeExtension("KHR_draco_mesh_compression");
    const textureStats = await compressTextures(document, toolchain);
    await document.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
    assertOptimizationSnapshot(semanticSnapshot, document, relativePath);
    const bytes = await io.writeBinary(document);
    const decoded = await validateGLBBytes(bytes, io, relativePath);
    try {
      assertOptimizationSnapshot(semanticSnapshot, decoded, relativePath);
    } finally {
      decoded.getRoot().dispose();
    }
    await writeAtomic(outputPath, bytes);
    const outputSha256 = await sha256File(outputPath);
    const geometryCompression = document.hasExtension("EXT_meshopt_compression") ? "meshopt" : "none";
    const textureCompression = textureStats.textureCount > 0 && textureStats.compressedTextureCount === textureStats.textureCount ? "ktx2" : "none";
    return {
      sourceSha256,
      outputSha256,
      sourceBytes,
      outputBytes: bytes.byteLength,
      geometryCompression,
      textureCompression,
      textureCount: textureStats.textureCount,
      compressedTextureCount: textureStats.compressedTextureCount,
    };
  } finally {
    document.getRoot().dispose();
  }
}

async function compressTextures(document: Document, toolchain: OptimizationToolchain): Promise<{ textureCount: number; compressedTextureCount: number }> {
  const textures = document.getRoot().listTextures();
  const usages = collectTextureUsages(document);
  let textureCount = 0;
  let compressedTextureCount = 0;
  let basisuPath: string | undefined;
  for (const texture of textures) {
    const image = texture.getImage();
    if (!image) continue;
    textureCount += 1;
    const mimeType = texture.getMimeType().toLowerCase();
    if (mimeType === "image/ktx2") {
      compressedTextureCount += 1;
      continue;
    }
    basisuPath ??= await findBasisuBinary();
    toolchain.basisuBinarySha256 ??= await sha256File(basisuPath);
    const usage = usages.get(texture) ?? { nonColor: false, normal: false };
    const ktx2 = await encodeKTX2(Buffer.from(image), usage, basisuPath);
    texture.setImage(ktx2).setMimeType("image/ktx2").setURI("");
    compressedTextureCount += 1;
  }
  if (compressedTextureCount > 0) document.createExtension(KHRTextureBasisu).setRequired(true);
  return { textureCount, compressedTextureCount };
}

function collectTextureUsages(document: Document): Map<Texture, TextureUsage> {
  const usages = new Map<Texture, TextureUsage>();
  const note = (texture: Texture | null, nonColor: boolean, normal = false): void => {
    if (!texture) return;
    const usage = usages.get(texture) ?? { nonColor: false, normal: false };
    usage.nonColor ||= nonColor;
    usage.normal ||= normal;
    usages.set(texture, usage);
  };
  for (const material of document.getRoot().listMaterials()) {
    note(material.getBaseColorTexture(), false);
    note(material.getEmissiveTexture(), false);
    note(material.getNormalTexture(), true, true);
    note(material.getOcclusionTexture(), true);
    note(material.getMetallicRoughnessTexture(), true);
  }
  return usages;
}

async function encodeKTX2(image: Buffer, usage: TextureUsage, basisuPath: string): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), "model-optimizer-texture-"));
  const inputPath = join(root, "input.png");
  const outputPath = join(root, "output.ktx2");
  try {
    const png = await sharp(image).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    await writeFile(inputPath, png);
    const args = ["-ktx2", "-mipmap", "-output_file", outputPath, "-file", inputPath];
    if (usage.nonColor) {
      args.push("-uastc", "-uastc_level", "2", "-linear");
      if (usage.normal) args.push("-normal_map");
    } else {
      args.push("-q", "192", "-comp_level", "2");
    }
    await execFile(basisuPath, args, { maxBuffer: 4 * 1024 * 1024 });
    const info = await stat(outputPath);
    if (!info.isFile() || info.size === 0) throw new Error("BasisU produced an empty KTX2 file");
    return new Uint8Array(await readFile(outputPath));
  } catch (error) {
    throw new Error(`KTX2 encoding failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findBasisuBinary(): Promise<string> {
  const packageRoot = dirname(require.resolve("basisu/package.json"));
  const platformName = platform() === "win32" ? "win" : platform();
  const extension = platformName === "win" ? ".exe" : "";
  const candidates = [
    `${arch()}_sse`,
    arch(),
  ];
  for (const directory of candidates) {
    const candidate = join(packageRoot, "bin", platformName, directory, `basisu${extension}`);
    if (await pathExists(candidate)) {
      if (platformName !== "win") await chmod(candidate, 0o755);
      return candidate;
    }
  }
  throw new Error(`BasisU ${BASISU_VERSION} does not provide a binary for ${platform()} ${arch()}`);
}

function updateLODMetadata(lod: PrototypeLOD, optimized: OptimizedGLB, canonicalOutputSha256: string): void {
  lod.sha256 = optimized.outputSha256;
  lod.inputSha256 = canonicalOutputSha256;
}

function toOptimizationAsset(asset: OptimizationReportAsset): OptimizationAsset {
  const { prototypeId: _prototypeId, ...result } = asset;
  return result;
}

async function loadOptimizationSnapshot(root: string): Promise<OptimizationSnapshot> {
  const absoluteRoot = resolve(root);
  const scenePath = join(absoluteRoot, "scene.json");
  const scene = await readJSON<SceneManifest>(scenePath);
  if (scene.schema !== "model-optimizer.model-scene" || scene.version !== 1) throw new Error("input scene.json must use model-optimizer.model-scene v1");
  if (scene.buildStage !== "published") throw new Error(`model-opt-worker input buildStage must be published, got ${scene.buildStage || "<empty>"}`);
  if (!scene.sceneHash) throw new Error("input scene.json must contain sceneHash");
  if (!Number.isSafeInteger(scene.lodLevels) || scene.lodLevels < 0) throw new Error("input scene.json lodLevels must be a non-negative integer");
  if (!Array.isArray(scene.pages)) throw new Error("input scene.json pages must be an array");
  const exclusions = [...SCENE_HASH_EXCLUSIONS];
  if (scene.reportPath) exclusions.push(scene.reportPath);
  const computedHash = await hashDirectory(absoluteRoot, exclusions);
  if (computedHash !== scene.sceneHash) throw new Error(`input scene hash mismatch: manifest=${scene.sceneHash} actual=${computedHash}`);
  const prototypePath = safeRelativePath(absoluteRoot, scene.prototypeManifest || "prototypes.json");
  const prototypes = await readJSON<PrototypeManifestEntry[]>(resolve(absoluteRoot, prototypePath));
  if (!Array.isArray(prototypes) || prototypes.length === 0) throw new Error("input prototypes.json must contain at least one prototype");
  for (const manifest of [scene.instanceManifest, scene.objectIndex]) {
    const manifestPath = await resolveExistingSafe(absoluteRoot, manifest);
    if (!(await stat(manifestPath)).isFile()) throw new Error(`input scene manifest is not a file: ${manifest}`);
  }
  const seen = new Set<string>();
  for (const prototype of prototypes) {
    if (!prototype.prototypeId || seen.has(prototype.prototypeId)) throw new Error(`duplicate or empty prototype id ${prototype.prototypeId || "<empty>"}`);
    seen.add(prototype.prototypeId);
    if (!prototype.name || !prototype.assetKey || !prototype.assetPath || !prototype.sourcePath || !prototype.role) {
      throw new Error(`prototype ${prototype.prototypeId} must contain name, assetKey, assetPath, sourcePath and role`);
    }
    const expectedAssetPath = `assets/prototypes/${prototype.assetKey}`;
    if (prototype.assetPath !== expectedAssetPath) {
      throw new Error(`prototype ${prototype.prototypeId} assetPath must be ${expectedAssetPath}`);
    }
    const canonicalPath = normalizeRelativePath(prototype.canonicalGLB);
    if (canonicalPath !== `${prototype.assetPath}/lod0.glb`) {
      throw new Error(`prototype ${prototype.prototypeId} canonicalGLB must be ${prototype.assetPath}/lod0.glb`);
    }
    await requireGLB(absoluteRoot, canonicalPath, `prototype ${prototype.prototypeId} canonicalGLB`);
    if (!Array.isArray(prototype.lods)) throw new Error(`prototype ${prototype.prototypeId} must declare a lods array`);
    const lods = prototype.lods;
    if (!lods.some((lod) => lod.level === 0 && normalizeRelativePath(lod.path) === canonicalPath)) {
      throw new Error(`prototype ${prototype.prototypeId} must declare canonicalGLB as LOD0`);
    }
    const canonicalHash = await sha256File(resolve(absoluteRoot, canonicalPath));
    if (prototype.contentSha256 && canonicalHash !== prototype.contentSha256) {
      throw new Error(`prototype ${prototype.prototypeId} canonical hash mismatch`);
    }
    const levels = new Set<number>();
    let highestLevel = -1;
    for (const lod of lods) {
      if (!Number.isInteger(lod.level) || lod.level < 0 || levels.has(lod.level)) throw new Error(`prototype ${prototype.prototypeId} contains invalid or duplicate LOD ${lod.level}`);
      levels.add(lod.level);
      highestLevel = Math.max(highestLevel, lod.level);
      if (!Number.isFinite(lod.geometricErrorMeters) || lod.geometricErrorMeters < 0) {
        throw new Error(`prototype ${prototype.prototypeId} LOD${lod.level} has invalid geometric error`);
      }
      const lodPath = normalizeRelativePath(lod.path);
      const expectedLODPath = `${prototype.assetPath}/lod${lod.level}.glb`;
      if (lodPath !== expectedLODPath) {
        throw new Error(`prototype ${prototype.prototypeId} LOD${lod.level} path must be ${expectedLODPath}`);
      }
      await requireGLB(absoluteRoot, lodPath, `prototype ${prototype.prototypeId} LOD${lod.level}`);
      if (lod.sha256) {
        const actual = await sha256File(resolve(absoluteRoot, lodPath));
        if (actual !== lod.sha256) throw new Error(`prototype ${prototype.prototypeId} LOD${lod.level} hash mismatch`);
      }
      if (lod.inputSha256 && lod.inputSha256 !== canonicalHash) {
        throw new Error(`prototype ${prototype.prototypeId} LOD${lod.level} input hash mismatch`);
      }
      if (lod.level > 0) {
        const method = typeof lod.method === "string" ? lod.method.trim().toLowerCase() : "";
        if (!method || method === "identity" || method === "canonical") {
          throw new Error(`prototype ${prototype.prototypeId} LOD${lod.level} does not identify a real simplifier output`);
        }
      }
    }
    const orderedLODs = [...lods].sort((left, right) => left.level - right.level);
    let previousError = 0;
    for (const lod of orderedLODs) {
      if (lod.level === 0 && lod.geometricErrorMeters !== 0) {
        throw new Error(`prototype ${prototype.prototypeId} LOD0 must have zero geometric error`);
      }
      if (lod.geometricErrorMeters < previousError) {
        throw new Error(`prototype ${prototype.prototypeId} LOD errors are not monotonic at level ${lod.level}`);
      }
      previousError = lod.geometricErrorMeters;
    }
    for (let level = 0; level <= scene.lodLevels; level += 1) {
      if (!levels.has(level)) throw new Error(`prototype ${prototype.prototypeId} is missing LOD${level}`);
    }
    if (highestLevel !== scene.lodLevels) {
      throw new Error(`prototype ${prototype.prototypeId} LOD level mismatch: scene=${scene.lodLevels} actual=${highestLevel}`);
    }
  }
  return {
    root: absoluteRoot,
    scene,
    prototypePath,
    prototypes,
    prototypeManifestHash: await sha256File(resolve(absoluteRoot, prototypePath)),
  };
}

async function validateOutput(root: string, scene: SceneManifest): Promise<void> {
  const computedHash = await hashScene(root, scene.reportPath);
  if (computedHash !== scene.sceneHash) throw new Error(`output scene hash mismatch: manifest=${scene.sceneHash} actual=${computedHash}`);
  const snapshot = await loadOptimizationSnapshot(root);
  if (snapshot.scene.sceneHash !== scene.sceneHash) throw new Error("output scene manifest changed during validation");
  const io = await createDecodeIO();
  for (const prototype of snapshot.prototypes) {
    for (const lod of prototype.lods ?? []) await validateGLB(resolve(root, normalizeRelativePath(lod.path)), io);
  }
}

async function validateGLB(path: string, io: Awaited<ReturnType<typeof createDecodeIO>>): Promise<void> {
  const document = await readGLB(path, io);
  document.getRoot().dispose();
}

async function requireGLB(root: string, relativePath: string, label: string): Promise<void> {
  const path = await resolveExistingSafe(root, relativePath);
  const info = await stat(path);
  if (!info.isFile() || info.size < 4) throw new Error(`${label} is missing or empty`);
  const header = await readFile(path, { encoding: null });
  if (header.subarray(0, 4).toString("ascii") !== "glTF") throw new Error(`${label} is not a GLB`);
}

async function hashScene(root: string, reportPath?: string): Promise<string> {
  const exclusions = [...SCENE_HASH_EXCLUSIONS];
  if (reportPath) exclusions.push(reportPath);
  return hashDirectory(root, exclusions);
}

function normalizeRelativePath(value: string): string {
  return safeRelativePath(resolve("."), value).split(sep).join("/");
}
