ARG BASE_IMAGE=model-optimizer-wine-base:local
FROM ${BASE_IMAGE}
COPY qemu-x86_64-static /usr/local/bin/qemu-x86_64-static
COPY portable-wine-loader.sh /usr/lib/wine/model-optimizer-wine64
COPY portable-wine-entrypoint.sh /usr/local/bin/model-optimizer-wine
COPY runner.json /opt/model-optimizer-wine-runner.json
RUN chmod +x /usr/local/bin/qemu-x86_64-static /usr/lib/wine/model-optimizer-wine64
ENV WINELOADER=/usr/lib/wine/model-optimizer-wine64
ENTRYPOINT ["/bin/sh", "/usr/local/bin/model-optimizer-wine"]
