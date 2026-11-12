import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fileRecord, inventoryTree } from "../scripts/portable-integrity.mjs";
import { assertReleaseReady, verifyRedistribution } from "../scripts/portable-redistribution.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-materials-")); roots.push(root);
  const put = async (path: string, value: unknown) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
  const archivePath = "redistribution/sources/library.tar.gz";
  await put(archivePath, "synthetic source archive");
  const archive = await fileRecord(root, archivePath);
  const versions = { vips: "8.18.7", glib: "2.90.0" };
  const sdk = { root: "vips-dev-8.18" };
  for (const name of ["LICENSE", "versions.json", "include/vips/vips.h", "lib/libvips.lib"]) await put(`redistribution/sdk/${sdk.root}/${name}`, "synthetic SDK material");
  const lock = {
    schema: "model-optimizer.windows-redistribution", version: 1, status: "partial", sdk, componentVersions: versions,
    assets: [{ id: "library", filename: "library.tar.gz", sha256: archive.sha256 }],
    nativeBinary: { path: "app/native.dll", sha256: "a".repeat(64) },
    blockers: [{ id: "embedded-source-closure", reason: "Incomplete source closure" }], pendingSources: [{ component: "glib", version: "2.90.0" }],
  };
  await put("app/vendor/redistribution/windows-x64.json", lock);
  await put("app/node_modules/@img/sharp-win32-x64/versions.json", versions);
  const report = { ...lock, schema: "model-optimizer.windows-source-materials", version: 1, sources: lock.assets, binary: lock.nativeBinary, files: await inventoryTree(root, "redistribution") };
  await put("redistribution/SOURCE-MATERIALS.json", report);
  const manifest = {
    productionPackages: [{ name: "@img/sharp-win32-x64" }], nativeFiles: [lock.nativeBinary],
    redistribution: { path: "redistribution/SOURCE-MATERIALS.json", file: await fileRecord(root, "redistribution/SOURCE-MATERIALS.json"), status: lock.status, blockers: lock.blockers },
    validation: { execution: "wine" },
  };
  return { root, put, manifest, report };
}

it("accepts intact source materials while keeping public distribution blocked", async () => {
  const { root, manifest } = await fixture();
  expect((await verifyRedistribution(root, manifest)).status).toBe("partial");
  expect(() => assertReleaseReady(manifest)).toThrow("embedded-source-closure");
  expect(() => assertReleaseReady(manifest)).toThrow("native-windows");
});

it("rejects a source archive missing from an otherwise unchanged inventory", async () => {
  const { root, manifest } = await fixture();
  await rm(join(root, "redistribution/sources/library.tar.gz"));
  await expect(verifyRedistribution(root, manifest)).rejects.toThrow("source/SDK materials differ");
});

it("rejects native library version drift despite intact source archives", async () => {
  const { root, put, manifest } = await fixture();
  await put("app/node_modules/@img/sharp-win32-x64/versions.json", { vips: "8.18.8", glib: "2.90.0" });
  await expect(verifyRedistribution(root, manifest)).rejects.toThrow("different native versions");
});

it("rejects a forged complete status in the source-material report", async () => {
  const { root, put, manifest, report } = await fixture();
  await put("redistribution/SOURCE-MATERIALS.json", { ...report, status: "complete" });
  manifest.redistribution.file = await fileRecord(root, "redistribution/SOURCE-MATERIALS.json");
  await expect(verifyRedistribution(root, manifest)).rejects.toThrow();
});
