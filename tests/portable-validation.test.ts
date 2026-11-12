import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectGoLicense, collectPortableNotices } from "../scripts/portable-notices.mjs";
import { fileRecord, inventoryTree } from "../scripts/portable-integrity.mjs";
import { inspectWindowsTree } from "../scripts/pe.mjs";
import { verifyPortable } from "../scripts/verify-portable.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temporary = async () => { const root = await mkdtemp(join(tmpdir(), "portable validation 中文 ")); roots.push(root); return root; };

// Synthetic x64 executable with a terminated KERNEL32 import table.
function executable(): Buffer {
  const b = Buffer.alloc(0x800), pe = 0x80, opt = pe + 24;
  b.writeUInt16LE(0x5a4d); b.writeUInt32LE(pe, 0x3c); b.writeUInt32LE(0x4550, pe);
  b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(1, pe + 6); b.writeUInt16LE(240, pe + 20);
  b.writeUInt16LE(0x20b, opt); b.writeUInt32LE(0x200, opt + 60); b.writeUInt32LE(16, opt + 108);
  const section = opt + 240;
  b.writeUInt32LE(0x1000, section + 12); b.writeUInt32LE(0x600, section + 16); b.writeUInt32LE(0x200, section + 20);
  b.writeUInt32LE(0x1000, opt + 120); b.writeUInt32LE(40, opt + 124);
  b.writeUInt32LE(0x1100, 0x20c); b.write("KERNEL32.dll", 0x300);
  return b;
}

async function fixture() {
  const root = await temporary();
  const put = async (path: string, data: string | Buffer) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), data); };
  const json = (path: string, data: unknown) => put(path, JSON.stringify(data));
  for (const path of ["model-opt-worker.exe", "model-lod-worker.exe", "runtime/node.exe", "app/vendor/basisu/windows-x64/basisu.exe"]) await put(path, executable());
  for (const path of ["app/dist/opt-cli.js", "app/dist/cli.js", "app/examples/generate.mjs", "app/scripts/test-portable.mjs", "app/scripts/verify-portable.mjs", "app/scripts/pe.mjs", "app/scripts/portable-integrity.mjs", "app/scripts/portable-licenses.mjs", "app/scripts/portable-redistribution.mjs", "app/LICENSE", "app/NOTICE", "app/THIRD_PARTY_NOTICES.md", "runtime/LICENSE", "app/vendor/basisu/windows-x64/licenses/Basis-Universal-Apache-2.0.txt", "app/vendor/licenses/GPL-3.0.txt", "app/vendor/licenses/LGPL-3.0.txt", "app/node_modules/synthetic/LICENSE"]) await put(path, "synthetic fixture\n");
  await json("app/package.json", { version: "0.3.3", dependencies: { synthetic: "1.0.0" } });
  await json("app/node_modules/synthetic/package.json", { name: "synthetic", version: "1.0.0", license: "MIT" });
  const encoder = await fileRecord(root, "app/vendor/basisu/windows-x64/basisu.exe");
  await json("app/native-tools.lock.json", { node: { version: "24.22.3" }, basisu: { "windows-x64": { path: "vendor/basisu/windows-x64/basisu.exe", sha256: encoder.sha256 } } });
  const toolchain = await temporary();
  await writeFile(join(toolchain, "LICENSE"), "The Go Authors\nRedistribution and use in source and binary forms\nSynthetic toolchain fixture.\n");
  const go = await collectGoLicense(root, toolchain, "go version fixture");
  const packages = await collectPortableNotices(root, go);
  const manifest = {
    schema: "model-optimizer.windows-portable", version: 2, packageVersion: "0.3.3",
    node: { version: "24.22.3", binarySha256: (await fileRecord(root, "runtime/node.exe")).sha256 },
    encoder: { sha256: encoder.sha256 }, launcher: { compiler: go.version },
    nativeFiles: await inspectWindowsTree(root), applicationFiles: await inventoryTree(root, "app"),
    productionPackages: packages, licenses: await fileRecord(root, "THIRD_PARTY_LICENSES.json"),
  };
  const save = () => json("portable-manifest.json", manifest);
  const updateInventory = async (edit: (inventory: any) => void) => {
    const inventory = JSON.parse(await readFile(join(root, "THIRD_PARTY_LICENSES.json"), "utf8"));
    edit(inventory);
    await json("THIRD_PARTY_LICENSES.json", inventory);
    manifest.licenses = await fileRecord(root, "THIRD_PARTY_LICENSES.json");
    await save();
  };
  await save();
  return { root, manifest, save, put, updateInventory };
}

it("accepts a complete extracted portable tree with package and native notices", async () => {
  const { root } = await fixture();
  expect((await verifyPortable(root)).nativeFiles).toBe(4);
});

it.each(["opt-cli.js", "cli.js"])("rejects missing %s even if the application inventory also omits it", async name => {
  const { root, manifest, save } = await fixture();
  await rm(join(root, "app/dist", name));
  manifest.applicationFiles = await inventoryTree(root, "app"); await save();
  await expect(verifyPortable(root)).rejects.toThrow();
});

it("rejects two absent launchers rather than comparing two undefined hashes", async () => {
  const { root, manifest, save } = await fixture();
  await rm(join(root, "model-opt-worker.exe")); await rm(join(root, "model-lod-worker.exe"));
  manifest.nativeFiles = await inspectWindowsTree(root); await save();
  await expect(verifyPortable(root)).rejects.toThrow("Missing required native executable");
});

it("rejects changed JavaScript while all native hashes still match", async () => {
  const { root, put } = await fixture();
  await put("app/dist/cli.js", "changed script\n");
  await expect(verifyPortable(root)).rejects.toThrow("Application files differ");
});

it("parses the license inventory rather than accepting arbitrary nonempty bytes", async () => {
  const { root, put, manifest, save } = await fixture();
  await put("THIRD_PARTY_LICENSES.json", "invalid JSON");
  manifest.licenses = await fileRecord(root, "THIRD_PARTY_LICENSES.json"); await save();
  await expect(verifyPortable(root)).rejects.toThrow();
});

it("rejects empty or mismatched package license inventories", async () => {
  const { root, updateInventory } = await fixture();
  await updateInventory(inventory => { inventory.packages[0].version = "2.0.0"; });
  await expect(verifyPortable(root)).rejects.toThrow("License inventory differs");
  await updateInventory(inventory => { inventory.packages = []; });
  await expect(verifyPortable(root)).rejects.toThrow("Empty license inventory");
});

it.each(["missing", "changed"])("rejects a %s license referenced by the catalog", async action => {
  const { root, put } = await fixture();
  const path = "licenses/npm/synthetic/LICENSE";
  if (action === "missing") await rm(join(root, path)); else await put(path, "modified license");
  await expect(verifyPortable(root)).rejects.toThrow();
});

it("rejects a notice path escaping the portable root", async () => {
  const { root, updateInventory } = await fixture();
  await updateInventory(inventory => { inventory.packages[0].notices[0].path = "../outside"; });
  await expect(verifyPortable(root)).rejects.toThrow("Unsafe inventory path");
});

it("requires the Go notice even when a catalog entry was removed with it", async () => {
  const { root, updateInventory } = await fixture();
  await rm(join(root, "runtime/Go-LICENSE"));
  await updateInventory(inventory => { inventory.nativeNotices = inventory.nativeNotices.filter((record: { path: string }) => record.path !== "runtime/Go-LICENSE"); });
  await expect(verifyPortable(root)).rejects.toThrow("Missing required native notice");
});

it("copies the actual Homebrew compiler license and fails closed if no license exists", async () => {
  const root = await temporary(), tools = await temporary(), goRoot = join(tools, "libexec");
  await mkdir(join(root, "runtime")); await mkdir(goRoot);
  const text = "The Go Authors\nRedistribution and use in source and binary forms\nSynthetic compiler fixture.";
  await writeFile(join(tools, "LICENSE"), text);
  await collectGoLicense(root, goRoot, "go fixture");
  expect(await readFile(join(root, "runtime/Go-LICENSE"), "utf8")).toBe(text);
  await rm(join(tools, "LICENSE"));
  await expect(collectGoLicense(root, goRoot, "go fixture")).rejects.toThrow("Go toolchain copyright/license is missing");
});
