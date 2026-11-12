import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertRedistributableTree } from "../scripts/redistribution.mjs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "redistribution-"));
  roots.push(root);
  await mkdir(join(root, "encoder"));
  return root;
};

it("rejects nested Microsoft debug runtime DLLs, including case variants", async () => {
  const root = await fixture();
  for (const name of ["ucrtbased.dll", "VCRUNTIME140_1D.DLL", "msvcp140d.dll", "concrt140d.dll"]) {
    const path = join(root, "encoder", name);
    await writeFile(path, "test fixture");
    await expect(assertRedistributableTree(root)).rejects.toThrow("Non-redistributable Microsoft debug runtime");
    await rm(path);
  }
});

it("accepts a regular dependency tree with release runtime names", async () => {
  const root = await fixture();
  for (const name of ["basisu.exe", "ucrtbase.dll", "vcruntime140.dll", "LICENSE"]) await writeFile(join(root, "encoder", name), "test fixture");
  await expect(assertRedistributableTree(root)).resolves.toBeUndefined();
});

it("rejects symlinks rather than allowing uninspected files into a portable tree", async () => {
  const root = await fixture();
  const outside = join(root, "outside.dll");
  await writeFile(outside, "test fixture");
  await symlink(outside, join(root, "encoder", "linked.dll"));
  await expect(assertRedistributableTree(root)).rejects.toThrow("must not contain symlinks");
});
