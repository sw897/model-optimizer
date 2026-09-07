#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runOptimizer, OPTIMIZER_VERSION, OPTIMIZATION_PROFILE } from "./optimizer.js";
import type { OptimizationCLIOptions } from "./types.js";

export function parseOptimizationCLI(argv: string[]): OptimizationCLIOptions {
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
    const equal = token.indexOf("=");
    const name = equal >= 0 ? token.slice(0, equal) : token;
    const inlineValue = equal >= 0 ? token.slice(equal + 1) : undefined;
    if (!["--input", "-i", "--output", "-o"].includes(name)) throw new Error(`unknown option ${name}`);
    const key = name === "-i" ? "input" : name === "-o" ? "output" : name.slice(2);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
    values[key] = value;
    index += inlineValue === undefined ? 2 : 1;
  }
  return {
    input: requireString(values.input, "--input"),
    output: requireString(values.output, "--output"),
    json: values.json === true,
    verbose: values.verbose === true,
    help: values.help === true,
    version: values.version === true,
  };
}

export function optimizationHelpText(): string {
  return `model-opt-worker ${OPTIMIZER_VERSION}

Standard 3D Tiles resource-graph optimizer for lod-input or runtime assembly output.
The web-v1 profile is fixed: lossless Meshopt buffers and BasisU/KTX2 material textures.

Usage:
  model-opt-worker --input <tileset-directory> --output <optimized-directory> [options]

Options:
  -i, --input <path>       Stage-1 or Stage-3 tileset directory (required)
  -o, --output <path>      Empty optimized scene root (required)
      --json               Print the final report as JSON
  -v, --verbose            Print per-asset progress
  -h, --help               Show this help
      --version            Show the version
`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(optimizationHelpText());
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${OPTIMIZER_VERSION}\n`);
    return 0;
  }
  try {
    const options = parseOptimizationCLI(argv);
    const report = await runOptimizer(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `model-opt-worker completed: profile=${OPTIMIZATION_PROFILE} assets=${report.assets.length} output-scene=${report.outputSceneHash}\n`,
      );
      if (report.preservedExtensions?.length) process.stdout.write(`  feature metadata validated and preserved: ${report.preservedExtensions.join(", ")}\n`);
      if (options.verbose) {
        for (const asset of report.assets) {
          const label = asset.level === 0 ? "base" : `LOD${asset.level}`;
          process.stdout.write(`  ${asset.prototypeId} ${label}: ${asset.sourceBytes} -> ${asset.outputBytes} bytes\n`);
        }
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = (error as { report?: unknown }).report;
    if (report && argv.includes("--json")) process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`model-opt-worker failed: ${message}\n`);
    return 1;
  }
}

function requireString(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
