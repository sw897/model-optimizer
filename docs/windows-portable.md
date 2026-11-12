# Windows x64 portable builds

The portable packager runs on macOS, Linux or Windows with Node.js, npm and Go. It installs Windows x64 prebuilt production dependencies in an isolated staging directory, bundles a pinned Windows Node.js runtime and the reviewed CPU Release encoder, and cross-compiles the two launchers. Host native modules are never copied into the package.

Reserve at least 1 GiB of free space for portable assembly and 1.5 GiB for an encoder rebuild. These scripts check free space before large writes. Compiler/source extraction directories under `artifacts/portable-cache/` can be removed after validation; the pinned archives and recipe allow rebuilding them.

```sh
npm ci
npm run package:portable
npm run check:portable -- artifacts/model-optimizer-0.3.3-windows-x64.zip
```

Everything remains local. `private: true` is retained. No workflow uploads, signs, publishes or creates release tags.

## Locked native tools

| Tool | Version / build | Verification |
| --- | --- | --- |
| Basis Universal | 1.16.3, source commit `1531cfaf9ed5232248a0a45736686a849ca3befc` | SHA-256 of source archive, compiler archive and executable |
| Compiler | llvm-mingw 20261104, Clang 23.1.5 | Pinned macOS universal compiler archive |
| Windows runtime | Node.js 24.22.3 x64 | Archive SHA-256 from the official Node.js distribution manifest; executable hash in the portable manifest |
| Launcher | Go, `GOOS=windows GOARCH=amd64 GOAMD64=v1 CGO_ENABLED=0` | Compiler version, executable hashes and PE import inventory |
| Sharp | 0.35.5, libvips 8.18.7 | Target-platform npm lockfile integrity; PE imports, binary hashes and upstream license records |

See [native-tools.lock.json](../native-tools.lock.json) and the [encoder provenance](../vendor/basisu/windows-x64/README.md). The Windows runtime is fixed independently of the build host's Node.js version.

## Encoder build

The encoder is compiled from unmodified upstream source with CMake 4.4.3 and these options:

```text
CMAKE_BUILD_TYPE=Release
STATIC=ON
SSE=OFF
OPENCL=OFF
CMAKE_DISABLE_FIND_PACKAGE_OpenCL=ON
ZSTD=ON
C_FLAGS_RELEASE/CXX_FLAGS_RELEASE=-O2 -DNDEBUG
  -ffile-prefix-map=<source>=basis_universal
  -fmacro-prefix-map=<source>=basis_universal
GCC_LINK_FLAGS=-Wl,--no-insert-timestamp -Wl,-s
RT_MANIFEST=1: scripts/basisu.manifest (UTF-8 activeCodePage, longPathAware)
```

The process manifest opts the encoder's narrow-character CRT file APIs into UTF-8. It requires Windows 10 version 1903 or later; see [Microsoft's process code-page documentation](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page). This avoids depending on the user's system-wide locale for Chinese temporary paths.

On macOS, the pinned compiler and source can be downloaded, verified and rebuilt with:

```sh
npm run build:encoder:windows
# Optional Unicode/spaced cache, also useful for reproduction checks.
npm run build:encoder:windows -- --cache-dir "artifacts/encoder rebuild 中文 cache"
```

This command captures compiler output in `artifacts/portable-cache/encoder-build.log` and refuses to replace the reviewed binary if its SHA-256 differs. Rebuilding in a fresh source directory reproduced the reviewed binary locally. Source/compiler archives are cached under `artifacts/portable-cache/`.

The official upstream prebuilt EXE imports OpenCL and extra VC++ libraries; this source build controls those dependencies. The npm wrapper's Windows executables and debug DLLs are not shipped. On Windows, runtime resolution uses only the checked-in reviewed binary and verifies its hash before encoding. It does not fall back to an unreviewed npm binary.

Changing the compiler, flags, source or encoder binary requires a new reviewed digest in the native lock. The optimizer records the selected encoder identity and includes it in release identity and texture cache keys. Different builds cannot reuse the old codec identity accidentally.

## Validation levels

`check:portable` validates the version 2 manifest after ZIP extraction: the entire `app/` file inventory, required launchers/CLI entry scripts, installed package identities, native hashes, PE32+/x64 architecture, normal/delayed imports, adjacent dependencies, system DLLs, license records and exclusion of the legacy encoder. It parses the license inventory and checks every notice's length and SHA-256. Go's runtime license is copied from the actual compiler and recorded alongside Node/native notices. Missing executables or JavaScript, invalid/empty catalogs and absent/altered notices are rejected. Unsafe ZIP paths, Windows case collisions and debug runtime imports are rejected. Older version 1 preparation ZIPs must be regenerated.

On a native Windows x64 build host, `package:portable` additionally executes the extracted ZIP's smoke check automatically. It uses the bundled Node.js runtime and launchers with empty PATH/NODE_PATH/NODE_OPTIONS. A successful run covers:

- Both CLI versions, help and failure exit codes.
- Direct Release encoder version/hash checks.
- Generated GLB texture compression and exact decoded POSITION bytes.
- Preservation of original inputs and occupied outputs.
- Model directories and byte-identical auxiliary files.
- Standard tileset optimization and real model input LOD generation.
- A deliberately corrupted encoder rejected without producing output, followed by restoration of the reviewed bytes.
- Unicode/spaced paths and static validation after extraction and execution.

Run it again on an extracted Windows package without installing development tools:

```powershell
.\runtime\node.exe .\app\scripts\test-portable.mjs .
```

`validation-report.json` records the actual environment and checks. `portable-manifest.json` contains the static binary inventory, tool provenance and execution status. A Mac/Linux build without a Windows runner explicitly records `execution: not-run`.

For supplementary local Wine checks on macOS/Linux with Docker:

```sh
npm run prepare:wine
npm run package:portable -- --wine-image model-optimizer-wine:local
```

`prepare:wine` builds a local amd64 Debian/Wine image. On an ARM Docker host it adds a SHA-256-pinned static ARM64 QEMU 10.0.13 with the `Nehalem` CPU model. Its Wine loader alias keeps child Node.js and encoder processes under that same emulator. Docker Desktop's default amd64 translation and older QEMU 7.2 failed this workload locally; the pinned runner passed the complete smoke check. The regular-file stdio adapter avoids a Wine/libuv Docker pipe mismatch, while child-process pipes remain exercised by the test.

Use `--base-image <existing-local-image>` to reuse a previously built amd64 Wine base, and `--image <local-image>` to select the output tag. The runner lock and build recipe are under `scripts/portable-wine*`; downloaded archives and the actual image ID/Wine/QEMU versions are recorded in `artifacts/portable-cache/wine-runner.json`. The runner is a development tool and is excluded from the Windows product ZIP. Docker must already be running; these scripts do not restart Docker or change its global settings.

The package test limits its container to 4 CPUs, 2 GiB of memory, 256 processes and bounded logs, disables networking, and removes its own container afterwards. The artifact manifest records the exact local runner image ID. A Wine report is compatibility evidence, not a substitute for native Windows verification. The CI Windows job is configured for native execution; its presence does not mean it has run.

The final ZIP and SHA-256 sidecar are committed to `artifacts/` only after the requested checks succeed. Failed staging directories are removed. The ZIP preserves the complete `app/` and `runtime/` directory layout and is not a single-file executable.

## Redistribution

The encoder's permissive license texts and static runtime notices are included in its vendor directory. The package also retains Node.js licensing and inventories installed production packages in `THIRD_PARTY_LICENSES.json`.

The build includes a hashed source preparation kit under `redistribution/`: pinned Sharp/libvips source and packaging archives, the exact matching SDK's headers/import libraries, and unclosed source/replacement checks. See [native source and replacement materials](windows-native-redistribution.md). Its current status is `partial`; integrity checks do not complete redistribution review.

The stricter local readiness check is expected to fail while blockers remain:

```sh
npm run check:portable -- artifacts/model-optimizer-0.3.3-windows-x64.zip --require-release-ready
```

Sharp/libvips and embedded dependencies keep their own licenses, including LGPL. Provide corresponding source/replacement or relinking material as required for the actual binary. Public distribution remains subject to [release preparation](releasing.md) and [release blockers](release-blockers.md).
