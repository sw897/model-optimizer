# LOD input specification

The optimization CLI supports ordinary GLBs and tilesets independently. The LOD CLI consumes `model-optimizer.lod-input` version 1. model input scene building and packing are external tools; this repository includes schemas and a generated example of the hand-off format.

```sh
npm run example
node dist/cli.js -i artifacts/example/lod-input -o artifacts/example/lod --preset tower-v1 --max-level 1 --json
```

## Required inputs

| Path | Purpose |
| --- | --- |
| `tileset.json` and reachable resources | The base runtime scene |
| `_build/build-manifest.json` | Input identity, manifest locations and SHA-256 inventory |
| `_build/prototypes.json` | Canonical prototype entries; the manifest may declare a different filename |
| `_build/instances.jsonl` | Instance hand-off data |
| `_build/spatial-layout.json` | Build layout |
| `objects/index.json` | Object index |
| `_build/assets/prototypes/<assetKey>.glb` | Canonical prototype geometry |

See [the build schema](../schemas/build-manifest.schema.json) and the runnable producer in [generate.mjs](../examples/generate.mjs). `sceneId` and `sourceHash` must be nonempty. All manifest paths are relative to the input root.

`build.files` must cover every reachable runtime resource, declared manifest and base prototype. Each file needs its SHA-256 digest. The build manifest itself and non-authoritative reports are excluded. Paths escaping the root and symlinks are rejected.

Each prototype declares `prototypeId`, `name`, `assetKey`, `assetPath`, `sourcePath`, `role`, `baseGLB` and an initially empty `lods` array. `assetPath` must be `_build/assets/prototypes/<assetKey>`; `baseGLB` must append `.glb`. Prototype IDs must be unique. Optional `prototypeKey` and other metadata are retained.

LOD inputs must be canonical prototypes, rather than assembled world components or GPU instance models. Part features require supported primitive ownership and accessor layouts. Unsupported layouts remain base-only with a reason. Each candidate level is simplified from the base asset and checked against the preset's error budget. A quality failure stops later levels for that prototype.

## Outputs and integration

The worker preserves the base runtime scene and emits `model-optimizer.lod-manifest` version 3, `lod-worker-report.json`, a toolchain inventory and accepted LOD GLBs. The manifest binds `sceneId`, the build-manifest hash and the prototype-manifest hash. It records base hashes, output hashes, measured error and tool versions; see [the LOD schema](../schemas/lod-manifest.schema.json).

`--max-level 0` validates base assets. `--resume` may reuse a verified work directory after interruption. Fresh output directories are required.


