import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

export const isDebugRuntime = name => /^(?:ucrtbased|vcruntime\d+(?:_\d+)?d|msvc[pr]\d+(?:_\d+)?d|concrt\d+d)\.dll$/i.test(name);

// Parse normal AND delayed imports. Checking DLL filenames alone misses an
// executable whose debug runtime was deleted from the distribution.
export function inspectPE(bytes, label = "PE file") {
  const fail = message => { throw new Error(`${label}: ${message}`); };
  const range = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) fail("invalid PE range");
    return offset;
  };
  const u16 = offset => bytes.readUInt16LE(range(offset, 2));
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  if (u16(0) !== 0x5a4d) fail("missing MZ header");
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) fail("missing PE signature");
  if (u16(pe + 4) !== 0x8664) fail("expected Windows x64 machine type");
  const count = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24;
  if (!count || count > 96 || optionalSize < 240 || u16(optional) !== 0x20b) fail("expected PE32+ optional header");
  range(optional, optionalSize + count * 40);
  if (u32(optional + 108) < 14) fail("missing PE data directories");
  const sections = Array.from({ length: count }, (_, index) => {
    const at = optional + optionalSize + index * 40;
    return { rva: u32(at + 12), size: u32(at + 16), offset: u32(at + 20) };
  });
  const fileOffset = rva => {
    if (rva < u32(optional + 60)) return range(rva, 1);
    const section = sections.find(s => rva >= s.rva && rva - s.rva < s.size);
    if (!section) fail("unmapped PE RVA");
    return range(section.offset + rva - section.rva, 1);
  };
  const dllName = rva => {
    const start = fileOffset(rva), end = bytes.indexOf(0, start);
    if (end < start || end - start > 255) fail("invalid DLL name");
    const name = bytes.subarray(start, end).toString("ascii");
    if (!/^[a-z\d_.-]+\.(?:dll|drv|exe)$/i.test(name)) fail("invalid DLL name");
    if (isDebugRuntime(name)) fail(`non-redistributable debug runtime import: ${name}`);
    return name;
  };
  const directory = (index, stride, delayed) => {
    const rva = u32(optional + 112 + index * 8), size = u32(optional + 116 + index * 8);
    if (!rva && !size) return [];
    if (!rva || size < stride) fail("invalid import directory");
    const at = fileOffset(rva), names = [];
    range(at, size);
    for (let offset = 0; offset + stride <= size; offset += stride) {
      const record = bytes.subarray(at + offset, at + offset + stride);
      if (record.every(value => value === 0)) return [...new Set(names)].sort();
      if (delayed && !(u32(at + offset) & 1)) fail("unsupported VA-based delay import");
      names.push(dllName(u32(at + offset + (delayed ? 4 : 12))));
    }
    fail("unterminated import directory");
  };
  return { machine: "x64", timestamp: u32(pe + 8), imports: directory(1, 20, false), delayImports: directory(13, 32, true) };
}

const systemDLLs = new Set([
  "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cabinet.dll", "comctl32.dll", "comdlg32.dll", "crypt32.dll", "dbghelp.dll", "dnsapi.dll", "dwmapi.dll", "gdi32.dll", "imm32.dll", "iphlpapi.dll", "kernel32.dll", "kernelbase.dll", "mpr.dll", "msimg32.dll", "msvcrt.dll", "netapi32.dll", "normaliz.dll", "ntdll.dll", "ole32.dll", "oleaut32.dll", "powrprof.dll", "psapi.dll", "rpcrt4.dll", "secur32.dll", "setupapi.dll", "shell32.dll", "shlwapi.dll", "ucrtbase.dll", "user32.dll", "userenv.dll", "usp10.dll", "version.dll", "winhttp.dll", "winmm.dll", "winspool.drv", "wintrust.dll", "ws2_32.dll", "wtsapi32.dll"
]);
export const isWindowsSystemDLL = name => systemDLLs.has(name.toLowerCase()) || /^(?:api|ext)-ms-win-[a-z\d-]+\.dll$/i.test(name);

export async function inspectWindowsTree(root) {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Portable files must not contain symlinks: ${path}`);
      if (isDebugRuntime(entry.name)) throw new Error(`Non-redistributable Microsoft debug runtime: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:exe|dll|node)$/i.test(entry.name)) {
        const bytes = await readFile(path);
        files.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex"), ...inspectPE(bytes, path) });
      }
    }
  };
  await visit(root);
  for (const file of files) for (const name of [...file.imports, ...file.delayImports]) {
    // Native codec DLLs must be adjacent to their dependent module. System
    // API sets are resolved by Windows 10/11, not bundled from the build host.
    const directory = file.path.slice(0, file.path.lastIndexOf("/") + 1);
    const nodeHost = name.toLowerCase() === "node.exe" && files.some(other => other.path === "runtime/node.exe");
    if (!nodeHost && !isWindowsSystemDLL(name) && !files.some(other => other.path.toLowerCase() === `${directory}${name}`.toLowerCase())) {
      throw new Error(`Unresolved portable DLL dependency: ${file.path} -> ${name}`);
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
