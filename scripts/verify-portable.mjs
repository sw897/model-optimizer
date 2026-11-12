import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectWindowsTree } from "./pe.mjs";
import { fileRecord, inventoryTree } from "./portable-integrity.mjs";
import { verifyLicenses } from "./portable-licenses.mjs";
import { verifyRedistribution } from "./portable-redistribution.mjs";

export async function verifyPortable(root) {
  const manifest = JSON.parse(await readFile(join(root, "portable-manifest.json"), "utf8"));
  assert.equal(manifest.schema, "model-optimizer.windows-portable");
  assert.equal(manifest.version, 2);
  const metadata = JSON.parse(await readFile(join(root, "app/package.json"), "utf8"));
  assert.equal(manifest.packageVersion, metadata.version);
  const nativeTools = JSON.parse(await readFile(join(root, "app/native-tools.lock.json"), "utf8"));
  assert.equal(manifest.node.version, nativeTools.node.version);
  assert.equal(manifest.encoder.sha256, nativeTools.basisu["windows-x64"].sha256);
  const files = await inspectWindowsTree(root);
  assert.deepEqual(files, manifest.nativeFiles, "Portable PE files/imports differ from their recorded inventory");
  const hash = async path => createHash("sha256").update(await readFile(join(root, path))).digest("hex");
  assert.equal(await hash(`app/${nativeTools.basisu["windows-x64"].path}`), manifest.encoder.sha256);
  assert.equal(await hash("runtime/node.exe"), manifest.node.binarySha256);
  for (const path of ["model-opt-worker.exe", "model-lod-worker.exe", "runtime/node.exe", `app/${nativeTools.basisu["windows-x64"].path}`]) {
    assert.ok(files.some(file => file.path === path), `Missing required native executable: ${path}`);
  }
  assert.equal(files.find(file => file.path === "model-opt-worker.exe").sha256, files.find(file => file.path === "model-lod-worker.exe").sha256);
  for (const path of ["app/dist/opt-cli.js", "app/dist/cli.js", "app/examples/generate.mjs", "app/scripts/test-portable.mjs", "app/scripts/verify-portable.mjs", "app/scripts/pe.mjs", "app/scripts/portable-integrity.mjs", "app/scripts/portable-licenses.mjs", "app/scripts/portable-redistribution.mjs"]) {
    assert.ok((await fileRecord(root, path)).bytes > 0, `Missing required runtime file: ${path}`);
  }
  await verifyLicenses(root, manifest);
  await verifyRedistribution(root, manifest);
  assert.ok(Array.isArray(manifest.applicationFiles) && manifest.applicationFiles.length, "Missing application file inventory");
  assert.deepEqual(await inventoryTree(root, "app"), manifest.applicationFiles, "Application files differ from their recorded inventory");
  await assert.rejects(lstat(join(root, "app/node_modules/basisu")), { code: "ENOENT" });
  return { manifest, nativeFiles: files.length };
}
