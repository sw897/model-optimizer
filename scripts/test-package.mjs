import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmEnvironment } from "./npm.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const filename = `${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${metadata.version}.tgz`;
const tarball = resolve(process.argv[2] ?? join(root, "artifacts", filename));
await stat(tarball);
const npmCLI = process.env.npm_execpath;
assert.ok(npmCLI, "Run this check with npm run test:package");
const scratch = await mkdtemp(join(tmpdir(), "model-optimizer package 中文 "));
const run = (entry, args, expected = 0) => {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: scratch, encoding: "utf8", timeout: 180_000, maxBuffer: 8 << 20, env: { ...npmEnvironment(), NODE_PATH: "", NODE_OPTIONS: "" } });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${entry}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const cli = (name, args, expected = 0) => run(npmCLI, ["exec", "--offline", "--", name, ...args], expected);
try {
  run(npmCLI, ["install", "--prefix", scratch, "--no-audit", "--no-fund", "--save-exact", tarball]);
  const installed = join(scratch, "node_modules", ...metadata.name.split("/"));
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md", "README.zh-CN.md", "CONTRIBUTING.md", "SECURITY.md", "docs/input-specification.md", "docs/releasing.md", "docs/windows-portable.md", "docs/windows-native-redistribution.md", "docs/release-blockers.md", "native-tools.lock.json", "vendor/basisu/windows-x64/basisu.exe", "vendor/redistribution/windows-x64.json", "toolchain.lock.json"]) {
    assert.deepEqual(await readFile(join(installed, file)), await readFile(join(root, file)), `Missing or stale packaged file: ${file}`);
  }
  for (const name of ["model-opt-worker", "model-lod-worker"]) {
    assert.equal(cli(name, ["--version"]).trim(), metadata.version);
    assert.match(cli(name, ["--help"]), /Usage:/);
    cli(name, ["--invalid"], 1);
  }
  const example = join(scratch, "generated examples");
  run(join(installed, "examples", "generate.mjs"), [example]);
  const original = await readFile(join(example, "model.glb"));
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const report = JSON.parse(cli("model-opt-worker", ["-i", join(example, "model.glb"), "-o", join(example, "optimized.glb"), "--json"]));
  assert.equal(report.status, "succeeded");
  assert.equal(report.inputKind, "glb-file");
  const bytes = await readFile(join(example, "optimized.glb"));
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  for (const extension of ["EXT_meshopt_compression", "KHR_texture_basisu"]) assert.ok(json.extensionsRequired.includes(extension));
  assert.ok(json.buffers.every(buffer => !buffer.uri));
  assert.ok(json.images.every(image => !image.uri));
  assert.equal(json.asset.extras.modelOptimizer.toolVersion, metadata.version);
  assert.equal(digest(await readFile(join(example, "model.glb"))), digest(original));
  cli("model-opt-worker", ["-i", join(example, "models"), "-o", join(example, "models-web"), "--json"]);
  assert.deepEqual(await readFile(join(example, "models-web", "offset.json")), await readFile(join(example, "models", "offset.json")));
  const tiles = JSON.parse(cli("model-opt-worker", ["-i", join(example, "tileset"), "-o", join(example, "tileset-web"), "--json"]));
  assert.equal(tiles.inputKind, "tileset");
  const manifest = JSON.parse(await readFile(join(example, "tileset-web", "optimization-manifest.json"), "utf8"));
  assert.equal(manifest.toolchain.version, metadata.version);
  assert.equal(manifest.toolchain.sharp, metadata.dependencies.sharp);
  cli("model-lod-worker", ["-i", join(example, "lod-input"), "-o", join(example, "lod"), "--max-level", "1", "--json"]);
  const lod = JSON.parse(await readFile(join(example, "lod", "lod-worker-report.json"), "utf8"));
  assert.equal(lod.status, "succeeded");
  assert.equal(lod.prototypes[0].status, "succeeded");
  assert.equal(lod.prototypes[0].lods.length, 1);
  console.log(`Installed-package smoke check passed: both bins, exit codes, GLB/directory/tileset/LOD, Meshopt/KTX2, notices and Unicode/spaced paths (${metadata.version}).`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
