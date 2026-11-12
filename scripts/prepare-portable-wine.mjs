import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPinned, requireDiskSpace, sha256 } from "./native-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { image: "model-optimizer-wine:local" };
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift(), value = args.shift();
  if (!["--base-image", "--image"].includes(flag) || !value || value.startsWith("--")) {
    throw new Error("Usage: npm run prepare:wine -- [--base-image <existing-local-image>] [--image <local-image>]");
  }
  options[flag === "--image" ? "image" : "baseImage"] = value;
}
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 600_000 }).trim();
const architecture = docker(["info", "--format", "{{.Architecture}}"]);
assert.ok(["arm64", "aarch64", "amd64", "x86_64"].includes(architecture), `Unsupported Docker architecture: ${architecture}`);
assert.notEqual(process.platform, "win32", "Use native Windows verification; this optional Wine preparation uses Unix ar/tar tools.");
const cache = join(root, "artifacts/portable-cache");
await requireDiskSpace(root, 1024 * 1024 * 1024);
await mkdir(cache, { recursive: true });
const baseImage = options.baseImage ?? "model-optimizer-wine-base:local";
if (!options.baseImage) {
  const context = await mkdtemp(join(cache, "wine-base-"));
  try {
    await mkdir(join(context, "scripts"));
    for (const file of ["portable-wine.Dockerfile", "portable-wine-entrypoint.sh"]) await cp(join(root, "scripts", file), join(context, "scripts", file));
    execFileSync("docker", ["build", "--platform", "linux/amd64", "-f", join(context, "scripts/portable-wine.Dockerfile"), "-t", baseImage, context], { stdio: "inherit", timeout: 600_000 });
  } finally { await rm(context, { recursive: true, force: true }); }
}
const [base] = JSON.parse(docker(["image", "inspect", baseImage]));
assert.equal(base.Os, "linux");
assert.equal(base.Architecture, "amd64");
const runner = {
  schema: "model-optimizer.wine-runner", version: 1,
  dockerArchitecture: architecture, baseImageId: base.Id,
  wineVersion: docker(["run", "--rm", "--network", "none", "--platform", "linux/amd64", "--entrypoint", "dpkg-query", baseImage, "-W", "-f=${Version}", "wine64"]),
};
if (["arm64", "aarch64"].includes(architecture)) {
  const lock = JSON.parse(await readFile(join(root, "scripts/portable-wine.lock.json"), "utf8"));
  const archive = await fetchPinned(lock.qemu, cache);
  const staging = await mkdtemp(join(cache, "wine-runner-"));
  try {
    // Both the Debian archive and the extracted static ARM64 binary are pinned.
    const data = execFileSync("ar", ["p", archive.path, "data.tar.xz"], { maxBuffer: 128 << 20 });
    await writeFile(join(staging, "data.tar.xz"), data);
    execFileSync("tar", ["xf", join(staging, "data.tar.xz"), "-C", staging, "./usr/bin/qemu-x86_64"]);
    const binary = await readFile(join(staging, "usr/bin/qemu-x86_64"));
    assert.equal(sha256(binary), lock.qemu.binarySha256, "Extracted QEMU binary SHA-256 mismatch");
    await writeFile(join(staging, "qemu-x86_64-static"), binary);
    runner.qemu = lock.qemu;
    await writeFile(join(staging, "runner.json"), `${JSON.stringify(runner, null, 2)}\n`);
    for (const file of ["portable-wine-qemu.Dockerfile", "portable-wine-loader.sh", "portable-wine-entrypoint.sh"]) {
      await cp(join(root, "scripts", file), join(staging, file));
    }
    // Exclude extraction intermediates from the image build context.
    await writeFile(join(staging, ".dockerignore"), "data.tar.xz\nusr/\n");
    execFileSync("docker", ["build", "--platform", "linux/amd64", "--build-arg", `BASE_IMAGE=${baseImage}`, "-f", join(staging, "portable-wine-qemu.Dockerfile"), "-t", options.image, staging], { stdio: "inherit", timeout: 600_000 });
  } finally { await rm(staging, { recursive: true, force: true }); }
} else {
  docker(["tag", baseImage, options.image]);
}
runner.image = options.image;
runner.imageId = JSON.parse(docker(["image", "inspect", options.image]))[0].Id;
await writeFile(join(cache, "wine-runner.json"), `${JSON.stringify(runner, null, 2)}\n`);
console.log(`Local Wine runner: ${runner.image}\n${runner.imageId}\nWine ${runner.wineVersion}${runner.qemu ? `; QEMU ${runner.qemu.version}, CPU ${runner.qemu.cpu}` : ""}\nUse: npm run package:portable -- --wine-image ${runner.image}`);
