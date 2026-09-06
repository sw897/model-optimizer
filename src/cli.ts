#!/usr/bin/env node

import { runWorker } from "./worker.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CLIOptions } from "./types.js";

const VERSION = "0.2.0";

export function parseCLI(argv: string[]): CLIOptions {
  const values: Record<string, string | boolean | undefined> = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      values.help = true;
      index += 1;
      continue;
    }
    if (token === "--version") {
      values.version = true;
      index += 1;
      continue;
    }
    if (token === "--json") {
      values.json = true;
      index += 1;
      continue;
    }
    if (token === "--verbose" || token === "-v") {
      values.verbose = true;
      index += 1;
      continue;
    }
    if (token === "--resume") {
      values.resume = true;
      index += 1;
      continue;
    }
    const equal = token.indexOf("=");
    const name = equal >= 0 ? token.slice(0, equal) : token;
    const inlineValue = equal >= 0 ? token.slice(equal + 1) : undefined;
    if (!["--input", "-i", "--output", "-o", "--preset", "--max-level", "--report"].includes(name)) {
      throw new Error(`unknown option ${name}`);
    }
    const key = name === "-i" ? "input" : name === "-o" ? "output" : name.slice(2).replaceAll("-", "");
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
    values[key] = value;
    index += inlineValue === undefined ? 2 : 1;
  }

  const options: CLIOptions = {
    input: requireString(values.input, "--input"),
    output: requireString(values.output, "--output"),
    preset: typeof values.preset === "string" ? values.preset : "tower-v1",
    maxLevel: parseMaxLevel(values.maxlevel),
    json: values.json === true,
    verbose: values.verbose === true,
    resume: values.resume === true,
    help: values.help === true,
    version: values.version === true,
  };
  if (typeof values.report === "string") options.report = values.report;
  return options;
}

export function helpText(): string {
  return `model-lod-worker ${VERSION}

Stage-2 LOD worker for model canonical lod-input output.

Usage:
  model-lod-worker --input <lod-input-root> --output <lod-stage-root> [options]

Options:
  -i, --input <path>       Stage-1 canonical scene root (required)
  -o, --output <path>      Empty stage-2 output root (required)
      --preset <name>      tower-v1, span-v1, or lod0-only (default: tower-v1)
      --max-level <N>      Highest LOD level to generate (default: 1; 0 copies/validates LOD0)
      --report <path>      Report path relative to output root (default: lod-worker-report.json)
      --json               Print the final report as JSON
  -v, --verbose            Print per-prototype progress
      --resume             Reuse a preserved stage-2 work directory after interruption
  -h, --help               Show this help
      --version            Show the version
`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    const options = parseCLI(argv);
    const report = await runWorker(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `model-lod-worker completed: preset=${report.preset} prototypes=${report.prototypes.length} max-level=${report.maxLevel}\n`,
      );
      if (options.verbose) {
        for (const prototype of report.prototypes) {
          process.stdout.write(`  ${prototype.prototypeId}: ${prototype.status} lods=${prototype.lods.length}\n`);
        }
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = (error as { report?: unknown }).report;
    if (report && argv.includes("--json")) process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`model-lod-worker failed: ${message}\n`);
    return 1;
  }
}

function requireString(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseMaxLevel(value: string | boolean | undefined): number {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("--max-level must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("--max-level is too large");
  return parsed;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
