---
id: 0009-compiled-server
title: "ADR 0009: Compiled server"
description: Production runs the API as JavaScript compiled by esbuild instead of running TypeScript through tsx.
---

# ADR 0009: The production server is compiled with esbuild

**Status:** Accepted, in the next release (listed under Unreleased in `CHANGELOG.md`).

## Context

From the first Dockerfile (2026-08-22) until this change, the API and the data pipeline ran their TypeScript directly through `tsx` in production, "same as `npm run dev` does locally, so there's nothing to compile". The desktop sidecar did the same. That meant shipping TypeScript tooling in the Docker image and the desktop bundle.

## Decision

`apps/api/scripts/build.mjs` compiles the API and the migration script with esbuild to `dist/`, and production runs `node dist/index.js`; development still uses `tsx`. Lifer's own workspaces (`apps/api`, `packages/core`, `packages/shared`, `packages/data-pipeline`) are bundled, and npm packages stay external in `node_modules`. The changelog: "The server runs as compiled JavaScript instead of TypeScript through tsx, so the Docker image and desktop app no longer ship TypeScript tooling."
## Alternatives considered

- **`tsx` in production:** the previous setup, simple and identical to development.
- **`tsc` without bundling:** not recorded as considered.

## Consequences

Positive:

- No TypeScript compiler or loader in the shipped artifacts. The changelog records smaller artifacts in the same release (the Docker image from about 840 to 490 MB on x86-64), though it credits that partly to tracing dependencies, not only to compiling.

Negative:

- **Production runs different code from development.** Bugs that only appear once bundled are possible.
- **Module-relative paths break when bundled.** Each output sits at the same depth as its source so repository-relative paths still work, and the build fails if a bundled module computes paths from `import.meta.url` outside a checked list (`build.mjs`). Files such as the bundled detector model are copied next to the output.
- One more build step for Docker and the desktop app to get right.
