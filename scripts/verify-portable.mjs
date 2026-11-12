import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectWindowsTree } from "./pe.mjs";

export async function verifyPortable(root) {
  const manifest = JSON.parse(await readFile(join(root, "portable-manifest.json"), "utf8"));
  assert.equal(manifest.schema, "model-optimizer.windows-portable");
  assert.equal(manifest.version, 1);
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
  assert.equal(files.find(file => file.path === "model-opt-worker.exe")?.sha256, files.find(file => file.path === "model-lod-worker.exe")?.sha256);
  for (const path of ["app/LICENSE", "app/NOTICE", "app/THIRD_PARTY_NOTICES.md", "runtime/LICENSE", "THIRD_PARTY_LICENSES.json"]) {
    assert.ok((await readFile(join(root, path))).length, `Missing portable attribution: ${path}`);
  }
  await assert.rejects(lstat(join(root, "app/node_modules/basisu")), { code: "ENOENT" });
  return { manifest, nativeFiles: files.length };
}
