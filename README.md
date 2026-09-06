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

`tower-v1` and `span-v1` use a scene-wide `lod0-only` fallback. If any prototype contains line/
point primitives, is too small to reduce, exceeds the error limit, or changes scene semantics, the
worker validates all canonical assets and publishes a LOD0-only stage instead of emitting an
identity or partial LOD set. This keeps stage 3's requirement for continuous levels intact.

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
hash, output hash, method, tool version, and measured Meshopt error in meters. LOD files are decoded
before they are committed, hashed, and written atomically with an fsync. The final directory is
committed with a directory rename, so a failed run cannot expose a partial stage.

The JSON Schema for the hand-off is checked in at `schemas/lod-manifest.schema.json`.

## Simplification policy

- Each level is calculated independently from the canonical LOD0 document.
- glTF-Transform handles document I/O and semantic preservation; MeshoptSimplifier handles triangle
  reduction.
- Nodes, materials, textures, extras, primitive boundaries, transforms, skins, and animations are
  retained by the document transform and checked by a semantic snapshot before publication.
- Non-triangle primitives are rejected for a simplification preset and trigger the scene-wide
  `lod0-only` fallback; they are never written as fake `meshopt-simplify` levels.
- The worker locks topological borders and converts the preset meter error bound to Meshopt's
  normalized error scale.
- A requested level must reduce triangle count and remain within the preset error limit. If it
  cannot, the fallback policy is applied instead of writing an identity LOD.
- Canonical GLBs must embed image resources. External image URIs are rejected because the worker
  copies the canonical GLB as LOD0 and cannot safely publish an unresolved sidecar.
- The worker decodes Draco and Meshopt input with the locked toolchain. Existing Draco or Meshopt
  input is re-encoded when the simplified GLB is written; the worker does not apply a new Meshopt
  or KTX2 compression transform. Compression remains a separate validated publishing decision.

this project owns simplification, preset/toolchain versions, and LOD quality reports.

## Development

```bash
npm run lint
npm test
npm run build
```
