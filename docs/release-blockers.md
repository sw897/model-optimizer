# Local preparation status and release blockers

This records the remaining issues from the local open-source and Windows portable review. No push, public upload, tag or publication is authorized by this preparation work.

| Review item | Local implementation | Remaining work |
| --- | --- | --- |
| Go runtime license | Copy the actual compiler license into `runtime/Go-LICENSE`; record compiler version and digest; reject absent/changed notices | Final artifact validation is recorded below |
| Sharp/libvips redistribution | Lock the exact DLL/SDK bridge and 28 versions; bundle four source/recipe archives, SDK headers/import libraries and a replacement procedure | **Blocked:** exact embedded source/notice closure and native Windows replacement/relink evidence remain incomplete |
| License verification | Parse the versioned inventory, match installed package identities, and check each notice's length/SHA-256 | Regression and artifact checks |
| Required runtime files | Require both launchers and CLI entry scripts; verify the entire `app/` inventory and direct dependencies | Regression and artifact checks |
| Encoder rebuild paths | Quote CMake flag arguments and literal toolchain paths; allow a custom cache | A full Chinese/spaced-path rebuild reproduced SHA-256 `602f9435d65bddefb5bae3145876f23325c56217c50ae84d1941a76a8868fa49` |

Results are recorded in ignored `artifacts/windows-portable-validation.json`, the ZIP's execution report when available, and manifest/checksum sidecars. A previous package's Wine result must not be reused as proof for a new ZIP. A new build without a runner records `execution: not-run`.

## Conditions this Mac cannot close

- **Native Windows acceptance:** no Windows computer or VM is available in the authorized environment. Test the final extracted artifact on native Windows x64: both CLI pipelines, Sharp/BasisU, Unicode/spaced paths and an isolated environment. Verify the minimum declared Windows version and a current version. Wine remains supplementary.
- **Native library replacement/relink:** capture and test a modified ABI-compatible DLL on native Windows using [the replacement procedure](windows-native-redistribution.md). Source collection and successful execution of the original DLL do not establish this result.
- **Actual remote CI evidence:** the cross-platform workflow has not run for this unpushed work. Do not push or trigger an external workflow merely to clear this line during local preparation.
- **Upstream source closure:** pinned recipes and the exact DLL bridge are available, but complete embedded source/notice and toolchain closure is not established by published metadata. Additional upstream evidence or a complete captured rebuild is required. The component pending list is in `vendor/redistribution/windows-x64.json`.

## Maintainer decisions before public distribution

Confirm authority to license historical/employer contributions and the collective NOTICE attribution. Choose verified public repository/support URLs, configure a private security reporting channel and define supported versions. These are organizational/hosting decisions that local tests cannot approve.

`private: true` remains intentional. Removing the npm publication lock, signing, publishing, pushing or creating release tags requires a later explicit release instruction. Source publication and Windows binary distribution have different dependency obligations; this local task authorizes neither.
