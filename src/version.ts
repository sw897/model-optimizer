import { readFileSync } from "node:fs";

// Both src/ and dist/ are one directory below the installed package metadata.
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};

export const VERSION = metadata.version;
export const DEPENDENCIES = metadata.dependencies;
