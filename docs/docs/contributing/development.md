---
title: Development setup
description: Run Lifer from source for development, run the tests, and build the desktop app.
---

# Development setup

This page is for working on Lifer itself. To just use Lifer, see [Install](../install/desktop.md).

## Requirements

- Node.js 22 or newer.
- Docker, for a local Postgres. Your own Postgres 16 or newer works too: Lifer needs the `pgcrypto`, `pg_trgm` and `unaccent` extensions, which come with standard Postgres. The app doesn't need PostGIS. Two data pipeline scripts do (`remove-escapes.ts` and `compute-local-tiers.ts` measure distances between region outlines), so the development compose override (`docker/docker-compose.dev.yml`) runs a Postgres 18 image with PostGIS; run `CREATE EXTENSION postgis;` once in that database before a pipeline refresh.
- For the desktop app: Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

## Repository layout

Lifer is an npm workspaces monorepo:

| Path | What it is |
|---|---|
| `apps/api` | Fastify and PostgreSQL backend. `npm run dev -w api` runs it with `tsx`; `npm run build -w api` compiles it to `dist/` for Docker and the desktop app. |
| `apps/web` | React and Vite frontend. |
| `apps/desktop` | Tauri (Rust) shell. Runs the API locally with an embedded Postgres, or points at a remote server. |
| `packages/core` | Code the API and the data pipeline share: configuration, the database pool, enrichment, region computation. |
| `packages/shared` | Types shared between the API and the web app. |
| `packages/data-pipeline` | Database migrations, the species catalog and region pack builders, and every maintainer script. |
| `docker` | The Docker entrypoint and helper scripts, and the development compose file. |
| `docs` | This documentation site (Docusaurus). Not part of the npm workspaces. |

See [Architecture](./architecture.md) for how the pieces fit together.

## Run it locally

From a fresh clone:

```bash
npm install
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml up -d postgres   # Postgres on 127.0.0.1:5432
npm run migrate                 # apply database migrations
npm run dev -w api              # API on http://localhost:4000
npm run dev -w web              # web app on http://localhost:5173, proxies /api to the API
```

On its first start against an empty database, the API downloads the published species catalog by itself (watch its log for "Auto-seeded an empty catalog on first boot"). You only need `npm run build-seed` and `npm run load-seed` when you're working on the catalog from raw source data. See [Data pipeline](./data-pipeline.md).

Open `http://localhost:5173` and create the first account, the same as on a new server.

`docker-compose.yml` keeps the database off the host network, which is right for a server but not for development. `docker/docker-compose.dev.yml` publishes it on `127.0.0.1:5432` only. To skip typing both `-f` flags, copy it to `docker-compose.override.yml` at the repository root, which Compose loads by itself and git ignores:

```bash
cp docker/docker-compose.dev.yml docker-compose.override.yml
docker compose up -d postgres
```

The API reads an optional `.env` file at the repository root. The defaults already match the local Postgres above, so you don't need one to start. If you set `DB_PASSWORD` in that `.env` before the database is first created, also set `DATABASE_URL` to match, and export it in the shell where you run `npm run migrate`, since the migration script doesn't read the root `.env`. See [Environment variables](../install/environment-variables.md).

## Checks

Run these before you push. CI runs the same ones.

```bash
npm run lint              # ESLint
npm run format            # Prettier, rewrites files (format:check only checks)
npm run typecheck         # every workspace
npm test                  # unit tests in every workspace
npm run build             # every workspace with a build step
npm run check:em-dashes   # no em dashes anywhere, a house rule
npm run check:migrations  # migration file names and numbers
```

See [Testing](./testing.md) for integration tests, and [Code standards](./code-standards.md) for the conventions reviewers look for.

## Desktop app

```bash
npm start -w desktop   # tauri dev
```

The desktop app bundles the same API as a sidecar process and runs Postgres embedded, so there's no separate database to install. See [Desktop app](./desktop-app.md) for how it's built and packaged.

## Docker image

To build and run a local image instead of the published one:

```bash
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml build api
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml up -d
```

This tags the image `lifer-app:dev`. The image serves the API and the built web app on one port, and runs migrations on every start. Releases are built by `.github/workflows/release.yml`. See [Releasing](./releasing.md).

## Documentation

The docs live in `docs/` and are published to GitHub Pages by `.github/workflows/docs.yml`.

```bash
cd docs
npm install
npm start        # live preview at http://localhost:3000
npm run build    # fails on any broken link
```

Pages are Markdown files in `docs/docs/`. The sidebar is defined in `docs/sidebars.ts`.
