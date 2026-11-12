import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./npm.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(projectRoot, "artifacts");

await runNpm(["run", "build"], projectRoot);
await runNpm(["run", "check:release"], projectRoot);
await mkdir(artifactRoot, { recursive: true });
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const packageFilename = `${packageMetadata.name.replace(/^@/, "").replaceAll("/", "-")}-${packageMetadata.version}.tgz`;

await runNpm(["pack", "--pack-destination", artifactRoot], projectRoot);

const tarball = join(artifactRoot, packageFilename);
const hash = createHash("sha256").update(await readFile(tarball)).digest("hex");
const checksums = [];
for (const entry of (await readdir(artifactRoot)).filter(entry => entry.endsWith(".tgz")).sort()) {
  checksums.push(`${createHash("sha256").update(await readFile(join(artifactRoot, entry))).digest("hex")}  ${entry}`);
}
await writeFile(join(artifactRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");
process.stdout.write(`Package: ${tarball}\nSHA-256: ${hash}\n`);
