import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileRecord, inventoryTree } from "./portable-integrity.mjs";
import { productionPackages } from "./portable-licenses.mjs";

export async function collectGoLicense(root, goRoot, version) {
  // Homebrew keeps the original license beside libexec; official Go archives
  // keep it directly under GOROOT. Never substitute a license from another Go.
  let license;
  for (const path of [join(goRoot, "LICENSE"), join(dirname(goRoot), "LICENSE")]) {
    try { license = await readFile(path); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  assert.ok(license?.includes(Buffer.from("The Go Authors")) && license.includes(Buffer.from("Redistribution and use in source and binary forms")), "Go toolchain copyright/license is missing");
  await writeFile(join(root, "runtime/Go-LICENSE"), license);
  return { version, origin: "License from the compiler's GOROOT (or Homebrew parent)", license: await fileRecord(root, "runtime/Go-LICENSE") };
}

export async function collectPortableNotices(root, go) {
  const records = [];
  for (const identity of await productionPackages(root)) {
    const path = dirname(join(root, identity.packagePath));
    const notices = [];
    for (const file of await readdir(path, { withFileTypes: true })) {
      if (file.isFile() && /licen[cs]e|copying|notice|copyright/i.test(file.name)) {
        const target = join(root, "licenses/npm", identity.name.replaceAll("/", "_"), file.name);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(path, file.name), target);
        notices.push(await fileRecord(root, relative(root, target).replaceAll("\\", "/")));
      }
    }
    if (!notices.length && identity.name === "draco3dgltf") notices.push(await fileRecord(root, "app/vendor/licenses/draco3dgltf-LICENSE.txt"));
    if (!notices.length) throw new Error(`Package has no bundled license text: ${identity.name}`);
    records.push({ ...identity, notices });
  }
  const nativeNotices = await Promise.all(["runtime/LICENSE", "runtime/Go-LICENSE", "app/LICENSE", "app/NOTICE", "app/THIRD_PARTY_NOTICES.md"].map(path => fileRecord(root, path)));
  nativeNotices.push(...await inventoryTree(root, "app/vendor/basisu/windows-x64/licenses"), ...await inventoryTree(root, "app/vendor/licenses"));
  if (records.some(item => item.name === "@img/sharp-win32-x64")) {
    const source = JSON.parse(await readFile(join(root, "redistribution/SOURCE-MATERIALS.json"), "utf8"));
    nativeNotices.push(await fileRecord(root, "redistribution/SOURCE-MATERIALS.json"), await fileRecord(root, `redistribution/sdk/${source.sdk.root}/LICENSE`));
  }
  await writeFile(join(root, "THIRD_PARTY_LICENSES.json"), `${JSON.stringify({ schema: "model-optimizer.portable-licenses", version: 2, packages: records, nativeNotices, go, omitted: [{ name: "basisu", reason: "Windows uses the reviewed CPU Release encoder, not the npm wrapper or its binaries" }] }, null, 2)}\n`);
  return records.map(({ notices, ...identity }) => identity);
}
