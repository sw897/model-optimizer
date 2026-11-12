#!/bin/sh
# Wine derives its child loader from argv[0] beside wine64. Preserve this
# alias so launcher -> Node -> encoder children all use the same emulator.
exec /usr/local/bin/qemu-x86_64-static -cpu Nehalem -0 /usr/lib/wine/model-optimizer-wine64 /usr/lib/wine/wine64 "$@"
