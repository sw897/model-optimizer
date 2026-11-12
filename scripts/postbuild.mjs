import { chmod } from "node:fs/promises";

if (process.platform !== "win32") {
  for (const entry of ["cli.js", "opt-cli.js"]) {
    await chmod(new URL(`../dist/${entry}`, import.meta.url), 0o755);
  }
}
