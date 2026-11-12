import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractZip } from "./native-assets.mjs";
import { verifyPortable } from "./verify-portable.mjs";

if (!process.argv[2]) throw new Error("Usage: npm run check:portable -- <directory-or-zip>");
const input = resolve(process.argv[2]);
let temporary;
try {
  let root = input;
  if ((await stat(input)).isFile()) {
    temporary = await mkdtemp(join(tmpdir(), "model-optimizer-zip-"));
    await extractZip(await readFile(input), temporary);
    const entries = await readdir(temporary, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error("Expected one portable root directory in ZIP");
    root = join(temporary, entries[0].name);
  }
  const result = await verifyPortable(root);
  console.log(`Portable static validation passed: ${result.manifest.packageVersion}; ${result.nativeFiles} x64 PE files; resolved DLL imports; no debug runtimes.`);
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
