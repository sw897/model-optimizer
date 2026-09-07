import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  copyFileChecked,
  copyTree,
  hashDirectory,
  pathExists,
  readJSON,
  resolveExistingSafe,
  resolveSafe,
  safeRelativePath,
  sha256File,
} from "./fs-utils.js";
import type { InputSnapshot, PrototypeManifestEntry, SceneManifest } from "./types.js";

const REQUIRED_FILES = [
  "scene.json",
  "source-manifest.json",
  "prototypes.json",
  "instances.jsonl",
  "object-index.json",
  "component-graph.json",
];

export async function loadInputSnapshot(inputRoot: string): Promise<InputSnapshot> {
  const root = resolve(inputRoot);
  for (const name of REQUIRED_FILES) {
    await requireFile(resolve(root, name), name);
  }

  const scene = await readJSON<SceneManifest>(resolve(root, "scene.json"));
  validateSceneManifest(scene);

  const exclusions = ["scene.json", "build-report.json", "lod-input-report.json", "runtime assembly-report.json", "merge-report.json", "optimization-report.json", "source-manifest.json"];
  if (typeof scene.reportPath === "string" && scene.reportPath && scene.reportPath !== "build-report.json") {
    exclusions.push(scene.reportPath);
  }
  const computedSceneHash = await hashDirectory(root, exclusions);
  if (computedSceneHash !== scene.sceneHash) {
    throw new Error(`input scene hash mismatch: manifest=${scene.sceneHash} actual=${computedSceneHash}`);
  }

  const prototypesPath = await resolveExistingSafe(root, scene.prototypeManifest || "prototypes.json");
  const prototypes = await readJSON<PrototypeManifestEntry[]>(prototypesPath);
  await validatePrototypes(root, prototypes);

  const prototypeManifestHash = await sha256File(prototypesPath);
  const toolchainLockPath = fileURLToPath(new URL("../toolchain.lock.json", import.meta.url));
  const toolchainLockHash = await sha256File(toolchainLockPath);

  return {
    inputRoot: root,
    scene,
    prototypesPath,
    prototypes,
    prototypeManifestHash,
    toolchainLockHash,
  };
}

export async function copyCanonicalScene(snapshot: InputSnapshot, outputRoot: string): Promise<void> {
  const inputRoot = snapshot.inputRoot;
  const files = new Set<string>([
    "scene.json",
    "source-manifest.json",
    "instances.jsonl",
    "object-index.json",
    "component-graph.json",
    snapshot.scene.prototypeManifest || "prototypes.json",
  ]);
  for (const relativePath of files) {
    const source = resolveSafe(inputRoot, relativePath);
    await copyFileChecked(source, resolveSafe(outputRoot, relativePath));
  }

  for (const directory of ["assets", "pages", "objects"]) {
    const source = resolve(inputRoot, directory);
    if (await pathExists(source)) await copyTree(source, resolve(outputRoot, directory));
  }

  // Copy any referenced page or prototype asset that does not live below the
  // conventional directory.  The path check keeps the stage-2 output closed
  // over the canonical input root.
  for (const page of snapshot.scene.pages) {
    if (!page || typeof page !== "object") continue;
    const candidate = (page as { path?: unknown }).path;
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    await copyReferencedFile(inputRoot, outputRoot, candidate);
  }
  for (const prototype of snapshot.prototypes) {
    await copyReferencedFile(inputRoot, outputRoot, prototype.baseGLB);
    for (const lod of prototype.lods ?? []) {
      if (lod.level > 0) await copyReferencedFile(inputRoot, outputRoot, lod.path);
    }
  }
}

async function copyReferencedFile(inputRoot: string, outputRoot: string, candidate: string): Promise<void> {
  const relativePath = safeRelativePath(inputRoot, candidate);
  await resolveExistingSafe(inputRoot, relativePath);
  const source = resolve(inputRoot, relativePath);
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`referenced asset is not a file: ${candidate}`);
  const destination = resolve(outputRoot, relativePath);
  if (!(await pathExists(destination))) await copyFileChecked(source, destination);
}

function validateSceneManifest(scene: SceneManifest): void {
  if (scene.schema !== "model-optimizer.model-scene" || scene.version !== 2) {
    throw new Error("input scene.json must use model-optimizer.model-scene v2");
  }
  if (scene.buildStage !== "canonical") {
    throw new Error(`input scene.json buildStage must be canonical, got ${scene.buildStage || "<empty>"}`);
  }
  if (!scene.sceneHash || typeof scene.sceneHash !== "string") {
    throw new Error("input scene.json must contain sceneHash");
  }
  if (scene.lodLevels !== 0) {
    throw new Error(`input canonical scene must contain only base assets, got lodLevels=${scene.lodLevels}`);
  }
  if (!scene.prototypeManifest || !scene.instanceManifest || !scene.objectIndex) {
    throw new Error("input scene.json must reference prototype, instance and object manifests");
  }
  if (!Array.isArray(scene.pages)) throw new Error("input scene.json pages must be an array");
}

async function validatePrototypes(root: string, prototypes: PrototypeManifestEntry[]): Promise<void> {
  if (!Array.isArray(prototypes) || prototypes.length === 0) {
    throw new Error("input prototypes.json must contain at least one prototype");
  }
  const seen = new Set<string>();
  for (const prototype of prototypes) {
    if (!prototype || typeof prototype !== "object") throw new Error("input prototypes.json contains an invalid entry");
    if (!prototype.prototypeId || seen.has(prototype.prototypeId)) {
      throw new Error(`input prototypes.json contains duplicate or empty prototype id: ${prototype.prototypeId || "<empty>"}`);
    }
    seen.add(prototype.prototypeId);
    if (!prototype.name || !prototype.assetKey || !prototype.assetPath || !prototype.sourcePath || !prototype.role) {
      throw new Error(`prototype ${prototype.prototypeId} must contain name, assetKey, assetPath, sourcePath and role`);
    }
    const expectedAssetPath = `assets/prototypes/${prototype.assetKey}`;
    if (prototype.assetPath !== expectedAssetPath) {
      throw new Error(`prototype ${prototype.prototypeId} assetPath must be ${expectedAssetPath}`);
    }
    const baseName = prototype.assetPath.split("/").at(-1);
    const baseParent = prototype.assetPath.slice(0, prototype.assetPath.lastIndexOf("/"));
    const expectedBase = `${baseParent}/${baseName}.glb`;
    if (prototype.baseGLB !== expectedBase) {
      throw new Error(`prototype ${prototype.prototypeId} baseGLB must be ${expectedBase}`);
    }
    const basePath = await resolveExistingSafe(root, prototype.baseGLB);
    if (!prototype.baseGLB.toLowerCase().endsWith(".glb")) {
      throw new Error(`prototype ${prototype.prototypeId} baseGLB must be a .glb file`);
    }
    if (!Array.isArray(prototype.lods)) {
      throw new Error(`prototype ${prototype.prototypeId} must declare a lods array`);
    }
    for (const lod of prototype.lods) {
      if (!Number.isInteger(lod.level) || lod.level <= 0) {
        throw new Error(`prototype ${prototype.prototypeId} LOD level must be greater than zero`);
      }
      const expectedLODPath = `${prototype.assetPath}/lod${lod.level}.glb`;
      if (lod.path !== expectedLODPath) {
        throw new Error(`prototype ${prototype.prototypeId} LOD${lod.level} path must be ${expectedLODPath}`);
      }
    }
    void basePath;
  }
}

async function requireFile(path: string, name: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`input scene is missing ${name}`);
}

export async function ensureOutputParent(outputRoot: string): Promise<void> {
  await mkdir(dirname(resolve(outputRoot)), { recursive: true });
}
