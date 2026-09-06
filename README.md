# model-optimizer


- `model-lod-worker` — stage 2, generates real LOD1…LODN from canonical LOD0;
- `model-opt-worker` — stage 4, creates the fixed `web-v1` publishing variant with Meshopt geometry
  and BasisU/KTX2 textures.

`model-lod-worker` consumes the

The LOD worker never edits `scene.json`, `prototypes.json`, `instances.jsonl`, page files, or object
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

After stage 3 has produced a `buildStage=published` scene, create the web publishing variant in a
separate directory:

```bash
node dist/opt-cli.js \
  --input ../model/work/model-0904-published \
  --output ../model/work/model-0904-web
```

can rely on one tested runtime contract. It preserves prototype paths, instance pages, object
indexes, feature IDs and LOD metadata, and writes `optimization-manifest.json` plus a new scene
hash. The input must be the raw stage-3 scene; an already optimized scene is rejected to avoid
repeated quantization or texture transcoding.

## Output contract

The worker produces:

```text
<output>/
  scene.json                  # unchanged canonical scene
  source-manifest.json
  prototypes.json             # unchanged canonical prototype index
  instances.jsonl
  object-index.json
  component-graph.json       # semantic component/audit graph
  pages/
  assets/prototypes/<assetKey>/lod0.glb    # canonical asset, semantic source path
  assets/prototypes/<assetKey>/lod1.glb
  assets/prototypes/<assetKey>/lod2.glb
  lod-manifest.json           # worker/model hand-off
  toolchain.lock.json
  lod-worker-report.json
```

`prototypes.json` is the join index, not the physical directory name. Each entry carries
`prototypeId` for instance references plus `name`, `role`, `sourcePath`, `assetKey` and
`assetPath`. The canonical and generated assets always live at
`<assetPath>/lod{level}.glb`; the numeric prototype id is never used as an asset directory.

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
  input is re-encoded when the simplified GLB is written; stage-2 output remains uncompressed by
  policy. Stage 4 applies the separate web compression profile described below.

this project owns simplification, compression, preset/toolchain versions, and quality reports.

## Web optimization policy

`model-opt-worker` reads the complete stage-3 published scene and writes a new scene tree. It does
not alter object IDs, page files, instance transforms, prototype paths, or LOD levels. For each
prototype/LOD GLB it applies `EXT_meshopt_compression` with the locked Meshopt encoder, then
converts embedded raster textures to `KHR_texture_basisu` KTX2 using the pinned Basis Universal
encoder. Base-color/emissive textures use ETC1S; normal/occlusion/metal-roughness textures use
UASTC with linear filtering. Existing KTX2 textures are retained.

Every output is decoded again before commit. The worker checks GLB structure, hashes, node/material/
texture bindings, primitive boundaries, extras, skins and animations. `optimization-manifest.json`
records the source/output hash and byte counts for every level. `scene.json` records
`geometryCompression`, `textureCompression`, `optimizationManifest` and a recomputed content hash;
the operational report is excluded from that hash.

The raw stage-3 directory remains the archival/fallback result. Publish the web directory to
The optimization manifest schema is checked in at `schemas/optimization-manifest.schema.json`.

## Development

```bash
npm run lint
npm test
npm run build
```
