import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDifferentRoots,
  commitDirectory,
  ensureDirectoryEmpty,
  fileSize,
  pathExists,
  readJSON,
  removeIfExists,
  resolveSafe,
  safeRelativePath,
  sha256Buffer,
  sha256File,
  writeJSON,
  writeJSONAtomic,
} from "./fs-utils.js";
import { inspectGLB, LODQualityError, simplifyGLB, validateGLB } from "./glb.js";
import { getPreset } from "./presets.js";
import { copyCanonicalScene, loadInputSnapshot } from "./protocol.js";
import type {
  CLIOptions,
  InputSnapshot,
  LODManifest,
  LevelReport,
  Preset,
  PrototypeLOD,
  PrototypeManifestEntry,
  PrototypeReport,
  WorkerState,
  WorkerReport,
} from "./types.js";

const WORKER_VERSION = "0.2.0";
const TOOLCHAIN_NAME = "meshoptimizer-gltf-transform";
const TOOLCHAIN_VERSION = `worker-${WORKER_VERSION}+@gltf-transform@4.5.0+draco3dgltf@1.5.7+meshoptimizer@1.2.0`;

export async function runWorker(options: CLIOptions): Promise<WorkerReport> {
  const inputRoot = resolve(options.input);
  const outputRoot = resolve(options.output);
  assertDifferentRoots(inputRoot, outputRoot);
  const preset = getPreset(options.preset);
  validateMaxLevel(options.maxLevel, preset);

  const snapshot = await loadInputSnapshot(inputRoot);
  await prepareOutputRoot(outputRoot);
  const workRoot = `${outputRoot}.stage2-work`;
  const jobKey = await makeJobKey(snapshot, preset, options.maxLevel);
  const workerBinarySha256 = await sha256File(fileURLToPath(import.meta.url));
  const state = await prepareWorkRoot(workRoot, options.resume, jobKey, snapshot, preset, options.maxLevel);
  const startedAt = new Date().toISOString();
  const toolchain = {
    name: TOOLCHAIN_NAME,
    version: TOOLCHAIN_VERSION,
    binarySha256: workerBinarySha256,
  };
  const report: WorkerReport = {
    schema: "model-optimizer.lod-worker-report",
    version: 2,
    status: "failed",
    inputRoot,
    outputRoot,
    baseSceneHash: snapshot.scene.sceneHash,
    basePrototypeManifestHash: snapshot.prototypeManifestHash,
    preset: preset.name,
    presetVersion: preset.version,
    maxLevel: options.maxLevel,
    toolchain,
    startedAt,
    prototypes: [],
  };
  const manifest: LODManifest = {
    schema: "model-optimizer.lod-manifest",
    version: 2,
    baseSceneHash: snapshot.scene.sceneHash,
    basePrototypeManifestHash: snapshot.prototypeManifestHash,
    toolchain,
    prototypes: [],
  };

  try {
    const prototypes = [...snapshot.prototypes].sort((left, right) => left.prototypeId.localeCompare(right.prototypeId));
    let fallbackReason: string | undefined;
    for (const prototype of prototypes) {
      const cached = state?.reports.find((item) => item.prototypeId === prototype.prototypeId);
      const cachedManifest = state?.manifestEntries.find((item) => item.prototypeId === prototype.prototypeId);
      let result: PrototypeResult;
      if (fallbackReason && preset.fallback === "base-only") {
        result = await processCanonicalPrototype(snapshot, prototype, fallbackReason);
      } else if (cached && cachedManifest && await isReusableResult(workRoot, cached, cachedManifest, options.maxLevel)) {
        result = { report: cached, manifest: cachedManifest };
      } else {
        try {
          result = await processPrototype(snapshot, workRoot, prototype, preset, options.maxLevel);
        } catch (error) {
          if (options.maxLevel > 0 && preset.fallback === "base-only" && error instanceof LODQualityError) {
            fallbackReason ??= `prototype ${prototype.prototypeId}: ${error.message}`;
            result = await processCanonicalPrototype(snapshot, prototype, `scene fallback: ${fallbackReason}`);
          } else {
            throw error;
          }
        }
      }
      report.prototypes.push(result.report);
      manifest.prototypes.push(result.manifest);
      await writeJSONAtomic(join(workRoot, "lod-worker-state.json"), {
        schema: "model-optimizer.lod-worker-state",
        version: 2,
        jobKey,
        baseSceneHash: snapshot.scene.sceneHash,
        basePrototypeManifestHash: snapshot.prototypeManifestHash,
        preset: preset.name,
        presetVersion: preset.version,
        maxLevel: options.maxLevel,
        toolchainHash: snapshot.toolchainLockHash,
        reports: report.prototypes,
        manifestEntries: manifest.prototypes,
      } satisfies WorkerState);
    }

	if (fallbackReason && preset.fallback === "base-only") {
		await downgradeReportToBaseOnly(workRoot, report, manifest, `scene fallback: ${fallbackReason}`);
    }

    const failures = report.prototypes.filter((item) => item.status === "failed");
    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `${failure.prototypeId}: ${failure.reason ?? "failed"}`).join("; "));
    }
    if (!fallbackReason && options.maxLevel > 0 && report.prototypes.some((item) => item.lods.length < options.maxLevel)) {
      throw new Error("requested LOD levels are not available for every prototype; use a compatible preset or max-level 0");
    }

    await writeJSON(join(workRoot, "lod-manifest.json"), manifest);
    report.status = "succeeded";
    report.finishedAt = new Date().toISOString();
    await writeReport(workRoot, options.report, report);
    await removeIfExists(join(workRoot, "lod-worker-state.json"));
    await commitDirectory(workRoot, outputRoot);
    return report;
  } catch (error) {
    report.errors = [error instanceof Error ? error.message : String(error)];
    report.finishedAt = new Date().toISOString();
    if (await pathExists(workRoot)) {
      await writeJSONAtomic(join(workRoot, "lod-worker-report.json"), report).catch(() => undefined);
    }
    throw Object.assign(new Error(report.errors[0]), { report });
  }
}

interface PrototypeResult {
  report: PrototypeReport;
  manifest: {
    prototypeId: string;
    baseSha256: string;
    lods: PrototypeLOD[];
  };
}

async function makeJobKey(snapshot: InputSnapshot, preset: Preset, maxLevel: number): Promise<string> {
  const presetHash = await sha256Buffer(Buffer.from(JSON.stringify(preset), "utf8"));
  return sha256Buffer(
    Buffer.from(
      [snapshot.scene.sceneHash, snapshot.prototypeManifestHash, preset.name, String(preset.version), presetHash, String(maxLevel), snapshot.toolchainLockHash].join("\n"),
      "utf8",
    ),
  );
}

async function prepareWorkRoot(
  workRoot: string,
  resume: boolean,
  jobKey: string,
  snapshot: InputSnapshot,
  preset: Preset,
  maxLevel: number,
): Promise<WorkerState | undefined> {
  let state: WorkerState | undefined;
  if (await pathExists(workRoot)) {
    if (resume) {
      try {
        state = await readJSON<WorkerState>(join(workRoot, "lod-worker-state.json"));
        if (
          state.schema !== "model-optimizer.lod-worker-state" ||
          state.version !== 2 ||
          state.jobKey !== jobKey ||
          state.baseSceneHash !== snapshot.scene.sceneHash ||
          state.basePrototypeManifestHash !== snapshot.prototypeManifestHash ||
          state.preset !== preset.name ||
          state.presetVersion !== preset.version ||
          state.maxLevel !== maxLevel ||
          !(await pathExists(join(workRoot, "scene.json")))
        ) {
          state = undefined;
        }
      } catch {
        state = undefined;
      }
    }
    if (!state) await removeIfExists(workRoot);
  }
  if (!state) {
    await mkdir(workRoot, { recursive: true });
    await copyCanonicalScene(snapshot, workRoot);
    await copyToolchainLock(workRoot);
  }
  return state;
}

async function isReusableResult(
  workRoot: string,
  report: PrototypeReport,
  manifest: { prototypeId: string; baseSha256: string; lods: PrototypeLOD[] },
  maxLevel: number,
): Promise<boolean> {
  if (report.baseSha256 !== manifest.baseSha256) return false;
  const basePath = resolveSafe(workRoot, report.baseGLB);
  if ((await sha256File(basePath).catch(() => "")) !== report.baseSha256) return false;
  if (maxLevel === 0) return report.status === "base-only" && report.lods.length === 0;
  if (report.status !== "succeeded" || report.lods.length < maxLevel || manifest.lods.length < maxLevel) return false;
  for (let level = 1; level <= maxLevel; level += 1) {
    const reportLOD = report.lods.find((item) => item.level === level);
    const manifestLOD = manifest.lods.find((item) => item.level === level);
    if (!reportLOD || !manifestLOD || reportLOD.path !== manifestLOD.path || !manifestLOD.sha256) return false;
    const assetPath = resolveSafe(workRoot, manifestLOD.path);
    if ((await sha256File(assetPath).catch(() => "")) !== manifestLOD.sha256) return false;
    try {
      await validateGLB(assetPath);
    } catch {
      return false;
    }
  }
  return true;
}

async function processPrototype(
  snapshot: InputSnapshot,
  outputRoot: string,
  prototype: PrototypeManifestEntry,
  preset: Preset,
  maxLevel: number,
): Promise<PrototypeResult> {
  const baseRelative = safeRelativePath(snapshot.inputRoot, prototype.baseGLB);
  const baseInput = resolve(snapshot.inputRoot, baseRelative);
  const baseOutput = resolve(outputRoot, baseRelative);
  if (maxLevel === 0) {
    return processCanonicalPrototype(snapshot, prototype, "compliance-only");
  }

  const levels = preset.levels.filter((level) => level.level <= maxLevel);
  const outputDirectory = join(dirname(baseOutput), basename(baseRelative, ".glb"));
  const result = await simplifyGLB(
    baseInput,
    (level) => join(outputDirectory, `lod${level}.glb`),
    levels,
  );
  const baseSha256 = result.sourceHash;
  const lods = result.levels.map((level) => ({
    ...level,
    path: toManifestPath(outputRoot, level.path),
    inputSha256: baseSha256,
    method: "meshopt-simplify",
    tool: "meshoptimizer",
    toolVersion: "1.2.0",
  }));
  ensureMonotonicErrors(lods, prototype.prototypeId);
  return {
    report: {
      prototypeId: prototype.prototypeId,
      baseGLB: baseRelative,
      baseSha256: result.sourceHash,
      baseBytes: result.sourceBytes,
      stats: result.sourceStats,
      lods,
      status: "succeeded",
    },
    manifest: {
      prototypeId: prototype.prototypeId,
      baseSha256,
      lods: lods.map(toManifestLOD),
    },
  };
}

async function processCanonicalPrototype(
  snapshot: InputSnapshot,
  prototype: PrototypeManifestEntry,
  reason: string,
): Promise<PrototypeResult> {
  const baseRelative = safeRelativePath(snapshot.inputRoot, prototype.baseGLB);
  const baseInput = resolve(snapshot.inputRoot, baseRelative);
  const sourceStats = await inspectGLB(baseInput);
  const baseSha256 = await sha256File(baseInput);
  const baseBytes = await fileSize(baseInput);
  return {
    report: {
      prototypeId: prototype.prototypeId,
      baseGLB: baseRelative,
      baseSha256,
      baseBytes,
      stats: sourceStats,
      lods: [],
      status: "base-only",
      reason,
    },
    manifest: { prototypeId: prototype.prototypeId, baseSha256, lods: [] },
  };
}

async function downgradeReportToBaseOnly(
  workRoot: string,
  report: WorkerReport,
  manifest: LODManifest,
  reason: string,
): Promise<void> {
  const generatedPaths = new Set(report.prototypes.flatMap((prototype) => prototype.lods.map((lod) => lod.path)));
  for (const path of generatedPaths) await removeIfExists(resolveSafe(workRoot, path));
  for (const prototype of report.prototypes) {
    prototype.status = "base-only";
    prototype.lods = [];
    prototype.reason = reason;
  }
  for (const prototype of manifest.prototypes) prototype.lods = [];
}

function toManifestLOD(level: LevelReport): PrototypeLOD {
  const manifest: PrototypeLOD = {
    level: level.level,
    path: level.path,
    geometricErrorMeters: level.geometricErrorMeters,
    method: level.method,
    sha256: level.sha256,
  };
  if (level.inputSha256) manifest.inputSha256 = level.inputSha256;
  if (level.tool) manifest.tool = level.tool;
  if (level.toolVersion) manifest.toolVersion = level.toolVersion;
  return manifest;
}

function validateMaxLevel(maxLevel: number, preset: Preset): void {
  if (!Number.isInteger(maxLevel) || maxLevel < 0) throw new Error("max-level must be a non-negative integer");
  const highest = preset.levels.at(-1)?.level ?? 0;
  if (maxLevel > highest) {
    throw new Error(`preset ${preset.name} supports levels 0..${highest}, requested ${maxLevel}`);
  }
}

function ensureMonotonicErrors(lods: LevelReport[], prototypeId: string): void {
  let previous = 0;
  for (const lod of lods) {
    if (!Number.isFinite(lod.geometricErrorMeters) || lod.geometricErrorMeters < 0) {
      throw new Error(`prototype ${prototypeId} LOD error is not monotonic at level ${lod.level}`);
    }
    // A measured simplifier error may fluctuate slightly between independent
    // levels. Publish the conservative monotonic envelope required by the
    // scene contract instead of rejecting an otherwise valid LOD asset.
    lod.geometricErrorMeters = Math.max(previous, lod.geometricErrorMeters);
    previous = lod.geometricErrorMeters;
  }
}

function toManifestPath(outputRoot: string, assetPath: string): string {
  return relative(outputRoot, assetPath).split("\\").join("/");
}

async function prepareOutputRoot(outputRoot: string): Promise<void> {
  if (await pathExists(outputRoot)) {
    await ensureDirectoryEmpty(outputRoot);
    await removeIfExists(outputRoot);
  }
  await mkdir(dirname(outputRoot), { recursive: true });
}

async function copyToolchainLock(outputRoot: string): Promise<void> {
  const source = fileURLToPath(new URL("../toolchain.lock.json", import.meta.url));
  await mkdir(outputRoot, { recursive: true });
  await copyFile(source, join(outputRoot, "toolchain.lock.json"));
}

async function writeReport(outputRoot: string, requestedPath: string | undefined, report: WorkerReport): Promise<void> {
  const relativeReport = requestedPath ?? "lod-worker-report.json";
  if (relativeReport.startsWith("/") || relativeReport.includes("..")) {
    throw new Error("report path must be relative to the output directory");
  }
  const safeReport = safeRelativePath(outputRoot, relativeReport);
  await writeJSON(resolve(outputRoot, safeReport), report);
}
