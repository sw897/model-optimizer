import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { fetchPinned, sha256 } from "./native-assets.mjs";
import { fileRecord, inventoryTree, portablePath } from "./portable-integrity.mjs";

export async function prepareWindowsRedistribution(checkout, destination, cache) {
  const lock = JSON.parse(await readFile(join(checkout, "vendor/redistribution/windows-x64.json"), "utf8"));
  assert.equal(lock.schema, "model-optimizer.windows-redistribution");
  assert.equal(lock.version, 1);
  const versions = JSON.parse(await readFile(join(destination, "app/node_modules/@img/sharp-win32-x64/versions.json"), "utf8"));
  assert.deepEqual(versions, lock.componentVersions, "Review source materials after changing Sharp/libvips");
  assert.equal(sha256(await readFile(join(destination, lock.nativeBinary.path))), lock.nativeBinary.sha256, "Actual DLL differs from reviewed source/SDK bridge");
  const sdk = await fetchPinned(lock.sdk, cache);
  const selected = unzipSync(sdk.bytes, { filter: file => file.name === lock.sdk.binaryPath || file.name === `${lock.sdk.root}/LICENSE` || file.name === `${lock.sdk.root}/README.md` || file.name === `${lock.sdk.root}/versions.json` || file.name.startsWith(`${lock.sdk.root}/include/`) || (file.name.startsWith(`${lock.sdk.root}/lib/`) && /\.(?:lib|def)$/.test(file.name)) });
  assert.equal(sha256(selected[lock.sdk.binaryPath]), lock.nativeBinary.sha256, "Reviewed SDK does not contain the actual DLL");
  assert.deepEqual(JSON.parse(Buffer.from(selected[`${lock.sdk.root}/versions.json`]).toString("utf8")), lock.componentVersions);
  // Keep SDK headers/import libraries and license data for replacement work,
  // without introducing its extra EXE/DLL programs into the portable product.
  for (const [name, bytes] of Object.entries(selected)) {
    if (name === lock.sdk.binaryPath || name.endsWith("/")) continue;
    const target = portablePath(destination, `redistribution/sdk/${name}`);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  await mkdir(join(destination, "redistribution/sources"), { recursive: true });
  for (const asset of lock.assets) {
    const archive = await fetchPinned(asset, cache);
    await cp(archive.path, join(destination, "redistribution/sources", asset.filename));
  }
  const report = {
    schema: "model-optimizer.windows-source-materials", version: 1,
    status: lock.status, blockers: lock.blockers, pendingSources: lock.pendingSources, componentVersions: versions,
    binary: lock.nativeBinary, sdk: lock.sdk, sources: lock.assets,
    files: (await inventoryTree(destination, "redistribution")).filter(file => file.path !== "redistribution/SOURCE-MATERIALS.json"),
  };
  await writeFile(join(destination, "redistribution/SOURCE-MATERIALS.json"), `${JSON.stringify(report, null, 2)}\n`);
  return { path: "redistribution/SOURCE-MATERIALS.json", file: await fileRecord(destination, "redistribution/SOURCE-MATERIALS.json"), status: report.status, blockers: report.blockers };
}
