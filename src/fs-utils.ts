import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return hash.digest("hex");
}

export async function sha256Buffer(data: Uint8Array): Promise<string> {
  return createHash("sha256").update(data).digest("hex");
}

export async function hashDirectory(root: string, excluded: string[] = []): Promise<string> {
  const excludedSet = new Set(excluded.map((entry) => entry.replaceAll("\\", "/")));
  const files: string[] = [];
  await collectFiles(resolve(root), files);
  files.sort((left, right) => toSlash(relative(resolve(root), left)).localeCompare(toSlash(relative(resolve(root), right))));
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = toSlash(relative(resolve(root), file));
    if (excludedSet.has(relativePath)) continue;
    hash.update(`${relativePath}\n${await sha256File(file)}\n`);
  }
  return hash.digest("hex");
}

async function collectFiles(root: string, files: string[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) await collectFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function toSlash(path: string): string {
  return path.split(sep).join("/");
}

export async function readJSON<T>(path: string): Promise<T> {
  const data = await readFile(path, "utf8");
  try {
    return JSON.parse(data) as T;
  } catch (error) {
    throw new Error(`invalid JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeJSONAtomic(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectoryEmpty(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const entries = await (await import("node:fs/promises")).readdir(path);
  if (entries.length > 0) throw new Error(`output directory must be empty: ${path}`);
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

export async function copyFileChecked(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export function safeRelativePath(root: string, candidate: string): string {
  if (!candidate || isAbsolute(candidate)) {
    throw new Error(`asset path must be relative: ${candidate || "<empty>"}`);
  }
  const normalized = candidate.replaceAll("\\", "/");
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, normalized);
  const rel = relative(resolvedRoot, resolved);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`asset path escapes scene root: ${candidate}`);
  }
  return rel.split(sep).join("/");
}

export function resolveSafe(root: string, candidate: string): string {
  return resolve(root, safeRelativePath(root, candidate));
}

export function assertDifferentRoots(input: string, output: string): void {
  const inputRoot = resolve(input);
  const outputRoot = resolve(output);
  const rel = relative(inputRoot, outputRoot);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    throw new Error("output directory must be outside input directory");
  }
}

export async function createTemporarySibling(outputRoot: string): Promise<string> {
  const temporary = `${outputRoot}.tmp-${process.pid}-${Date.now()}`;
  await removeIfExists(temporary);
  await mkdir(temporary, { recursive: true });
  return temporary;
}

export async function commitDirectory(temporary: string, outputRoot: string): Promise<void> {
  await mkdir(dirname(outputRoot), { recursive: true });
  await rename(temporary, outputRoot);
}

export async function readFirstBytes(path: string, length: number): Promise<Buffer> {
  const handle = await (await import("node:fs/promises")).open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
