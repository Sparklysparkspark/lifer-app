# Single-container image: the API (Fastify) serves both /api and the built web app on one
# port — per explicit choice, so a reverse proxy (nginx, DuckDNS, etc. — configured entirely
# on the host, not here) only ever needs one upstream to point at.
#
# node:20-slim (Debian), not -alpine — sharp and exiftool-vendored both ship native
# binaries; sharp's prebuilt binaries and libvips target glibc, and Alpine's musl libc is a
# common, well-documented source of native-module breakage for exactly these two packages.
# exiftool-vendored also bundles a Perl script, so perl is installed explicitly below rather
# than assumed present.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Installed once, at the repo root, per npm workspaces — every workspace's dependencies
# resolve into one shared node_modules, same as local development.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/data-pipeline/package.json packages/data-pipeline/package.json
RUN npm ci

COPY . .

# Only the web app has an actual build step (vite build -> static assets) — the API and
# data-pipeline run their TypeScript directly via tsx, same as `npm run dev` does locally,
# so there's nothing to compile for them.
RUN npm run build -w web

# Baked in at build time from the pushed release tag (see .github/workflows/release.yml's
# docker-image job) so a running container can report its own version — GET /version, read by
# the self-hosted web app's own update-available banner (DockerUpdateBanner.tsx) to compare
# against the latest GitHub release. Empty/"dev" for a local `docker build` with no arg passed.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production
EXPOSE 4000

# Migrations run on every container start (migrate.ts already tracks what's applied and
# skips it — see packages/data-pipeline/src/migrate.ts — so this is safe/idempotent on a
# restart, not just a first boot) rather than needing a separate manual step.
CMD ["sh", "-c", "npm run migrate -w data-pipeline && npm run start -w api"]
