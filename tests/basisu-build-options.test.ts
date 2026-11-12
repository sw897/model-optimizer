import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { basisuReleaseFlags, cmakeLiteral, compilerArgument } from "../scripts/basisu-build-options.mjs";

const canBuild = process.platform !== "win32" && spawnSync("cmake", ["--version"]).status === 0 && spawnSync("c++", ["--version"]).status === 0;

it.skipIf(!canBuild)("compiles and links through CMake with Unicode/spaced source and object paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "basisu source 空格 "));
  const run = (file: string, args: string[]) => {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };
  try {
    const object = join(root, "linked object.o");
    await writeFile(join(root, "linked.cpp"), "int linkedValue() { return 42; }\n");
    run("c++", ["-c", join(root, "linked.cpp"), "-o", object]);
    await writeFile(join(root, "main.cpp"), "#include <cstdio>\nextern int linkedValue();\nint main() { puts(__FILE__); return linkedValue() == 42 ? 0 : 1; }\n");
    await writeFile(join(root, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.16)\nproject(flag_probe CXX)\nset(LITERAL ${cmakeLiteral(root)})\nadd_executable(flag_probe \"\${LITERAL}/main.cpp\")\n`);
    run("cmake", ["-S", root, "-B", join(root, "build"), "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_CXX_FLAGS_RELEASE=${basisuReleaseFlags(root)}`, `-DCMAKE_EXE_LINKER_FLAGS=${compilerArgument(object)}`]);
    run("cmake", ["--build", join(root, "build")]);
    expect(run(join(root, "build/flag_probe"), []).trim()).toBe("basis_universal/main.cpp");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
