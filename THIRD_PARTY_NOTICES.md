# Third-party software

Model Optimizer code is licensed under Apache-2.0. That license does not replace the licenses of dependencies, native binaries, textures or models supplied by others.

The project npm tarball does not bundle `node_modules` or Node.js. Dependencies are installed separately. The Windows portable layout would include these components and therefore requires a separate redistribution review.

## Direct runtime dependencies

| Package | Pinned version | License and source |
| --- | --- | --- |
| `@gltf-transform/core` | 4.5.0 | [MIT, glTF Transform](https://github.com/donmccurdy/glTF-Transform/blob/v4.5.0/LICENSE.md) |
| `@gltf-transform/extensions` | 4.5.0 | [MIT, glTF Transform](https://github.com/donmccurdy/glTF-Transform/blob/v4.5.0/LICENSE.md) |
| `@gltf-transform/functions` | 4.5.0 | [MIT, glTF Transform](https://github.com/donmccurdy/glTF-Transform/blob/v4.5.0/LICENSE.md) |
| `meshoptimizer` | 1.2.0 | [MIT](https://github.com/zeux/meshoptimizer/blob/v1.2/LICENSE.md) |
| `draco3dgltf` | 1.5.7 | [Apache-2.0, Draco](https://github.com/google/draco/blob/1.5.7/LICENSE) |
| `basisu` npm wrapper | 1.16.3 | Declared ISC in [package metadata](https://github.com/HacksawStudios/basisu/blob/master/package.json) |
| Basis Universal encoder | 1.16.3 | [Apache-2.0](https://github.com/BinomialLLC/basis_universal/blob/1.16.3/LICENSE); audit embedded third-party components for the actual binary |
| `sharp` | 0.35.5 | [Apache-2.0](https://github.com/lovell/sharp/blob/v0.35.5/LICENSE) |

Copyright and license texts distributed in upstream packages must be retained when redistributing those packages. The table is an inventory of direct dependencies, not a complete binary licensing bundle.

## Native dependencies and portable distribution

Sharp prebuilt packages include libvips and other libraries under multiple licenses, including LGPL-3.0-or-later in the locked platform packages. Review the [upstream third-party notices](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md), the exact installed platform package, and the [LGPLv3 terms](https://www.gnu.org/licenses/lgpl-3.0.html). Capture the corresponding library sources and build information, and satisfy applicable replacement/relinking requirements for the actual linked binary. A link to a general project homepage is not a substitute for providing the required corresponding sources.

The `basisu@1.16.3` npm package includes `ucrtbased.dll` under both Windows x64 binary directories. This is a Microsoft debug runtime whose redistribution is restricted; see [Determine which DLLs to redistribute](https://learn.microsoft.com/en-us/cpp/windows/determining-which-dlls-to-redistribute?view=msvc-170). The Windows portable packager excludes this npm package entirely. Windows encoding uses our source-built CPU Release binary, with source/compiler/executable digests in `native-tools.lock.json` and upstream/static runtime license texts in `vendor/basisu/windows-x64/licenses/`. Its imports contain only Windows system APIs. The packager rejects debug runtime filenames and imports anywhere in the staged native tree.

The statically linked LLVM components use Apache-2.0 with LLVM exceptions; MinGW runtime and winpthreads notices are retained verbatim in the vendor license directory. Build options and reproduction steps are documented in [the Windows guide](docs/windows-portable.md). macOS/Linux CLI texture encoding continues to use the npm package's platform binary.

Node.js has its own license and bundled notices. The portable layout copies the runtime's `LICENSE`; verify that it corresponds to the exact runtime binary.

The Go launchers include Go's runtime and standard library. Assembly copies the actual compiler distribution's BSD license to `runtime/Go-LICENSE` and records its digest and compiler version in the license inventory.

The portable layout contains a versioned, hashed source preparation kit for Sharp/libvips and the exact matching Windows SDK. This kit is explicitly partial: embedded source/notice closure and native Windows replacement evidence remain blocked. See [native materials](docs/windows-native-redistribution.md) and [release blockers](docs/release-blockers.md). Source archives keep their upstream licenses and are separate from this project's generated examples.

Before any portable release, inventory the complete production dependency tree on the target platform, include all applicable copyright/license texts and notices, provide corresponding sources as required, and retain the review with the release. See [the release checklist](docs/releasing.md).

## Examples

`examples/generate.mjs` creates original geometry and a procedural checker texture. Those generated examples are covered by the project's Apache-2.0 license. No customer model, logo, photo or production dataset is bundled.
