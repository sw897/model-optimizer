import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build this package on Windows x64.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const staging = await mkdtemp(join(artifacts, "portable-"));
const name = `model-optimizer-${metadata.version}-windows-x64`;
const destination = join(staging, name);
await mkdir(join(destination, "runtime"), { recursive: true });
await mkdir(join(destination, "app"), { recursive: true });
await cp(process.execPath, join(destination, "runtime", "node.exe"));
await cp(join(dirname(process.execPath), "LICENSE"), join(destination, "runtime", "LICENSE"));
for (const entry of ["dist", "schemas", "package.json", "toolchain.lock.json", "README.md"]) {
  await cp(join(root, entry), join(destination, "app", entry), { recursive: true });
}
const packages = execFileSync("npm.cmd", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, shell: true, encoding: "utf8" });
for (const source of new Set(packages.trim().split(/\r?\n/).slice(1))) {
  const path = relative(root, source);
  if (!path.startsWith("node_modules\\") || path.includes("..")) throw new Error(`Unexpected dependency path: ${source}`);
  await cp(source, join(destination, "app", path), { recursive: true });
}
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", join(destination, "model-opt-worker.exe"), join(root, "scripts", "portable-launcher.go")], { cwd: root, stdio: "inherit" });
await cp(join(destination, "model-opt-worker.exe"), join(destination, "model-lod-worker.exe"));
await writeFile(join(destination, "使用说明.txt"), `Model Optimizer ${metadata.version} / Windows x64\r\n\r\n解压整个目录，无需安装 Node.js、npm 或 Go。请保留 app 和 runtime 目录。\r\n在 PowerShell 中执行：\r\n.\\model-opt-worker.exe --help\r\n.\\model-opt-worker.exe -i "D:\\models" -o "D:\\models-web" --json\r\n.\\model-lod-worker.exe --help\r\n\r\n内置 Node.js ${process.version}。详细参数见 app/README.md。\r\n`);
const zip = join(artifacts, `${name}.zip`);
const quote = value => `'${value.replaceAll("'", "''")}'`;
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath ${quote(destination)} -DestinationPath ${quote(zip)} -Force`], { stdio: "inherit" });
const hash = createHash("sha256").update(await readFile(zip)).digest("hex");
await writeFile(`${zip}.sha256`, `${hash}  ${name}.zip\n`);
process.stdout.write(`Portable directory: ${destination}\nPackage: ${zip}\nSHA-256: ${hash}\n`);
