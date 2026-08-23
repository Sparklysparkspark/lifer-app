# Contributing

## Requirements

Node 22+ and a local Postgres with PostGIS (`docker compose up postgres` gets you one).

## Setup

```bash
npm install
npm run migrate
npm run load-seed        # or build-seed first if starting from raw source data
npm run dev -w api        # http://localhost:4000
npm run dev -w web        # http://localhost:5173, proxies /api to the API above
```

## Checks

```bash
npm run typecheck   # every workspace
npm test            # data-pipeline's unit tests
npm run build        # web build + typechecks
```

CI (`.github/workflows/ci.yml`) runs all three against a real Postgres on every push.

## Repository layout

npm workspaces monorepo:

| Path | What it is |
|---|---|
| `apps/api` | Fastify + PostgreSQL backend. Runs directly via `tsx`, no build step. |
| `apps/web` | React + Vite frontend. |
| `apps/desktop` | Electron shell — spawns the API locally, or points at a remote server. |
| `packages/shared` | Types shared between `apps/api` and `apps/web`. |
| `packages/data-pipeline` | Species seed data, migrations, enrichment scripts, region-pack builder. |
