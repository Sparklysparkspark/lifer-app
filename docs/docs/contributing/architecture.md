---
title: Architecture
description: How Lifer's API, web app, desktop shell, shared types and data pipeline fit together.
---

# Architecture

This page is a map of the codebase for contributors: what each part does, how they talk to each other, and where data lives. For running it, see [Development setup](./development.md).

Going deeper:

- [Data model](./data-model.md): the database tables by role, and the rules that keep catalog and user data apart.
- [State and sync](./state-and-sync.md): what each update path changes, and what survives a crash or a lost database.
- [Imports and metadata](./imports-and-metadata.md): how photos come in, where they're filed, and what Lifer reads from and writes to files.
- [Security model](../security-model.md): what each deployment protects against.
- [Architecture decisions](./decisions/index.md): why the main choices were made, and what they cost.

## Design principles

These are the rules the code follows most consistently. Each links to the decision behind it.

1. **One codebase, two deployments.** The desktop app and a server run the same API, web app, schema and migrations; only the environment differs ([ADR 0003](./decisions/0003-one-api-for-desktop-and-server.md), [ADR 0001](./decisions/0001-postgresql-everywhere.md), [ADR 0002](./decisions/0002-tauri-shell-with-node-sidecar.md)).
2. **Downloads never overwrite user data.** Catalog tables hold only published data and may be replaced; everything a user adds or changes lives in per-user tables no update writes to ([ADR 0005](./decisions/0005-catalog-separate-from-user-data.md)).
3. **The library is useful without Lifer.** Photos live in a readable species folder tree, and species and ratings are written into the files, so another tool, or a fresh install, can make sense of them ([ADR 0006](./decisions/0006-database-primary-files-carry-recovery-copy.md), [ADR 0007](./decisions/0007-library-layout-species-folders.md)).
4. **Heavy data work happens once, upstream; installs only download and verify.** The maintainer pipeline builds species data and publishes it as checksummed release files; installs check every download's hash ([ADR 0004](./decisions/0004-species-data-shipped-as-release-assets.md)).
5. **Nothing leaves the machine to be identified, and nothing extra has to run.** Models run inside the API process, on plain Postgres with no extensions beyond the standard ones, so there's no second service to install ([ADR 0008](./decisions/0008-in-process-onnx-inference.md), [ADR 0001](./decisions/0001-postgresql-everywhere.md)).

## The big picture

```text
                 ┌──────────────────────────────┐
  Browser ──────▶│  apps/api  (Fastify, Node)    │──────▶ PostgreSQL
  or desktop     │  /api/*   JSON API            │        (Docker container, or
  window         │  /*       built apps/web      │         embedded in the desktop app)
                 │  /maps/*  offline map tiles   │
                 └──────┬───────────────┬────────┘
                        │               │
             inference worker      files on disk
             (worker thread:       DATA_DIR      the photo library
              CLIP, BioCLIP 2,     APP_DATA_DIR  previews, models, map,
              YOLO detector)                     reference photos, downloads

  GitHub releases (built by packages/data-pipeline):
    catalog-latest  packs-latest  photos-latest  map-latest  models
```

One API process serves everything. The same code runs in the Docker image and inside the desktop app; only its environment differs.

## The parts

| Path | What it is |
|---|---|
| `apps/api` | The server. Fastify 5 on Node 22, run with `tsx` in development and compiled to `dist/` by `apps/api/scripts/build.mjs` (esbuild) for Docker and the desktop app. Entry point `src/index.ts`, configuration from environment variables in `src/config.ts`. |
| `apps/web` | The user interface. React 19, Vite and Tailwind, with react-router for pages. Built to static files that the API serves. |
| `apps/desktop` | The desktop app. A Tauri 2 (Rust) window that starts the API as a sidecar process, with its own embedded Postgres. |
| `packages/core` | Code the server and the data pipeline share (`@lifer/core`): configuration, the database pool, species enrichment and matching, region and sea-zone computation, GBIF helpers and the photo license policy. It depends on neither of them. |
| `packages/shared` | TypeScript types and small helpers used by both the API and the web app (`@lifer/shared`). |
| `packages/data-pipeline` | Database migrations, the maintainer scripts, and the tools that build the species catalog, region packs and photo store from source data. |

The dependencies only point one way: `apps/api` and `packages/data-pipeline` use `@lifer/core`, and `@lifer/core` uses neither. Import core modules by path, for example `import { pool } from "@lifer/core/db.js"`.

### apps/api

Routes are grouped by feature, one folder each under `apps/api/src/`, usually with a `routes.ts`: `albums`, `auth`, `collection`, `gallery`, `imports`, `offlinePacks`, `photos`, `regions`, `species`, `trips`, `uploads` and so on. Server-only helpers live in `src/lib/`; anything the data pipeline also needs belongs in `packages/core`. Maintainer scripts live in `packages/data-pipeline/src/scripts/` (see [Data pipeline](./data-pipeline.md)).

Everything under `/api` is the JSON API (documented in [API](../api/overview.md)). `/health` and `/version` sit outside it. When the built web app exists (`WEB_DIST_DIR`, by default `apps/web/dist`), the API serves it too, and sends `index.html` for any other path so the web app's own routing works.

The API doesn't run database migrations itself. The Docker entrypoint (`docker/entrypoint.sh`) and the desktop app each run the migrations first (`packages/data-pipeline/src/migrate.ts`, compiled to `dist/migrate.js`), then start the API. See [Database migrations](./database-migrations.md).

### apps/web

`src/pages/` holds one component per page (with `pages/settings/`, `pages/collection/` and `pages/species/` for the bigger ones), `src/components/` the shared pieces, `src/hooks/` custom React hooks, and `src/lib/` plain helpers. There's no data-fetching or state library: `src/api/client.ts` is a small `fetch` wrapper for `/api`, and hooks like `useSettings` and `useJobPoll` build on it.

In development, Vite proxies `/api` and `/maps` to the API on port 4000.

### apps/desktop

The Rust side (`apps/desktop/src-tauri/src/`) does four things:

- **Embedded Postgres** (`embedded_db.rs`): plain Postgres through the `postgresql_embedded` crate. The engine is downloaded on first launch, the data lives in the app data folder, and each install gets its own password. It restores the species catalog seed bundled with the app before the API first starts.
- **The API sidecar** (`api.rs`): runs migrations, then starts the API with a bundled Node runtime on `127.0.0.1:4310`, with `SINGLE_USER_MODE=1` (no login form), a random secret `LIFER_LAUNCH_TOKEN` that signs in the app's own window and nothing else (see [Security model](../security-model.md#desktop-app)), and a non-secret `LIFER_LAUNCH_ID` that `/health` echoes so the shell knows it's talking to its own API. A crashed API is restarted a couple of times before the app gives up and shows the error.
- **Server mode** (`store.rs`, `lib.rs`): instead of the local API, the window can point at a Lifer server. The saved choice lives in `desktop-config.json`.
- **Matching on this computer** (`local_inference.rs`): when connected to a server, it can run an inference-only API locally so species matching uses this computer's hardware. See [Connect the desktop app to a server](../install/connect-desktop-to-server.md#desktop-assisted-matching).

How the app is built and packaged is on the [Desktop app](./desktop-app.md) page.

## Species matching

Image models run in a worker thread (`packages/core/src/species/inferenceWorker.ts`), so a batch of photos never blocks API requests. `inference.ts` is the main-thread side: a queue with priorities and timeouts. The models run on `onnxruntime-node`:

- **BioCLIP 2** (`bioclip-2-v1`): the species identification model behind suggestions.
- **CLIP ViT-L/14** (`clip-vit-l14-v2`): the general image model for Gallery content search, duplicate detection, and suggestions before BioCLIP 2 is installed.
- **YOLOv8n**: a small detector, bundled in the repository at `packages/core/src/species/models/yolov8n.onnx`, that finds animals in a photo.

The two big models are downloaded on demand into `APP_DATA_DIR/models`. Their reference vectors (one per species photo) ship in the catalog seed, so matching compares a photo's vector against vectors already in the database. On a machine with a faster GPU, `acceleration.ts` checks the GPU gives the same answers and then moves matching onto it. See [GPU acceleration](../install/hardware-acceleration.md).

## Data Lifer downloads

Installs don't build species data themselves. The [data pipeline](./data-pipeline.md) builds it and publishes it as GitHub releases, and the API fetches what it needs:

| Release | What it holds | When an install fetches it |
|---|---|---|
| `catalog-latest` | The catalog seed: every species, region and reference vector, as a compressed SQL dump, plus a manifest with checksums. | On first start with an empty database (`seedCatalogIfEmpty` in `apps/api/src/species/catalogSeedUpdate.ts`), and when you accept a catalog update in Settings. The Docker image and the desktop app also bundle a copy, so a first start works offline. |
| `packs-latest` | Region packs: each region's checklist, as byte ranges inside a few shard files, with `pack-index.json`. | When you download a pack. It's applied to the database and not kept on disk. |
| `photos-latest` | The reference photo store: each reference photo once, in shard files with an index. | Alongside packs. The API fetches only the photos it's missing, by byte range, into `APP_DATA_DIR`. |
| `map-latest` | The offline basemap, one PMTiles file. | When you download the offline map. The API serves it at `/maps/`, and the web app draws it with MapLibre. |
| `models` | The model files, compressed for CPUs, and full-precision copies for GPUs. | When species matching first needs them. |

These data releases are always marked as prereleases, so they never become the repository's "latest" release, which the update checks read.

## Where files live

| Folder | What's in it |
|---|---|
| `DATA_DIR` (`/data` in Docker) | The user's photo library. Lifer writes photos into species folders here, plus small `.lifer` recovery files. |
| `APP_DATA_DIR` (`/app-data` in Docker) | Lifer's own files: photo previews (`display/`, `thumb/`, `medium/`, `video-preview/`), reference photos (`reference-*`), `models/`, `maps/`, `catalog-downloads/`, the `uploads/` work folder, and the GPU runtime. On the desktop, also `postgres-data/` and `postgres-password`. |

Everything in `APP_DATA_DIR` can be downloaded or rebuilt, except the desktop app's `postgres-data/` and `postgres-password`, which are the database. The library and the database are the user's data. [State and sync](./state-and-sync.md#whose-data-is-it) has the full list.

## Updates

The web app's update banner (`apps/web/src/components/UpdatesBanner.tsx`) compares the server's `/version` with the repository's latest GitHub release. The desktop app uses Tauri's updater, which reads `latest.json` from the latest release and checks its signature. See [Releasing](./releasing.md).
