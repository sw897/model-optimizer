import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(process.argv[2]);
const scratch = await mkdtemp(join(root, "smoke 中文 "));
const { Document, NodeIO } = await import(pathToFileURL(join(root, "app/node_modules/@gltf-transform/core/dist/index.js")).href);
const document = new Document();
const buffer = document.createBuffer();
const position = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
const uv = document.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer);
const texture = document.createTexture().setMimeType("image/png").setImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const material = document.createMaterial().setBaseColorTexture(texture);
const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setMaterial(material);
document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
const input = join(scratch, "输入.glb");
const output = join(scratch, "输出.glb");
await new NodeIO().write(input, document);
const run = (name, args) => spawnSync(join(root, `${name}.exe`), args, { cwd: scratch, env: { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "" }, encoding: "utf8" });
for (const name of ["model-opt-worker", "model-lod-worker"]) {
  const result = run(name, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(run(name, ["--invalid"]).status, 1);
}
const result = run("model-opt-worker", ["-i", input, "-o", output, "--json"]);
assert.equal(result.status, 0, result.stderr);
JSON.parse(result.stdout);
const bytes = await readFile(output);
const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
assert.ok(gltf.extensionsRequired.includes("EXT_meshopt_compression"));
assert.ok(gltf.extensionsRequired.includes("KHR_texture_basisu"));
console.log("Portable smoke test passed: both CLIs, exit codes, Unicode/spaced paths, Meshopt and KTX2; PATH is empty.");
