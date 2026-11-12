#!/bin/sh
set -eu

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp >/tmp/model-optimizer-xvfb.log 2>&1 &
model_optimizer_xvfb_pid=$!
model_optimizer_attempt=0
# Poll readiness rather than xvfb-run's SIGUSR1 handshake, which can stall
# under Docker Desktop's amd64 translation on an ARM host.
while [ ! -S /tmp/.X11-unix/X99 ]; do
  if ! kill -0 "$model_optimizer_xvfb_pid" 2>/dev/null || [ "$model_optimizer_attempt" -ge 50 ]; then
    cat /tmp/model-optimizer-xvfb.log
    exit 1
  fi
  model_optimizer_attempt=$((model_optimizer_attempt + 1))
  sleep 0.1
done
# Docker's attached streams are Unix sockets. Wine/libuv may misclassify
# these as Windows pipes; regular files give the initial Windows process
# valid stdio handles. Child-process pipes are still exercised by the test.
model_optimizer_status=0
# Bound runaway diagnostics in a failed emulator without limiting reads of
# the bundled runtime. Normal test outputs are much smaller than this cap.
ulimit -f 131072
"${WINELOADER:-/usr/lib/wine/wine64}" "$@" >/tmp/model-optimizer-windows.log 2>&1 || model_optimizer_status=$?
cat /tmp/model-optimizer-windows.log
exit "$model_optimizer_status"
