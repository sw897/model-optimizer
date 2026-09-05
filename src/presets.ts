import type { Preset } from "./types.js";

const TOWER_LEVELS = [
  { level: 1, ratio: 0.35, maxErrorMeters: 0.08, lockBorder: true },
  { level: 2, ratio: 0.12, maxErrorMeters: 0.30, lockBorder: true },
  { level: 3, ratio: 0.04, maxErrorMeters: 1.20, lockBorder: true },
];

const SPAN_LEVELS = [
  { level: 1, ratio: 0.45, maxErrorMeters: 0.10, lockBorder: true },
  { level: 2, ratio: 0.18, maxErrorMeters: 0.40, lockBorder: true },
  { level: 3, ratio: 0.06, maxErrorMeters: 1.50, lockBorder: true },
];

const PRESETS: Readonly<Record<string, Preset>> = {
  "tower-v1": {
    name: "tower-v1",
    version: 1,
    levels: TOWER_LEVELS,
    fallback: "fail",
  },
  "span-v1": {
    name: "span-v1",
    version: 1,
    levels: SPAN_LEVELS,
    fallback: "fail",
  },
  "lod0-only": {
    name: "lod0-only",
    version: 1,
    levels: [],
    fallback: "lod0-only",
  },
};

export function getPreset(name: string): Preset {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`unknown preset ${name}; available presets: ${listPresets().join(", ")}`);
  }
  return {
    ...preset,
    levels: preset.levels.map((level) => ({ ...level })),
  };
}

export function listPresets(): string[] {
  return Object.keys(PRESETS).sort();
}
