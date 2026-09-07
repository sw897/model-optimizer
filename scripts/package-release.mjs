import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(projectRoot, "artifacts");

await mkdir(artifactRoot, { recursive: true });
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const packageFilename = `${packageMetadata.name.replace(/^@/, "").replaceAll("/", "-")}-${packageMetadata.version}.tgz`;

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--pack-destination", artifactRoot], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`npm pack exited with ${code}`))));
});

const tarball = join(artifactRoot, packageFilename);
const hash = createHash("sha256").update(await readFile(tarball)).digest("hex");
const checksums = [];
for (const entry of (await readdir(artifactRoot)).filter(entry => entry.endsWith(".tgz")).sort()) {
  checksums.push(`${createHash("sha256").update(await readFile(join(artifactRoot, entry))).digest("hex")}  ${entry}`);
}
await writeFile(join(artifactRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");
process.stdout.write(`Package: ${tarball}\nSHA-256: ${hash}\n`);
