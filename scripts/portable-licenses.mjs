import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileRecord, portablePath, verifyFileRecord } from "./portable-integrity.mjs";

export async function productionPackages(root) {
  const records = [];
  const visit = async directory => {
    for (const entry of await readdir(portablePath(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.name.startsWith("@")) { await visit(path); continue; }
      const packagePath = `${path}/package.json`;
      const metadata = JSON.parse(await readFile(portablePath(root, packagePath), "utf8"));
      const license = metadata.license ?? metadata.licenses?.map(item => item.type).join(" OR ");
      assert.ok(typeof metadata.name === "string" && typeof metadata.version === "string" && typeof license === "string" && license, `Missing package identity/license: ${packagePath}`);
      records.push({ name: metadata.name, version: metadata.version, license, packagePath });
      if ((await readdir(portablePath(root, path))).includes("node_modules")) await visit(`${path}/node_modules`);
    }
  };
  await visit("app/node_modules");
  return records.sort((a, b) => a.packagePath < b.packagePath ? -1 : a.packagePath > b.packagePath ? 1 : 0);
}

export async function verifyLicenses(root, manifest) {
  assert.equal(manifest.licenses?.path, "THIRD_PARTY_LICENSES.json");
  await verifyFileRecord(root, manifest.licenses);
  const inventory = JSON.parse(await readFile(join(root, manifest.licenses.path), "utf8"));
  assert.equal(inventory.schema, "model-optimizer.portable-licenses");
  assert.equal(inventory.version, 2);
  assert.ok(Array.isArray(inventory.packages) && inventory.packages.length, "Empty license inventory");
  const actual = await productionPackages(root);
  const app = JSON.parse(await readFile(join(root, "app/package.json"), "utf8"));
  for (const [name, version] of Object.entries(app.dependencies ?? {})) {
    if (name === "basisu") continue; // Replaced by the reviewed native encoder.
    assert.ok(actual.some(item => item.name === name && item.version === version && item.packagePath === `app/node_modules/${name}/package.json`), `Missing pinned runtime dependency: ${name}@${version}`);
  }
  assert.deepEqual(actual, manifest.productionPackages, "Installed packages differ from the portable manifest");
  assert.deepEqual(inventory.packages.map(({ notices, ...identity }) => identity), actual, "License inventory differs from installed packages");
  for (const entry of inventory.packages) {
    assert.ok(Array.isArray(entry.notices) && entry.notices.length, `No notices for ${entry.name}`);
    for (const notice of entry.notices) {
      assert.ok(notice.bytes > 0, `Empty notice for ${entry.name}`);
      await verifyFileRecord(root, notice);
    }
  }
  assert.ok(Array.isArray(inventory.nativeNotices) && inventory.nativeNotices.length, "Missing native license inventory");
  const paths = inventory.nativeNotices.map(record => record.path);
  assert.equal(new Set(paths).size, paths.length, "Duplicate native license record");
  for (const required of ["runtime/LICENSE", "runtime/Go-LICENSE", "app/LICENSE", "app/NOTICE", "app/THIRD_PARTY_NOTICES.md", "app/vendor/basisu/windows-x64/licenses/Basis-Universal-Apache-2.0.txt", "app/vendor/licenses/GPL-3.0.txt", "app/vendor/licenses/LGPL-3.0.txt"]) {
    assert.ok(paths.includes(required), `Missing required native notice: ${required}`);
  }
  for (const notice of inventory.nativeNotices) {
    assert.ok(notice.bytes > 0, `Empty native notice: ${notice.path}`);
    await verifyFileRecord(root, notice);
  }
  assert.equal(inventory.go?.version, manifest.launcher.compiler);
  assert.equal(inventory.go?.license?.path, "runtime/Go-LICENSE");
  assert.deepEqual(inventory.go.license, await fileRecord(root, "runtime/Go-LICENSE"));
  return inventory;
}
