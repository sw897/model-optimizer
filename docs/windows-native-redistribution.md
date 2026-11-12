# Windows native redistribution materials

The portable build includes a **partial source preparation kit**, recorded in `redistribution/SOURCE-MATERIALS.json`. It is not a completed corresponding-source offer or permission to publish the binary package. `check:portable --require-release-ready` rejects the package while source or native Windows checks remain incomplete.

## Recorded evidence

`vendor/redistribution/windows-x64.json` locks Sharp 0.35.5, all 28 entries in its embedded library version table, the actual libvips DLL digest, source/recipe archive digests and the official Windows static SDK digest.

The official `vips-dev-x64-web-8.18.7-static.zip` contains `libvips-42.dll` with SHA-256 `06dab07cc386748513337a31672b1d5269fbc770a14ff403080575665bf0813f`, identical to the DLL inside the locked Sharp Windows npm package. Its version table also matches exactly. This establishes the SDK/binary bridge; the similarly named non-static SDK is a different build.

The packager verifies and retains these complete upstream archives in `redistribution/sources/`:

- Sharp 0.35.5 source, commit `51a990faa26ade5586a4934ac9673c98d8893326`.
- libvips 8.18.7 release source.
- sharp-libvips 1.3.4 recipe, commit `ebb95f8add54eee8bed840e3fb587e4cbec857d7`.
- build-win64-mxe 8.18.7 settings and patches, commit `ef19ca09af2453d127453d677c849ccb37cf5694`.

The SDK's license, README, headers, version table and Windows import libraries are retained under `redistribution/sdk/`. Extra SDK executables and DLLs are excluded. Every retained file, including archives, is hashed and checked after ZIP extraction.

The archives retain upstream licenses and test assets. They are separate from this project's Apache-2.0 source and generated examples. They are not included in the source tree or npm tarball; local portable assembly downloads them from locked URLs.

## Remaining source closure

The kit does **not** yet contain exact source archives and required notices for every embedded LGPL/MPL library and its transitive dependencies. `pendingSources` lists versioned components still to be archived. The MXE recipe also refers to a mutable base OCI image and MXE branch; the release metadata does not establish the complete compiler/container/source closure on its own. Obtain and verify that evidence with the upstream build or rebuild from a fully captured closure before clearing `embedded-source-closure`.

Do not replace this work with a generic homepage, mark the kit complete without evidence, or claim that retaining license texts alone satisfies all redistribution requirements. The current `partial` status is propagated into every portable manifest and checked independently from binary integrity.

## Replacement/relink verification

Use a disposable copy of the entire extracted package and preserve original hashes. Keep the shipped package and its integrity manifest unchanged: its verifier correctly rejects altered native files.

1. Extract the pinned source/recipe archives, capture corresponding dependency archives and licenses, and record compiler/container digests and patches. Build `vips-web` for `x86_64-w64-mingw32.static`, as used by sharp-libvips `build/win.sh`.
2. Introduce a small identifiable library change, retain the patch and rebuild an ABI-compatible `libvips-42.dll`. Retain all required corresponding source and build information.
3. Replace the DLL beside `sharp-win32-x64-0.35.5.node`. The directory also contains `libvips-cpp-8.18.7.dll`. If the C++ ABI changes, rebuild that wrapper from pinned Sharp/libvips sources and matching SDK headers/import libraries. Do not substitute an unrelated non-static SDK DLL.
4. On native Windows x64, use the bundled Node runtime to load Sharp and record `sharp.versions` and the identifiable change. Run both launchers with empty PATH/NODE_PATH/NODE_OPTIONS, generated GLB/tileset/LOD inputs, and Chinese/spaced paths. Check output geometry and textures, not only `--version`.
5. Record replacement binary hashes, source/patch/build records and execution results. Reconcile source delivery and license obligations for the actual combined libraries before changing readiness status.

This Mac can capture sources and run the original library under Wine; it has not completed the native Windows replacement/relink check. The package remains a local preparation artifact. See [release blockers](release-blockers.md).
