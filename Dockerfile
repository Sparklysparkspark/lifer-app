# One container serves the API and the built web app on one port, so a proxy needs one upstream.
# Debian slim, not Alpine: sharp and exiftool-vendored ship glibc binaries, and exiftool needs perl.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build stage: full install to build the web app and fetch the catalog seed.
FROM base AS build
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/data-pipeline/package.json packages/data-pipeline/package.json
RUN npm ci
COPY . .
RUN npm run build -w web
# Bundled so a fresh container shows countries and checklists offline on first launch.
RUN node apps/api/scripts/fetch-catalog-seed.js

# Runtime stage: production deps of the server workspaces only (no vite, typescript, web deps).
FROM base AS runtime
# Vulkan and Mesa drivers let matching use a passed-in Intel/AMD GPU (python3-minimal: Mesa needs a python).
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers python3-minimal \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/data-pipeline/package.json packages/data-pipeline/package.json
# onnxruntime-node ships macOS and Windows binaries too; only Linux ones can load here.
RUN npm ci --omit=dev -w api -w data-pipeline -w @lifer/shared \
  && find node_modules -type d -path '*onnxruntime-node/bin/napi-v*' \( -name darwin -o -name win32 \) -prune -exec rm -rf {} + \
  && npm cache clean --force && rm -rf /root/.npm
# tsx runs the TypeScript sources directly; it's a dev dependency, so it's copied in on its own.
COPY --from=build /app/node_modules/tsx node_modules/tsx
COPY --from=build /app/node_modules/esbuild node_modules/esbuild
COPY --from=build /app/node_modules/@esbuild node_modules/@esbuild
COPY apps/api apps/api
COPY packages/shared packages/shared
COPY packages/data-pipeline packages/data-pipeline
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/catalog-seed catalog-seed

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/lifer-entrypoint
COPY --chmod=755 docker/lifer-admin.sh /usr/local/bin/lifer-admin
COPY --chmod=755 docker/fix-permissions.sh /usr/local/bin/lifer-fix-permissions
# data-pipeline caches province boundaries under /app/data; point that at the app-data volume.
# Docker copies these dirs' owner and mode onto an empty named volume at every mount, so they're
# open to any uid; the permissions service (or TrueNAS's) sets the owner of real content.
RUN ln -s /app-data/pipeline-cache /app/data \
  && mkdir -p /data /app-data/pipeline-cache \
  && chown 568:568 /data /app-data /app-data/pipeline-cache \
  && chmod 0777 /data /app-data /app-data/pipeline-cache

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="Lifer" \
      org.opencontainers.image.description="Self-hosted, species-indexed life-list app for wildlife photography." \
      org.opencontainers.image.source="https://github.com/Sparklysparkspark/lifer-app" \
      org.opencontainers.image.url="https://sparklysparkspark.github.io/lifer-app/" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${APP_VERSION}"

# Read by GET /version for the web app's update banner.
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production
ENV PORT=4000
ENV DATA_DIR=/data
ENV APP_DATA_DIR=/app-data
# Any uid can run this image, with or without a passwd entry, so HOME is somewhere writable.
ENV HOME=/tmp
# Returns freed model memory to the system instead of holding the peak after an import.
ENV MALLOC_ARENA_MAX=2
ENV MALLOC_MMAP_THRESHOLD_=131072
ENV MALLOC_TRIM_THRESHOLD_=131072

USER 568:568
EXPOSE 4000

# First boot runs every migration before the server listens, which can take a minute on a NAS.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --start-interval=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/lifer-entrypoint"]
