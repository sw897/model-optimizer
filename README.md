# Model Optimizer

Offline optimization of GLB models and standard 3D Tiles datasets. Geometry buffers use lossless Meshopt compression; material textures use Basis Universal / KTX2 compression. A separate worker generates LOD candidates from canonical prototype assets.

[简体中文](README.zh-CN.md) · [Apache-2.0](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Status and requirements

Version 0.4.0 is an unreleased local preparation build. npm publication remains disabled with `private: true`. The commands below build and install local artifacts.

- Runtime: Node.js >=20.9.0. Use a maintained Node.js LTS for development.
- `model-lod-worker` requires a canonical LOD input directory. It does not accept an arbitrary standalone GLB. See [the input specification](docs/input-specification.md).
- Decoders must support `EXT_meshopt_compression` and `KHR_texture_basisu` for optimized assets.

## Build and try

```sh
npm ci
npm run build
npm run example
node dist/opt-cli.js -i artifacts/example/model.glb -o artifacts/example/model-web.glb --json
node dist/opt-cli.js -i artifacts/example/tileset -o artifacts/example/tileset-web --json
node dist/cli.js -i artifacts/example/lod-input -o artifacts/example/lod --max-level 1 --json
```

Examples generate their own geometry and texture, with no external downloads or business data. Choose a new directory with `npm run example -- <directory>` to repeat the example. See [examples](examples/README.md).

## CLI

```sh
model-opt-worker -i model.glb -o model-web.glb --json
model-opt-worker -i models -o models-web --json
model-opt-worker -i tileset -o tileset-web --json
model-lod-worker -i lod-input -o scene-lod --preset tower-v1 --max-level 2 --json
```

| Input | Output |
| --- | --- |
| One GLB | One self-contained GLB; the filename may change |
| Directory without a root `tileset.json` | Optimized GLBs with original relative paths; auxiliary files are copied byte for byte |
| Directory with a root `tileset.json` | An independent optimized publication containing reachable resources and declared management indexes |
| Canonical LOD input directory, through the LOD worker | Base scene, per-prototype LOD candidates, manifest and report |

`--help` documents each command. Exit code 0 means success; 1 means failure. `--json` writes the final success report to stdout; CLI failures and a failure report, when available, go to stderr. Codec/library diagnostics may also be emitted. Directory outputs contain report files that can be read independently of those diagnostics.

### Optimization guarantees and limits

- The fixed `web-v1` profile preserves geometry values, vertex/index order, transforms and object identity. Texture compression is lossy. Optimization does not reduce triangle counts or generate LODs.
- Standalone and directory GLBs remain self-contained. Standard tileset publications may reference shared resources within the output directory.
- GLB filenames are case insensitive. Auxiliary `.gltf` files in a plain model directory are copied, not optimized as entries.
- Resource URIs must resolve inside the input root. Local glTF data URIs are supported; remote URLs, cycles, escaping paths and symlinks are rejected.
- A file output must not exist. A directory output must be new or empty and must not overlap the input. Already optimized inputs are rejected; retain original assets.
- Optimization targets the documented glTF/GLB content graph. Legacy `b3dm`/`i3dm`/`pnts` containers and implicit tile expansion are outside the tested support contract.
- LOD presets are `tower-v1`, `span-v1` and `base-only`. LOD quality failure retains the accepted consecutive prefix or the base model. Mixed-part or unsupported layouts retain base-only output with a recorded reason.


## Local packages and verification

```sh
npm run lint
npm test
npm run audit:dependencies
npm run package
npm run test:package
```

`npm run package` writes a tarball and SHA-256 checksums to `artifacts/`; it does not upload or publish anything. A local installation is:

```sh
npm install -g ./artifacts/model-optimizer-0.4.0.tgz
```

The tarball contains compiled CLI code, schemas, bilingual documentation, examples and license notices. Node.js and dependencies are installed separately. `package-lock.json` pins the source checkout's dependency graph; `toolchain.lock.json` records direct runtime versions.

The package smoke check installs the tarball in a temporary directory, exercises both CLIs and processes generated examples. CI is configured for Linux, macOS and Windows with maintained Node.js LTS releases. CI configuration is not evidence that those remote checks have run.

Windows x64 portable builds use a reviewed CPU-only Release encoder, a pinned Windows Node.js runtime and target-platform production dependencies. Build locally with `npm run package:portable`; inspect the extracted artifact with `npm run check:portable -- artifacts/model-optimizer-0.4.0-windows-x64.zip`. Native Windows builds also run the bundled smoke check automatically; other hosts record their actual validation level. See [Windows build and validation](docs/windows-portable.md) and [release preparation](docs/releasing.md).

For supplementary macOS/Linux compatibility checks, run `npm run prepare:wine`, then `npm run package:portable -- --wine-image model-optimizer-wine:local`. ARM Docker hosts use the pinned QEMU runner. These results are labeled Wine; native Windows verification is recorded separately.

## License

Project code and generated examples are licensed under [Apache-2.0](LICENSE). Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) and [NOTICE](NOTICE).
