import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPinned, requireDiskSpace, sha256 } from "./native-assets.mjs";
import { inspectPE, isWindowsSystemDLL } from "./pe.mjs";
import { basisuReleaseFlags, cmakeLiteral, compilerArgument } from "./basisu-build-options.mjs";

if (process.platform !== "darwin") throw new Error("The pinned compiler archive is for macOS; see docs/windows-portable.md for the build recipe.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(join(root, "native-tools.lock.json"), "utf8"));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--cache-dir")) throw new Error("Usage: npm run build:encoder:windows -- [--cache-dir <directory>]");
const cache = args.length ? resolve(args[1]) : join(root, "artifacts/portable-cache");
await mkdir(cache, { recursive: true });
await requireDiskSpace(cache, 1536 * 1024 * 1024);
const source = join(cache, "encoder-source"), compiler = join(cache, "encoder-compiler"), build = join(cache, "encoder-build");
const [sourceArchive, compilerArchive] = await Promise.all([fetchPinned(lock.basisu.source, cache), fetchPinned(lock.basisu.compiler, cache)]);
for (const [archive, target] of [[sourceArchive, source], [compilerArchive, compiler]]) {
  await mkdir(target, { recursive: true });
  execFileSync("tar", ["-xf", archive.path, "--strip-components=1", "-C", target]);
}
const toolchain = join(cache, "encoder-windows-x64.cmake");
await writeFile(toolchain, `set(CMAKE_SYSTEM_NAME Windows)\nset(CMAKE_SYSTEM_PROCESSOR AMD64)\nset(CMAKE_C_COMPILER ${cmakeLiteral(`${compiler}/bin/x86_64-w64-mingw32-clang`)})\nset(CMAKE_CXX_COMPILER ${cmakeLiteral(`${compiler}/bin/x86_64-w64-mingw32-clang++`)})\nset(CMAKE_RC_COMPILER ${cmakeLiteral(`${compiler}/bin/x86_64-w64-mingw32-windres`)})\nset(CMAKE_FIND_ROOT_PATH ${cmakeLiteral(`${compiler}/x86_64-w64-mingw32`)})\nset(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)\nset(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)\n`);
const flags = basisuReleaseFlags(source);
const resourceSource = join(cache, "encoder-manifest.rc"), resource = join(cache, "encoder-manifest.obj");
assert.equal(sha256(await readFile(join(root, "scripts/basisu.manifest"))), lock.basisu["windows-x64"].processManifestSha256, "Unreviewed process manifest");
await writeFile(resourceSource, `1 24 ${JSON.stringify(join(root, "scripts/basisu.manifest"))}\n`);
execFileSync(join(compiler, "bin/x86_64-w64-mingw32-windres"), ["--input", resourceSource, "--output", resource, "--output-format=coff"]);
const configure = ["-S", source, "-B", build, `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_BUILD_TYPE=Release", "-DSTATIC=ON", "-DSSE=OFF", "-DOPENCL=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_OpenCL=ON", "-DZSTD=ON", `-DCMAKE_C_FLAGS_RELEASE=${flags}`, `-DCMAKE_CXX_FLAGS_RELEASE=${flags}`, `-DCMAKE_EXE_LINKER_FLAGS=${compilerArgument(resource)}`, "-DGCC_LINK_FLAGS=-Wl,--no-insert-timestamp -Wl,-s"];
const logPath = join(cache, "encoder-build.log");
const log = openSync(logPath, "w");
try {
  execFileSync("cmake", configure, { stdio: ["ignore", log, log] });
  execFileSync("cmake", ["--build", build, "--parallel", "6"], { stdio: ["ignore", log, log] });
} catch (error) {
  console.error(`Compiler log: ${logPath}\n${(await readFile(logPath, "utf8")).slice(-4000)}`);
  throw error;
} finally { closeSync(log); }
const binaryPath = join(source, "bin/basisu.exe"), binary = await readFile(binaryPath);
assert.equal(sha256(binary), lock.basisu["windows-x64"].sha256, "Rebuild differs from the reviewed encoder; do not overwrite the lock without review");
const pe = inspectPE(binary, binaryPath);
assert.ok([...pe.imports, ...pe.delayImports].every(isWindowsSystemDLL));
await cp(binaryPath, join(root, lock.basisu["windows-x64"].path));
console.log(`Reproduced reviewed Release encoder: ${sha256(binary)}; system DLLs only. Log: ${logPath}`);
