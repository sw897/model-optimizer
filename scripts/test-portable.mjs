import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { verifyPortable } from "./verify-portable.mjs";

if (!process.argv[2]) throw new Error("Usage: node scripts/test-portable.mjs <extracted-portable-directory>");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Execute this smoke check with the bundled Windows x64 Node.js, natively or through an explicitly identified Wine runner.");
const root = resolve(process.argv[2]);
// A failed rerun must not leave a previous successful execution report.
await rm(join(root, "validation-report.json"), { force: true });
const { manifest } = await verifyPortable(root);
const scratch = await mkdtemp(join(root, "smoke 中文 "));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["path", "node_path", "node_options", "temp", "tmp"].includes(key.toLowerCase())));
Object.assign(env, { PATH: "", NODE_PATH: "", NODE_OPTIONS: "", TEMP: scratch, TMP: scratch });
const run = (executable, args, expected = 0) => {
  const result = spawnSync(executable, args, { cwd: scratch, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 << 20 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${executable}: ${result.stderr}\n${result.stdout}`);
  return result;
};
const cli = (name, args, expected = 0) => run(join(root, `${name}.exe`), args, expected);
const checks = [];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  assert.equal(run(join(root, "runtime/node.exe"), ["--version"]).stdout.trim(), `v${manifest.node.version}`);
  for (const name of ["model-opt-worker", "model-lod-worker"]) {
    assert.equal(cli(name, ["--version"]).stdout.trim(), manifest.packageVersion);
    assert.match(cli(name, ["--help"]).stdout, /Usage:/);
    cli(name, ["--invalid"], 1);
  }
  checks.push("bundled runtime; both launchers; versions/help/exit codes; empty PATH/NODE_PATH/NODE_OPTIONS");
  const encoder = join(root, "app", manifest.encoder.path);
  assert.match(run(encoder, ["-version"]).stdout, /v1\.16\.3/);
  checks.push("reviewed CPU Release BasisU version and hash");
  const example = join(scratch, "generated examples");
  run(join(root, "runtime/node.exe"), [join(root, "app/examples/generate.mjs"), example]);
  const original = await readFile(join(example, "model.glb"));
  const output = join(example, "输出.glb");
  const report = JSON.parse(cli("model-opt-worker", ["-i", join(example, "model.glb"), "-o", output, "--json"]).stdout);
  assert.equal(report.status, "succeeded");
  assert.ok(report.textureEncoder.includes(manifest.encoder.sha256));
  const bytes = await readFile(output);
  const parse = value => ({ json: JSON.parse(value.subarray(20, 20 + value.readUInt32LE(12)).toString("utf8")), binary: value.subarray(28 + value.readUInt32LE(12)) });
  const optimized = parse(bytes), base = parse(original);
  for (const extension of ["EXT_meshopt_compression", "KHR_texture_basisu"]) assert.ok(optimized.json.extensionsRequired.includes(extension));
  assert.ok(optimized.json.images.every(image => image.mimeType === "image/ktx2" && !image.uri));
  assert.equal(report.textureResources, 3, "Exercise color, normal and data encoding paths");
  const schemes = optimized.json.images.map(image => {
    const view = optimized.json.bufferViews[image.bufferView];
    const ktx = optimized.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    assert.equal(ktx.subarray(0, 12).toString("hex"), "ab4b5458203230bb0d0a1a0a");
    return ktx.readUInt32LE(44);
  });
  assert.deepEqual(schemes.sort(), [1, 2, 2], "ETC1S color and Zstd/UASTC normal/data textures");
  const require = createRequire(join(root, "app/package.json"));
  const { MeshoptDecoder } = require("meshoptimizer");
  await MeshoptDecoder.ready;
  const positions = parsed => {
    const accessor = parsed.json.accessors[parsed.json.meshes[0].primitives[0].attributes.POSITION];
    const view = parsed.json.bufferViews[accessor.bufferView], compressed = view.extensions?.EXT_meshopt_compression;
    let data = parsed.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    if (compressed) {
      assert.equal(compressed.buffer, 0);
      data = Buffer.alloc(view.byteLength);
      MeshoptDecoder.decodeGltfBuffer(data, compressed.count, compressed.byteStride, parsed.binary.subarray(compressed.byteOffset ?? 0, (compressed.byteOffset ?? 0) + compressed.byteLength), compressed.mode);
    }
    const result = Buffer.alloc(accessor.count * 12);
    for (let i = 0; i < accessor.count; i++) data.copy(result, i * 12, (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 12), (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 12) + 12);
    return result;
  };
  assert.deepEqual(positions(optimized), positions(base));
  assert.equal(hash(await readFile(join(example, "model.glb"))), hash(original));
  const outputHash = hash(bytes);
  cli("model-opt-worker", ["-i", join(example, "model.glb"), "-o", output], 1);
  assert.equal(hash(await readFile(output)), outputHash);
  checks.push("GLB: CPU KTX2 encoding, self-contained output, exact decoded POSITION bytes, unchanged input and occupied output");
  cli("model-opt-worker", ["-i", join(example, "models"), "-o", join(example, "models-web"), "--json"]);
  assert.deepEqual(await readFile(join(example, "models-web/offset.json")), await readFile(join(example, "models/offset.json")));
  const tiles = JSON.parse(cli("model-opt-worker", ["-i", join(example, "tileset"), "-o", join(example, "tileset-web"), "--json"]).stdout);
  assert.equal(tiles.inputKind, "tileset");
  cli("model-lod-worker", ["-i", join(example, "lod-input"), "-o", join(example, "lod"), "--max-level", "1", "--json"]);
  const lod = JSON.parse(await readFile(join(example, "lod/lod-worker-report.json"), "utf8"));
  assert.equal(lod.status, "succeeded");
  assert.equal(lod.prototypes[0].status, "succeeded");
  assert.equal(lod.prototypes[0].lods.length, 1);
  checks.push("model directory and auxiliary file preservation; standard tileset; real model input LOD generation");
  const goodEncoder = await readFile(encoder);
  try {
    const damaged = Buffer.from(goodEncoder); damaged[damaged.length - 1] ^= 1;
    await writeFile(encoder, damaged);
    const failed = cli("model-opt-worker", ["-i", join(example, "model.glb"), "-o", join(example, "tampered.glb")], 1);
    assert.match(failed.stderr, /SHA-256 mismatch/);
    await assert.rejects(lstat(join(example, "tampered.glb")), { code: "ENOENT" });
  } finally { await writeFile(encoder, goodEncoder); }
  await verifyPortable(root);
  checks.push("tampered encoder rejected before publishing output; reviewed binary restored");
  const validation = { schema: "model-optimizer.portable-validation", version: 1, status: "passed", environment: process.env.MODEL_OPTIMIZER_TEST_PLATFORM === "wine" ? "wine" : "native-windows", windowsRelease: release(), architecture: process.arch, node: process.version, packageVersion: manifest.packageVersion, encoderSha256: manifest.encoder.sha256, checks };
  await writeFile(join(root, "validation-report.json"), `${JSON.stringify(validation, null, 2)}\n`);
  console.log(`Portable smoke checks passed (${validation.environment}): ${checks.length} groups; both CLIs, geometry/textures, LOD, failure paths and isolated environment.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
