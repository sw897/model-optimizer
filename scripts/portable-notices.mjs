import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export async function collectPortableNotices(root) {
  const records = [];
  const modules = join(root, "app/node_modules");
  const visitModules = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) { await visitModules(path); continue; }
      let metadata;
      try { metadata = JSON.parse(await readFile(join(path, "package.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const license = metadata.license ?? metadata.licenses?.map(item => item.type).join(" OR ");
      if (!license) throw new Error(`Package has no recorded license: ${metadata.name}`);
      const notices = [];
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (file.isFile() && /licen[cs]e|copying|notice|copyright/i.test(file.name)) {
          const target = join(root, "licenses/npm", metadata.name.replaceAll("/", "_"), file.name);
          await mkdir(join(root, "licenses/npm", metadata.name.replaceAll("/", "_")), { recursive: true });
          await cp(join(path, file.name), target);
          notices.push(relative(root, target).replaceAll("\\", "/"));
        }
      }
      if (!notices.length && metadata.name === "draco3dgltf") notices.push("app/vendor/licenses/draco3dgltf-LICENSE.txt");
      if (!notices.length) throw new Error(`Package has no bundled license text: ${metadata.name}`);
      records.push({ name: metadata.name, version: metadata.version, license, notices });
      if ((await readdir(path)).includes("node_modules")) await visitModules(join(path, "node_modules"));
    }
  };
  await visitModules(modules);
  records.sort((a, b) => a.name.localeCompare(b.name, "en"));
  await writeFile(join(root, "THIRD_PARTY_LICENSES.json"), `${JSON.stringify({ schema: "model-optimizer.portable-licenses", version: 1, packages: records, nativeNotices: ["runtime/LICENSE", "app/vendor/basisu/windows-x64/licenses", "app/vendor/licenses", "app/THIRD_PARTY_NOTICES.md"], omitted: [{ name: "basisu", reason: "Windows uses the reviewed CPU Release encoder, not the npm wrapper or its binaries" }] }, null, 2)}\n`);
  return records;
}
