import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const comparePaths = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function portablePath(root, path) {
  assert.ok(typeof path === "string" && path.length && !/[\\:\u0000]/.test(path) && !path.startsWith("/") && !path.split("/").some(part => !part || part === "." || part === ".."), `Unsafe inventory path: ${path}`);
  return join(root, ...path.split("/"));
}

export async function fileRecord(root, path) {
  const target = portablePath(root, path);
  assert.ok((await lstat(target)).isFile(), `Expected regular portable file: ${path}`);
  const bytes = await readFile(target);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function inventoryTree(root, path) {
  const records = [];
  const visit = async directory => {
    for (const entry of await readdir(portablePath(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else records.push(await fileRecord(root, name));
    }
  };
  await visit(path);
  return records.sort(comparePaths);
}

export async function verifyFileRecord(root, record) {
  assert.ok(record && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && /^[a-f\d]{64}$/.test(record.sha256), "Invalid file digest record");
  assert.deepEqual(await fileRecord(root, record.path), record, `Portable file changed: ${record.path}`);
}
