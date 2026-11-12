# Optional local compatibility runner. It never forms part of the product ZIP.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends wine64 xvfb xauth ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV WINEARCH=win64 WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml=d LANG=C.UTF-8
COPY scripts/portable-wine-entrypoint.sh /usr/local/bin/model-optimizer-wine
ENTRYPOINT ["/bin/sh", "/usr/local/bin/model-optimizer-wine"]
