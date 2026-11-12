import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inspectPE, isWindowsSystemDLL } from "./pe.mjs";

const readJSON = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const metadata = await readJSON("package.json");
const toolchain = await readJSON("toolchain.lock.json");
const lock = await readJSON("package-lock.json");
const nativeTools = await readJSON("native-tools.lock.json");

assert.equal(metadata.license, "Apache-2.0");
assert.equal(metadata.name, "model-optimizer");
assert.equal(lock.name, metadata.name);
assert.equal(lock.packages[""].name, metadata.name);
assert.equal(toolchain.worker, metadata.name);
assert.equal(toolchain.workerVersion, metadata.version);
assert.equal(toolchain.node, metadata.engines.node);
assert.deepEqual(toolchain.packages, metadata.dependencies);
assert.equal(lock.version, metadata.version);
assert.equal(lock.packages[""].version, metadata.version);
assert.deepEqual(lock.packages[""].dependencies, metadata.dependencies);
assert.deepEqual(lock.packages[""].devDependencies, metadata.devDependencies);
assert.equal(nativeTools.basisu.version, metadata.dependencies.basisu);
const encoder = nativeTools.basisu["windows-x64"];
const binary = await readFile(new URL(`../${encoder.path}`, import.meta.url));
assert.equal(createHash("sha256").update(binary).digest("hex"), encoder.sha256, "Unreviewed Windows encoder");
assert.ok(binary.includes(Buffer.from("UTF-8</activeCodePage>")), "Windows encoder must declare its UTF-8 process code page");
const pe = inspectPE(binary, encoder.path);
assert.ok([...pe.imports, ...pe.delayImports].every(isWindowsSystemDLL), "Release encoder requires non-system DLLs");
for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md", "README.zh-CN.md", "docs/input-specification.md", "docs/releasing.md"]) {
  assert.ok((await readFile(new URL(`../${file}`, import.meta.url), "utf8")).trim(), `Missing release document: ${file}`);
}
for (const entry of ["cli.js", "opt-cli.js"]) {
  assert.ok((await readFile(new URL(`../dist/${entry}`, import.meta.url), "utf8")).startsWith("#!/usr/bin/env node"));
}
console.log(`Release metadata verified: ${metadata.name}@${metadata.version}; npm publication is ${metadata.private ? "locked" : "enabled"}.`);
