import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDebugRuntime } from "./pe.mjs";

// Check before staging so an unsafe directory/ZIP cannot be produced accidentally.
export async function assertRedistributableTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Portable dependencies must not contain symlinks: ${path}`);
    if (isDebugRuntime(entry.name)) {
      throw new Error(`Non-redistributable Microsoft debug runtime: ${path}. Use a reviewed Release build of the encoder; see docs/releasing.md.`);
    }
    if (entry.isDirectory()) await assertRedistributableTree(path);
  }
}
