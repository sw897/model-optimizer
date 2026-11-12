# Release preparation

This checkout prepares an unreleased 0.3.3 build. `private: true` prevents npm publication. Local build, test, pack and smoke commands never upload artifacts. There is no publication workflow or configured public repository URL.

## Local checks

```sh
npm ci
npm run clean
npm run build
npm run lint
npm test
npm run audit:dependencies
npm run package
npm run test:package
gitleaks git --redact --no-banner .
```

The package smoke check creates a temporary installation from the tarball and tests both CLIs, generated GLB/tileset/LOD inputs, texture encoding and license documents. It removes its temporary installation afterwards. Generated examples and packages belong in ignored `artifacts/`.

Source checkouts use `package-lock.json` for the full dependency graph. The npm tarball resolves dependencies on installation; its direct runtime versions are pinned, but its transitive graph is not a standalone lockfile. Do not describe the tarball as a fully locked runtime. Portable releases must capture their actual installed graph and binary inventory.

## Before public source or npm distribution

- Confirm authority to license existing code and historical contributions, including organizational rights. Confirm the collective copyright attribution in NOTICE.
- Choose the public repository and issue tracker. Add their verified URLs to package metadata and documentation; do not publish an internal repository URL as a public support link.
- Configure a private security reporting channel and the supported-version policy.
- Review Git history for credentials, private infrastructure details, personal data and restricted assets. Keep scan output redacted. Automated scans do not establish ownership or prove absence of all sensitive data.
- Review third-party notices and any sample assets. Keep LICENSE, NOTICE and dependency notices in all relevant artifacts.
- Record actual Linux/macOS/Windows CI results. In particular, run the Windows package installation and native texture tests on Windows.
- Review the unreleased changelog and version/toolchain consistency. Create release tags only when a release is authorized.
- If publishing npm packages, deliberately remove `private: true`, confirm control of the `@project` scope and configure public registry access. Source publication alone does not require npm publication. These steps are outside this local preparation task.

## Windows portable package

The legacy npm encoder is excluded from the Windows package. A reviewed CPU Release encoder is included with pinned source/compiler/binary digests and license texts. PE inspection covers architecture, normal and delayed DLL imports, hashes and packaged dependency closure. See [Windows build and validation](windows-portable.md).

Before public portable distribution:

1. Verify the checked-in Release encoder against `native-tools.lock.json`; review any changed source/compiler/flags or digest. The selected encoder identity is recorded in optimizer reports, release IDs and texture cache keys.
2. Inventory the complete target-platform production tree. Preserve copyright/license texts and notices for the wrapper, encoder, embedded components, Node.js, Sharp/libvips and transitive dependencies. The direct-dependency table alone is insufficient.
3. Capture and provide corresponding sources/build information as required by LGPL and other applicable licenses; verify replacement or relinking requirements for the actual binaries.
4. Build with Node.js and Go, inspect the actual ZIP, and run `.\runtime\node.exe .\app\scripts\test-portable.mjs .` on native Windows. The native Windows packager runs this automatically; supplementary Wine results are labeled separately. Verify the extracted ZIP on a clean machine, including Unicode/spaced paths and an empty PATH.
5. Record that review and smoke result with the artifact and SHA-256 checksum before distribution.

Keep `portable-manifest.json`, `validation-report.json` when execution has run, and SHA-256 checksums with the review. `execution: not-run` means static validation only; a Wine report is not a native Windows pass. Public distribution and complete third-party source/relinking review remain outside this local-only preparation.

Follow [the current blocker record](release-blockers.md) and [native source/replacement procedure](windows-native-redistribution.md). `npm run check:portable -- <zip> --require-release-ready` fails until both native source redistribution and native Windows execution gates are closed. The default static check validates a local preparation artifact; it does not grant release approval.
