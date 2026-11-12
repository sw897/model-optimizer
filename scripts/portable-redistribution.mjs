import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inventoryTree, verifyFileRecord } from "./portable-integrity.mjs";

export async function verifyRedistribution(root, manifest) {
  if (!manifest.productionPackages.some(item => item.name === "@img/sharp-win32-x64")) return;
  assert.equal(manifest.redistribution?.path, "redistribution/SOURCE-MATERIALS.json");
  await verifyFileRecord(root, manifest.redistribution.file);
  assert.equal(manifest.redistribution.file.path, manifest.redistribution.path);
  const report = JSON.parse(await readFile(join(root, manifest.redistribution.path), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "app/vendor/redistribution/windows-x64.json"), "utf8"));
  assert.equal(lock.schema, "model-optimizer.windows-redistribution");
  assert.equal(lock.version, 1);
  assert.ok(["partial", "complete"].includes(lock.status), "Unknown source material status");
  assert.equal(report.schema, "model-optimizer.windows-source-materials");
  assert.equal(report.version, 1);
  assert.equal(report.status, lock.status);
  assert.deepEqual(report.blockers, lock.blockers);
  assert.deepEqual(report.pendingSources, lock.pendingSources);
  assert.deepEqual(manifest.redistribution.blockers, report.blockers);
  assert.equal(manifest.redistribution.status, report.status);
  assert.deepEqual(report.sdk, lock.sdk);
  assert.deepEqual(report.sources, lock.assets);
  assert.deepEqual(report.binary, lock.nativeBinary);
  assert.deepEqual(report.componentVersions, lock.componentVersions);
  const versions = JSON.parse(await readFile(join(root, "app/node_modules/@img/sharp-win32-x64/versions.json"), "utf8"));
  assert.deepEqual(versions, report.componentVersions, "Source materials are for different native versions");
  const binary = manifest.nativeFiles.find(file => file.path === lock.nativeBinary.path);
  assert.equal(binary?.sha256, lock.nativeBinary.sha256, "Source/SDK bridge does not match the actual libvips DLL");
  const files = (await inventoryTree(root, "redistribution")).filter(file => file.path !== manifest.redistribution.path);
  assert.deepEqual(files, report.files, "Native source/SDK materials differ from their recorded inventory");
  for (const asset of lock.assets) {
    assert.equal(files.find(file => file.path === `redistribution/sources/${asset.filename}`)?.sha256, asset.sha256, `Missing pinned source archive: ${asset.id}`);
  }
  for (const name of ["LICENSE", "versions.json", "include/vips/vips.h", "lib/libvips.lib"]) {
    assert.ok(files.some(file => file.path === `redistribution/sdk/${lock.sdk.root}/${name}`), `Missing SDK replacement material: ${name}`);
  }
  return report;
}

export function assertReleaseReady(manifest) {
  const blockers = [...(manifest.redistribution?.blockers ?? [])];
  if (manifest.redistribution?.status !== "complete") blockers.push({ id: "native-source-materials", reason: "Corresponding source and redistribution review is incomplete" });
  if (manifest.validation.execution !== "native-windows") blockers.push({ id: "native-windows", reason: "This artifact has not passed native Windows execution" });
  assert.equal(blockers.length, 0, `Public portable distribution blocked:\n${blockers.map(item => `${item.id}: ${item.reason}`).join("\n")}`);
}
