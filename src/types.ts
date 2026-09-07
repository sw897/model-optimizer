export interface BuildManifest {
  schema: "model-optimizer.lod-input";
  version: 1;
  sceneId: string;
  sourceHash: string;
  prototypeManifest: string;
  instanceManifest: string;
  objectIndex: string;
  layout: string;
  files: Array<{path: string; sha256: string}>;
}

export interface PrototypeLOD {
  level: number;
  path: string;
  geometricErrorMeters: number;
  method: string;
  sha256?: string;
  tool?: string;
  toolVersion?: string;
  inputSha256?: string;
  [key: string]: unknown;
}

export interface PrototypeManifestEntry {
  prototypeId: string;
  prototypeKey?: string;
  name: string;
  assetKey: string;
  assetPath: string;
  sourcePath: string;
  role: string;
	baseGLB: string;
  lods: PrototypeLOD[];
  [key: string]: unknown;
}

export interface LODManifestEntry {
  prototypeId: string;
  status: "succeeded" | "base-only";
  reason?: string;
	baseSha256: string;
  lods: PrototypeLOD[];
}

export interface LODManifest {
  schema: "model-optimizer.lod-manifest";
  version: 3;
  baseBuildManifestHash: string;
  sceneId: string;
  basePrototypeManifestHash: string;
  toolchain: {
    name: string;
    version: string;
    binarySha256?: string;
  };
  prototypes: LODManifestEntry[];
}

export interface PresetLevel {
  level: number;
  ratio: number;
  maxErrorMeters: number;
  lockBorder: boolean;
}

export interface Preset {
  name: string;
  version: number;
  levels: PresetLevel[];
	fallback: "base-only" | "fail";
}

export interface CLIOptions {
  input: string;
  output: string;
  preset: string;
  maxLevel: number;
  report?: string;
  json: boolean;
  verbose: boolean;
  resume: boolean;
  help: boolean;
  version: boolean;
}

export interface PrototypeStats {
  meshes: number;
  primitives: number;
  triangleCount: number;
  vertexCount: number;
  unsupportedPrimitives: number;
  unsupportedModes: number[];
}

export interface LevelReport {
  level: number;
  path: string;
  inputBytes: number;
  outputBytes: number;
  inputTriangles: number;
  outputTriangles: number;
  inputVertices: number;
  outputVertices: number;
  targetRatio: number;
  targetErrorMeters: number;
  geometricErrorMeters: number;
  method: string;
  inputSha256?: string;
  tool?: string;
  toolVersion?: string;
  sha256: string;
  status: "succeeded" | "skipped";
  reason?: string;
}

export interface PrototypeReport {
  prototypeId: string;
	baseGLB: string;
	baseSha256: string;
	baseBytes: number;
  stats: PrototypeStats;
  lods: LevelReport[];
	status: "succeeded" | "base-only" | "failed";
  reason?: string;
}

export interface WorkerReport {
  schema: "model-optimizer.lod-worker-report";
  version: 3;
  status: "succeeded" | "failed";
  inputRoot: string;
  outputRoot: string;
  baseBuildManifestHash: string;
  sceneId: string;
  basePrototypeManifestHash: string;
  preset: string;
  presetVersion: number;
  maxLevel: number;
  toolchain: LODManifest["toolchain"];
  startedAt: string;
  finishedAt?: string;
  prototypes: PrototypeReport[];
  errors?: string[];
}

export interface InputSnapshot {
  inputRoot: string;
  build: BuildManifest;
  buildManifestHash: string;
  prototypesPath: string;
  prototypes: PrototypeManifestEntry[];
  prototypeManifestHash: string;
  toolchainLockHash: string;
}

export interface WorkerState {
  schema: "model-optimizer.lod-worker-state";
  version: 3;
  jobKey: string;
  baseBuildManifestHash: string;
  sceneId: string;
  basePrototypeManifestHash: string;
  preset: string;
  presetVersion: number;
  maxLevel: number;
  toolchainHash: string;
  reports: PrototypeReport[];
  manifestEntries: LODManifestEntry[];
}

export interface OptimizationCLIOptions {
  input: string;
  output: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}
