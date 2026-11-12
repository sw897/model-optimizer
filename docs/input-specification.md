# Input specification

This document defines the accepted data formats for `model-opt-worker` and `model-lod-worker`. Inputs are identified by their contents and schema identifiers. No particular application is required to create or read them.

## Input forms

| Command | Input | Output |
| --- | --- | --- |
| `model-opt-worker` | A `.glb` file | A self-contained optimized `.glb` file |
| `model-opt-worker` | A directory without a root `tileset.json` | Optimized GLBs at their original relative paths; other files copied unchanged |
| `model-opt-worker` | A directory with a root `tileset.json` | A complete optimized tileset resource graph and any declared management indexes |
| `model-lod-worker` | A canonical prototype directory with the LOD manifest defined below | Base scene, accepted per-prototype LOD candidates, manifest and report |

GLB filename matching is case insensitive. Plain-directory `.gltf` files are auxiliary files, not optimization entries. A tileset may reference external tilesets, glTF/GLB assets, buffers, images and metadata schemas. Local glTF data URIs are supported. Legacy tile containers (`b3dm`, `i3dm`, `pnts`) and implicit tile expansion are outside the tested support contract.

### Paths, identity and output boundaries

Resource URIs must resolve inside the input root. Remote resources, reference cycles, escaping paths and symlinks are rejected. Manifest/index paths use root-relative paths with `/` separators. Preserve the exact bytes used to calculate SHA-256; declared file digests are lowercase hexadecimal strings of length 64.

A file output must not already exist. A directory output must be new or empty, and input/output directories must not overlap. Inputs must contain original assets: an existing optimization manifest or GLB `asset.extras.modelOptimizer` marker is rejected. Preserve originals for repeat runs.

The `web-v1` optimizer preserves geometry values, order, transforms and feature identity. It applies lossless Meshopt buffer compression and lossy Basis Universal/KTX2 material texture compression. Feature/property textures retain their lossless data. Texture compression does not reduce triangle counts or generate LODs. Optimized assets require support for `EXT_meshopt_compression` and `KHR_texture_basisu`.

## Canonical LOD input directory

The fixed entry is `_build/build-manifest.json`. The directory also needs a base `tileset.json`, its complete reachable resource graph, the four declared data files and each canonical prototype GLB. A minimal layout is:

```text
tileset.json
content/model.glb
objects/index.json
_build/build-manifest.json
_build/prototypes.json
_build/instances.jsonl
_build/spatial-layout.json
_build/assets/prototypes/sample.glb
```

The build manifest uses `model-optimizer.lod-input`, version 1:

```json
{
  "schema": "model-optimizer.lod-input",
  "version": 1,
  "sceneId": "example-scene",
  "sourceHash": "example-source-revision",
  "prototypeManifest": "_build/prototypes.json",
  "instanceManifest": "_build/instances.jsonl",
  "objectIndex": "objects/index.json",
  "layout": "_build/spatial-layout.json",
  "files": [
    {"path": "tileset.json", "sha256": "<sha256>"},
    {"path": "content/model.glb", "sha256": "<sha256>"},
    {"path": "objects/index.json", "sha256": "<sha256>"},
    {"path": "_build/prototypes.json", "sha256": "<sha256>"},
    {"path": "_build/instances.jsonl", "sha256": "<sha256>"},
    {"path": "_build/spatial-layout.json", "sha256": "<sha256>"},
    {"path": "_build/assets/prototypes/sample.glb", "sha256": "<sha256>"}
  ]
}
```

Replace every `<sha256>` with the actual file digest. `sceneId` and `sourceHash` are nonempty strings; `sourceHash` identifies the source revision and need not itself be a SHA-256 digest. The four manifest paths may name other files inside the root.

`files` must have unique paths and cover every reachable runtime/management resource, all four declared files and every base prototype. Include additional buffers, textures, external tilesets or indexes when present. Exclude the build manifest itself and non-authoritative reports. The worker verifies the file inventory before processing. See [the build-manifest schema](../schemas/build-manifest.schema.json).

The prototype manifest is a nonempty JSON array. Each entry has this shape:

```json
{
  "prototypeId": "sample-prototype",
  "name": "Sample prototype",
  "assetKey": "sample",
  "assetPath": "_build/assets/prototypes/sample",
  "sourcePath": "sample.obj",
  "role": "prototype",
  "baseGLB": "_build/assets/prototypes/sample.glb",
  "lods": []
}
```

`prototypeId` must be nonempty and unique. `assetPath` must equal `_build/assets/prototypes/<assetKey>` and `baseGLB` must append `.glb`. The GLB must exist and be included in `files`. Optional `contentSha256` is checked against its bytes. Optional `prototypeKey` and other entry metadata are retained. `lods` must initially be empty. `sourcePath` is descriptive metadata; it does not request another source file.

`instanceManifest` and `layout` are required inventoried files that are preserved; the LOD worker does not derive geometry from their contents. The generated example uses an empty JSONL file and an empty JSON object. `objectIndex` is a JSON object with an `objects` array; use `{"schema":"model-optimizer.tileset-objects","version":1,"objects":[]}` when there are no object records. If feature metadata or a publication catalog references an index, the identity rules below also apply.

Prototype geometry must be canonical: assembled component tables and GPU instance models are rejected for LOD generation. Presets are `tower-v1`, `span-v1` and `base-only`. Each candidate is simplified from the base asset and measured against the preset's error budget. Failure stops subsequent levels for that prototype, preserving the accepted consecutive prefix. Unsupported layouts remain base-only with a reason. Part-aware simplification requires a single part per primitive and supported, unshared accessor layouts; animations, scaled nodes and mixed-part layouts are examples of base-only cases.

## Feature metadata

Standard feature extensions are preserved and their references, ranges, table counts and string offsets are checked. The additional identity profile is an inline `EXT_structural_metadata.schema` with `id: "model_features_v2"`:

| Property-table class | Required scalar STRING properties |
| --- | --- |
| `prototype_parts` | `partId`, `displayName`, `sourceName` |
| `model_components` | `objectId`, `kind`, `entityId`, `entityType`, `componentId`, `componentType`, `prototypeKey`, `displayName`, `sourceName` |

Every required property must decode to one value per row. Part IDs must be nonempty and unique within their table. Component identity fields through `prototypeKey` must be nonempty; `(objectId, componentId)` must be unique within a table when no object index is present. Descriptive names may be empty strings. The obsolete `model_objects_v1` identity profile is rejected.

When an object index is present, component metadata also requires `sceneId` and `objectKey`, with `objectKey = sceneId + "/" + objectId`. Each row must match the corresponding object's identity, `kind` and reachable content path. When a component index is declared, the remaining identity/descriptive fields must match the component record, and each indexed content must have matching feature metadata. Optional primitive metadata under `extras.modelPart` is retained.

## Optional tileset management indexes

Ordinary standard tilesets need no project-specific indexes. To include management data, declare it through the tileset's `asset.extras.catalog` and matching `objectIndex` / optional `componentIndex` paths. Paths are relative to the input root. The following JSON formats use version 1:

| Schema | Contents |
| --- | --- |
| `model-optimizer.tileset-catalog` | `root`, `objectIndex`, optional `componentIndex`, and `nodes` whose `payloadPath` values resolve to inventoried resources |
| `model-optimizer.tileset-objects` | `objects` array with object identity, `kind` and reachable `contents` paths |
| `model-optimizer.tileset-components` | Total `count` and ordered `shards` summaries |
| `model-optimizer.tileset-component-shard` | Nonempty `components` array |

A declared `componentIndex` or `catalogSHA256` enables the strict digest chain: the tileset extras require a 32-character lowercase hexadecimal `releaseId` and `catalogSHA256`; the catalog must match that release ID and carry `objectIndexSHA256` and, when applicable, `componentIndexSHA256`; each shard summary has `sha256`. All hashes cover the referenced file bytes.

Component records require `sceneId`, `objectId`, `objectKey`, `componentId`, `entityId`, `entityType`, `prototypeKey`, `componentType`, `bounds`, `position` and nonempty `contents`. `componentType` is one of `conductor`, `ground-wire`, `jumper`, `tower-body`, `insulator`, `hardware`, `unknown`. Coordinates use longitude/latitude degrees and height metres: bounds contain `west`, `south`, `east`, `north`, `minHeight`, `maxHeight`; `position` contains three finite values. Each content entry has a reachable glTF/GLB `path` and a nonnegative integer `level`.

Components are globally sorted by UTF-8 byte order of `(objectKey, componentId)` with unique keys. Each shard summary records `count`, `first`, `last`, `componentTypes` counts and enclosing `bounds`. Index reads are limited to 8 MiB, except the object index at 64 MiB. Optimization rewrites references/digests and groups output shards by object with a 4 MiB budget. `_build` files are not used to discover publication indexes.

## Outputs and format versions

LOD output preserves the base scene and adds `lod-manifest.json` (`model-optimizer.lod-manifest`, version 3), `lod-worker-report.json`, a toolchain inventory and accepted LOD GLBs. The manifest binds `sceneId`, the build-manifest SHA-256 and the prototype-manifest SHA-256. Entries record base/output hashes, measured error and tool versions; see [the LOD output schema](../schemas/lod-manifest.schema.json). Candidate files do not change the base tile hierarchy or its content references.

`--max-level 0` validates base assets. `--resume` may reuse a verified `.lod-work` directory after interruption. A completed output directory cannot be reused as a fresh destination.

Optimization directory outputs include `model-optimizer.optimization-manifest` version 3 and an optimization report (`model-optimizer.optimization-report`, version 3). Optimized GLBs carry `asset.extras.modelOptimizer` with `schema: "model-optimizer.asset-metadata"`, version 1. Standard tileset output contains reachable runtime resources and declared management indexes, excluding LOD preparation files. See [the optimization output schema](../schemas/optimization-manifest.schema.json).

Version 0.4.0 introduces the identifiers in this specification. Inputs using other identifiers require conversion, including metadata classes/keys, followed by recalculation of every affected file digest and digest chain. Output reports should be regenerated from original inputs. Previous work directories are not compatible. There are no legacy identifier aliases.

Generate a runnable synthetic input with `npm run example`, then run `node dist/cli.js -i artifacts/example/lod-input -o artifacts/example/lod --max-level 1 --json`. The [generator](../examples/generate.mjs) demonstrates the complete file inventory without external data.
