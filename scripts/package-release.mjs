import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(projectRoot, "artifacts");

await mkdir(artifactRoot, { recursive: true });
for (const entry of await readdir(artifactRoot)) {
  if (entry.endsWith(".tgz") || entry === "SHA256SUMS") await rm(join(artifactRoot, entry), { force: true });
}

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--pack-destination", artifactRoot], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`npm pack exited with ${code}`))));
});

const tarballs = (await readdir(artifactRoot)).filter((entry) => entry.endsWith(".tgz")).sort();
if (tarballs.length !== 1) throw new Error(`expected one package artifact, found ${tarballs.length}`);
const tarball = join(artifactRoot, tarballs[0]);
const hash = createHash("sha256").update(await readFile(tarball)).digest("hex");
await writeFile(join(artifactRoot, "SHA256SUMS"), `${hash}  ${basename(tarball)}\n`, "utf8");
process.stdout.write(`Package: ${tarball}\nSHA-256: ${hash}\n`);
