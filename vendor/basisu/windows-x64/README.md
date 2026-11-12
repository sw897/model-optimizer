# Reviewed Windows x64 Basis Universal encoder

This is a CPU-only Release build of Basis Universal 1.16.3 from commit `1531cfaf9ed5232248a0a45736686a849ca3befc`, compiled with llvm-mingw 20261104 (Clang 23.1.5).

Configuration: `Release`, `STATIC=ON`, `SSE=OFF`, `OPENCL=OFF`, `ZSTD=ON`, `-O2 -DNDEBUG`. C++/compiler runtimes are linked statically. The executable imports only Windows system APIs/UCRT API sets, with no OpenCL, debug CRT or external VC++ runtime dependency. It requires Windows 10 version 1903 or later and the baseline x64 instruction set.

SHA-256: `602f9435d65bddefb5bae3145876f23325c56217c50ae84d1941a76a8868fa49`.

Source archive and compiler archive URLs/digests are locked in [native-tools.lock.json](../../../native-tools.lock.json). The macOS reproduction script uses path prefix mapping and a zero PE timestamp; a rebuild in a different source directory reproduced this exact hash locally. See [the build and validation guide](../../../docs/windows-portable.md).

Upstream C++ source files were not modified. The separately supplied application manifest opts into a UTF-8 process code page and long-path awareness. Licenses and copyright notices for Basis Universal, Zstandard and statically linked LLVM/MinGW components are retained in `licenses/`. Those components keep their respective licenses. This executable is independent of the `basisu` npm wrapper, which is excluded from the Windows portable package.
