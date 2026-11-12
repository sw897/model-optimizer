import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractZip } from "./native-assets.mjs";
import { verifyPortable } from "./verify-portable.mjs";
import { assertReleaseReady } from "./portable-redistribution.mjs";

const args = process.argv.slice(2);
const releaseReady = args.includes("--require-release-ready");
const paths = args.filter(arg => arg !== "--require-release-ready");
if (paths.length !== 1 || paths[0].startsWith("--")) throw new Error("Usage: npm run check:portable -- <directory-or-zip> [--require-release-ready]");
const input = resolve(paths[0]);
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
  if (releaseReady) assertReleaseReady(result.manifest);
  console.log(`Portable static validation passed: ${result.manifest.packageVersion}; ${result.nativeFiles} x64 PE files; resolved DLL imports; no debug runtimes.`);
  console.log(`Native source materials: ${result.manifest.redistribution?.status ?? "not recorded"}; execution: ${result.manifest.validation.execution}.`);
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
