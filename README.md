# model-lod


The worker never edits `scene.json`, `prototypes.json`, `instances.jsonl`, page files, or object
indexes in the input directory. It writes LOD assets, `lod-manifest.json`, a locked toolchain copy,
and a diagnostic report to a new output directory.

## Requirements

- Node.js 20 or newer
- npm with the repository lockfile

Install and build:

```bash
npm ci
npm run build
```

## Run

```bash
node dist/cli.js \
  --input ../model/work/model-0904-scene \
  --output ../model/work/model-0904-lod \
  --preset tower-v1 \
  --max-level 2
```

`--max-level 0` is the compliance-only path: it validates and copies the canonical LOD0 scene,
and emits a manifest with no simplified levels. The default is level 1. Supported presets are
`tower-v1`, `span-v1`, and `lod0-only`.

If a run is interrupted after one or more prototypes finish, the worker retains an unpublishable
`<output>.stage2-work` directory. Repeat the command with `--resume` to validate and reuse matching
prototype hashes; omit `--resume` to discard that staging directory and start over.


```bash
  --input ../model/work/model-0904-lod \
  --output ../model/scene/model-0904 \
  --runtime assembly
```

## Output contract

The worker produces:

```text
<output>/
  scene.json                  # unchanged canonical scene
  source-manifest.json
  prototypes.json             # unchanged canonical prototype index
  instances.jsonl
  object-index.json
  pages/
  prototypes/<id>/lod0.glb    # canonical asset
  prototypes/<id>/lod1.glb
  prototypes/<id>/lod2.glb
  lod-manifest.json           # worker/model hand-off
  toolchain.lock.json
  lod-worker-report.json
```

`lod-manifest.json` uses `model-optimizer.lod-manifest` v1. Every generated level records the canonical input
hash, output hash, method, tool version, and measured Meshopt error in meters. LOD files are written
to temporary names, decoded again, hashed, and renamed atomically. The final directory is committed
with a directory rename, so a failed run cannot expose a partial stage.

The JSON Schema for the hand-off is checked in at `schemas/lod-manifest.schema.json`.

## Simplification policy

- Each level is calculated independently from the canonical LOD0 document.
- glTF-Transform handles document I/O and semantic preservation; MeshoptSimplifier handles triangle
  reduction.
- Nodes, materials, textures, extras, primitive boundaries, transforms, skins, and animations are
  retained by the document transform. Non-triangle primitives are not simplified.
- The worker locks topological borders and converts the preset meter error bound to Meshopt's
  normalized error scale.
- A requested level must reduce triangle count. If it cannot, the worker fails instead of writing an
  identity LOD that would hide a bad result.
- The worker does not compress output with Draco, Meshopt, or KTX2. Compression remains a separate
  validated publishing decision.

this project owns simplification, preset/toolchain versions, and LOD quality reports.

## Development

```bash
npm run lint
npm test
npm run build
```
