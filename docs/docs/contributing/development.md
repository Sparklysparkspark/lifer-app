---
title: Development setup
description: Run Lifer from source for development, run the tests, and build the desktop app.
---

# Development setup

This page is for working on Lifer itself. To just use Lifer, see [Install](../install/desktop.md).

## Requirements

- Node.js 22 or newer.
- Docker, for a local Postgres (or your own Postgres 14 or newer).
- For the desktop app: Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

## Repository layout

Lifer is an npm workspaces monorepo:

| Path | What it is |
|---|---|
| `apps/api` | Fastify and PostgreSQL backend. Runs directly with `tsx`, no build step. |
| `apps/web` | React and Vite frontend. |
| `apps/desktop` | Tauri (Rust) shell. Runs the API locally with an embedded Postgres, or points at a remote server. |
| `packages/shared` | Types shared between the API and the web app. |
| `packages/data-pipeline` | Species seed data, migrations, enrichment scripts and the region pack builder. |
| `docs` | This documentation site (Docusaurus). Not part of the npm workspaces. |

## Run it locally

```bash
npm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres   # Postgres on localhost:5432
npm run migrate                 # apply database migrations
npm run dev -w api              # API on http://localhost:4000
npm run dev -w web              # web app on http://localhost:5173, proxies /api to the API
```

On its first start against an empty database, the API downloads the published species catalog by itself (watch its log for "Auto-seeded an empty catalog"). You only need `npm run build-seed` and `npm run load-seed` when you're working on the catalog from raw source data.

Open `http://localhost:5173` and create the first account, the same as on a new server.

`docker-compose.yml` keeps the database off the host network, which is right for a server but not for development. `docker-compose.dev.yml` adds the port back, on `127.0.0.1:5432` only. To skip typing both `-f` flags, copy it to `docker-compose.override.yml`, which Compose loads by itself and git ignores:

```bash
cp docker-compose.dev.yml docker-compose.override.yml
docker compose up -d postgres
```

The API reads an optional `.env` file at the repository root. The defaults already match the local Postgres above, so you don't need one to start. See [Environment variables](../install/environment-variables.md).

## Migrations

Migrations are SQL files in `packages/data-pipeline/migrations`, applied in order by `npm run migrate`. It records what it has applied and skips it next time, so it's safe to run repeatedly. The Docker image runs it on every start.

## Checks

```bash
node scripts/check-em-dashes.mjs   # no em dashes anywhere, a house rule
npm run typecheck        # every workspace
npm test                 # data-pipeline unit tests
npm test -w api          # API tests
npm test -w web          # web app tests
npm run build            # every workspace with a build step
```

CI (`.github/workflows/ci.yml`) runs these against a real Postgres on every push to `main` and every pull request. Integration tests (`*.integration.test.ts`) are skipped unless `TEST_DATABASE_URL` points at a migrated database you don't mind losing, because they write to it. Never point it at a database you use.

## Desktop app

```bash
npm start -w desktop   # tauri dev
```

The desktop app bundles the same API as a sidecar process and runs Postgres embedded, so there's no separate database to install.

To build an installer:

```bash
npm run dist -w desktop
```

This builds the web app, stages the API and its dependencies, downloads a Node runtime for the sidecar and the species catalog seed, runs the Tauri build, and on macOS re-signs the bundle with the folder-access descriptions macOS needs. See `apps/desktop/README.md` for each step.

## Docker image

```bash
docker compose build api
docker compose up -d
```

The image serves the API and the built web app on one port. Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed, and published to `ghcr.io/sparklysparkspark/lifer-app`.

## Documentation

The docs live in `docs/` and are published to GitHub Pages by `.github/workflows/docs.yml`.

```bash
cd docs
npm install
npm start        # live preview at http://localhost:3000
npm run build    # fails on any broken link
```

Pages are Markdown files in `docs/docs/`. The sidebar is defined in `docs/sidebars.ts`.
