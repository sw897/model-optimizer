import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createZip, extractZip, fetchPinned, requireDiskSpace, sha256 } from "./native-assets.mjs";
import { runNpm } from "./npm.mjs";
import { inspectWindowsTree } from "./pe.mjs";
import { collectPortableNotices } from "./portable-notices.mjs";
import { verifyPortable } from "./verify-portable.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args[0] !== "--wine-image" || args.length !== 2)) throw new Error("Usage: npm run package:portable -- [--wine-image <local-image>]");
const wineImage = args[1];
await requireDiskSpace(root, 1024 * 1024 * 1024);
await runNpm(["run", "build"], root);
await runNpm(["run", "check:release"], root);
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const native = JSON.parse(await readFile(join(root, "native-tools.lock.json"), "utf8"));
const artifacts = join(root, "artifacts");
const cache = join(artifacts, "portable-cache");
const nodeArchive = await fetchPinned(native.node["windows-x64"], cache);
const staging = await mkdtemp(join(artifacts, "portable-"));
const name = `model-optimizer-${metadata.version}-windows-x64`;
const destination = join(staging, name);
const app = join(destination, "app");
try {
  await mkdir(app, { recursive: true });
  for (const entry of [...metadata.files, "package.json", "package-lock.json"]) await cp(join(root, entry), join(app, entry), { recursive: true });
  // Use target-platform prebuilt dependencies rather than copying native
  // modules (or executing installation hooks) from the build host.
  await runNpm(["ci", "--prefix", app, "--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64", "--no-audit", "--no-fund"], app);
  await rm(join(app, "node_modules/basisu"), { recursive: true, force: true });
  await rm(join(app, "node_modules/.bin"), { recursive: true, force: true });
  await extractZip(nodeArchive.bytes, staging, path => path === `node-v${native.node.version}-win-x64/node.exe` || path === `node-v${native.node.version}-win-x64/LICENSE`);
  await cp(join(staging, `node-v${native.node.version}-win-x64`), join(destination, "runtime"), { recursive: true });
  const goVersion = execFileSync("go", ["version"], { encoding: "utf8" }).trim();
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", join(destination, "model-opt-worker.exe"), join(root, "scripts/portable-launcher.go")], { cwd: root, env: { ...process.env, GOOS: "windows", GOARCH: "amd64", GOAMD64: "v1", CGO_ENABLED: "0", GOTOOLCHAIN: "local" }, stdio: "inherit" });
  await cp(join(destination, "model-opt-worker.exe"), join(destination, "model-lod-worker.exe"));
  await mkdir(join(app, "scripts"));
  for (const file of ["test-portable.mjs", "verify-portable.mjs", "pe.mjs"]) await cp(join(root, "scripts", file), join(app, "scripts", file));
  const packages = await collectPortableNotices(destination);
  const nativeFiles = await inspectWindowsTree(destination);
  const manifest = { schema: "model-optimizer.windows-portable", version: 1, packageVersion: metadata.version, target: "windows-x64", minimumWindows: native.basisu["windows-x64"].minimumWindows, node: { version: native.node.version, archiveSha256: native.node["windows-x64"].sha256, binarySha256: sha256(await readFile(join(destination, "runtime/node.exe"))) }, encoder: { version: native.basisu.version, ...native.basisu["windows-x64"], source: native.basisu.source, compiler: native.basisu.compiler }, launcher: { compiler: goVersion, GOOS: "windows", GOARCH: "amd64", GOAMD64: "v1", CGO_ENABLED: "0" }, nativeFiles, productionPackages: packages.map(({ name, version }) => ({ name, version })), validation: { static: "passed", execution: "not-run" } };
  await writeFile(join(destination, "portable-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyPortable(destination);
  await writeFile(join(destination, "使用说明.txt"), `Model Optimizer ${metadata.version} / Windows x64\r\n\r\n解压整个目录，保留 app 和 runtime。无需安装 Node.js、npm 或 Go。\r\n.\\model-opt-worker.exe --help\r\n.\\model-lod-worker.exe --help\r\n\r\nCPU Release 编码器，无需 OpenCL 或额外 VC++ DLL。最低 ${manifest.minimumWindows}。\r\n内置 Node.js ${native.node.version}。许可见 app/THIRD_PARTY_NOTICES.md 和 THIRD_PARTY_LICENSES.json。\r\n验证：.\\runtime\\node.exe .\\app\\scripts\\test-portable.mjs .\r\n`);
  const zip = join(artifacts, `${name}.zip`), candidate = join(staging, `${name}.zip`);
  await createZip(destination, candidate);
  const extraction = join(staging, "extracted 中文");
  await extractZip(await readFile(candidate), extraction);
  const extracted = join(extraction, name);
  await verifyPortable(extracted);
  if (process.platform === "win32" && process.arch === "x64") {
    execFileSync(join(extracted, "runtime/node.exe"), [join(extracted, "app/scripts/test-portable.mjs"), extracted], { stdio: "inherit" });
  } else if (wineImage) {
    const [image] = JSON.parse(execFileSync("docker", ["image", "inspect", wineImage], { encoding: "utf8" }));
    assert.equal(image.Os, "linux");
    assert.equal(image.Architecture, "amd64");
    manifest.validation.runner = { type: "wine", image: wineImage, imageId: image.Id };
    const windowsPath = path => {
      const rel = relative(root, path);
      assert.ok(!rel.startsWith(".."), "Wine test files must be inside the mounted checkout");
      return `Z:\\work\\${rel.replaceAll("/", "\\")}`;
    };
    const container = `model-optimizer-wine-${randomUUID()}`;
    try {
      execFileSync("docker", ["run", "--rm", "--name", container, "--network", "none", "--platform", "linux/amd64", "--cpus", "4", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256", "--log-driver", "json-file", "--log-opt", "max-size=16m", "--log-opt", "max-file=1", "-e", "LANG=C.UTF-8", "-e", "MODEL_OPTIMIZER_TEST_PLATFORM=wine", "-e", "WINEPREFIX=/tmp/model-optimizer-wine", "-v", `${root}:/work`, "-w", "/work", image.Id, windowsPath(join(extracted, "runtime/node.exe")), windowsPath(join(extracted, "app/scripts/test-portable.mjs")), windowsPath(extracted)], { stdio: "inherit", timeout: 600_000 });
    } finally {
      try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch { /* --rm may already have removed it. */ }
    }
  }
  let execution = "not-run";
  if (wineImage || (process.platform === "win32" && process.arch === "x64")) {
    const report = JSON.parse(await readFile(join(extracted, "validation-report.json"), "utf8"));
    assert.equal(report.status, "passed");
    assert.equal(report.packageVersion, metadata.version);
    assert.equal(report.encoderSha256, manifest.encoder.sha256);
    execution = process.platform === "win32" ? "native-windows" : "wine";
    assert.equal(report.environment, execution);
  }
  manifest.validation.execution = execution;
  await writeFile(join(extracted, "portable-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyPortable(extracted);
  await createZip(extracted, candidate);
  const hash = sha256(await readFile(candidate));
  await rename(candidate, zip);
  await writeFile(`${zip}.sha256`, `${hash}  ${name}.zip\n`);
  await writeFile(`${zip}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Portable ZIP: ${zip}\nSHA-256: ${hash}\nStatic validation: passed; execution: ${execution}.`);
} finally { await rm(staging, { recursive: true, force: true }); }
