import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { copyFileChecked, pathExists, readJSON, resolveExistingSafe, sha256File } from "./fs-utils.js";
import { includeManagement, loadResourceGraph } from "./resource-graph.js";
import { prototypeHasPartFeatures } from "./glb.js";
import type { BuildManifest, InputSnapshot, PrototypeManifestEntry } from "./types.js";

export async function loadInputSnapshot(inputRoot: string): Promise<InputSnapshot> {
  const root = resolve(inputRoot);
  const manifestPath = await resolveExistingSafe(root, "_build/build-manifest.json");
  const build = await readJSON<BuildManifest>(manifestPath);
  if (build.schema !== "model-optimizer.lod-input" || build.version !== 1 || !build.sceneId || !build.sourceHash) {
    throw new Error("input must contain model-optimizer.lod-input v1 _build/build-manifest.json");
  }
  if (await pathExists(resolve(root, "optimization-manifest.json"))) throw new Error("LOD input must conform to the input specification and contain unoptimized base assets");
  for (const field of [build.prototypeManifest, build.instanceManifest, build.objectIndex, build.layout]) await resolveExistingSafe(root, field);
  if (!Array.isArray(build.files) || !build.files.length) throw new Error("build manifest must contain file hashes");
  const graph = await loadResourceGraph(root);
  await includeManagement(graph);
  const files = new Set<string>();
  for (const file of build.files) {
    if (!file.path || files.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid or duplicate build file record");
    files.add(file.path);
    const absolute = await resolveExistingSafe(root, file.path);
    if (await sha256File(absolute) !== file.sha256) throw new Error(`build file hash mismatch: ${file.path}`);
  }
  for (const path of [...graph.files.keys(), build.prototypeManifest, build.instanceManifest, build.objectIndex, build.layout]) {
    if (!files.has(path)) throw new Error(`build manifest does not cover required file: ${path}`);
  }
  const prototypesPath = await resolveExistingSafe(root, build.prototypeManifest);
  const prototypes = await readJSON<PrototypeManifestEntry[]>(prototypesPath);
  if (!Array.isArray(prototypes) || !prototypes.length) throw new Error("prototype manifest must contain at least one prototype");
  const ids = new Set<string>();
  for (const prototype of prototypes) {
    if (!prototype.prototypeId || ids.has(prototype.prototypeId)) throw new Error("duplicate or empty prototype ID");
    ids.add(prototype.prototypeId);
    const expected = `_build/assets/prototypes/${prototype.assetKey}`;
    if (!prototype.assetKey || prototype.assetPath !== expected || prototype.baseGLB !== `${expected}.glb`) throw new Error(`invalid physical prototype path: ${prototype.prototypeId}`);
    await resolveExistingSafe(root, prototype.baseGLB);
    await prototypeHasPartFeatures(resolve(root, prototype.baseGLB));
    if (!files.has(prototype.baseGLB)) throw new Error(`build manifest does not cover prototype: ${prototype.baseGLB}`);
    if (prototype.contentSha256 && await sha256File(resolve(root, prototype.baseGLB)) !== prototype.contentSha256) throw new Error(`prototype base hash mismatch: ${prototype.prototypeId}`);
    if (!Array.isArray(prototype.lods) || prototype.lods.length) throw new Error("LOD prototype must contain only its base asset");
  }
  return { inputRoot: root, build, buildManifestHash: await sha256File(manifestPath), prototypesPath, prototypes, prototypeManifestHash: await sha256File(prototypesPath), toolchainLockHash: await sha256File(fileURLToPath(new URL("../toolchain.lock.json", import.meta.url))) };
}

export async function copyCanonicalScene(snapshot: InputSnapshot, outputRoot: string): Promise<void> {
  const files = new Set([...snapshot.build.files.map(file => file.path), "_build/build-manifest.json"]);
  for (const path of files) await copyFileChecked(await resolveExistingSafe(snapshot.inputRoot, path), resolve(outputRoot, path));
}
