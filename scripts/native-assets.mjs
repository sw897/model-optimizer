import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function requireDiskSpace(path, bytes) {
  const info = await statfs(path);
  const available = info.bavail * info.bsize;
  if (available < bytes) throw new Error(`Insufficient build space: need ${Math.ceil(bytes / 1024 / 1024)} MiB, found ${Math.floor(available / 1024 / 1024)} MiB. Remove only disposable build caches before retrying.`);
}

export async function fetchPinned(asset, cache) {
  await mkdir(cache, { recursive: true });
  const target = join(cache, `${asset.sha256}-${basename(new URL(asset.url).pathname)}`);
  let bytes;
  try { bytes = await readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!bytes) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Asset download failed (${response.status}): ${asset.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== asset.sha256) throw new Error(`Asset SHA-256 mismatch: ${asset.url}`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
  if (sha256(bytes) !== asset.sha256) throw new Error(`Cached asset SHA-256 mismatch: ${target}`);
  return { path: target, bytes };
}

function safeZipName(name) {
  if (!name || /[\\:\u0000]/.test(name) || name.startsWith("/") || name.split("/").some(part => part === "." || part === "..")) {
    throw new Error(`Unsafe ZIP path: ${name}`);
  }
  return name;
}

export async function extractZip(bytes, root, select = () => true) {
  const seen = new Set();
  let totalSize = 0;
  const entries = unzipSync(bytes, { filter: file => {
    safeZipName(file.name);
    const key = file.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Conflicting Windows ZIP path: ${file.name}`);
    seen.add(key);
    totalSize += file.originalSize;
    if (totalSize > 1024 * 1024 * 1024 || seen.size > 100_000) throw new Error("ZIP exceeds extraction limits");
    if (file.originalSize > 512 * 1024 * 1024) throw new Error("ZIP entry exceeds extraction limit");
    return select(file.name);
  } });
  for (const [name, data] of Object.entries(entries)) {
    const target = join(root, safeZipName(name));
    if (name.endsWith("/")) await mkdir(target, { recursive: true });
    else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, data); }
  }
}

export async function createZip(directory, target) {
  const files = {};
  const visit = async (root, relative = "") => {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(root, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Cannot archive symlink: ${path}`);
      if (entry.isDirectory()) await visit(path, name);
      else files[safeZipName(`${basename(directory)}/${name}`)] = [new Uint8Array(await readFile(path)), { mtime: new Date(1980, 0, 1) }];
    }
  };
  await visit(resolve(directory));
  const bytes = zipSync(files, { level: 6 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
