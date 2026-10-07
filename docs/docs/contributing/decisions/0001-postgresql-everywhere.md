---
id: 0001-postgresql-everywhere
title: "ADR 0001: PostgreSQL everywhere"
description: Lifer uses PostgreSQL on servers and an embedded PostgreSQL in the desktop app, rather than SQLite.
---

# ADR 0001: PostgreSQL everywhere, embedded in the desktop app

**Status:** Accepted. The server has used Postgres since the first API commit (`9c2ca46`, 2026-08-22); the desktop app has embedded it since `cf8b3ca` (2026-08-29).

## Context

Lifer runs as a server (Docker, one or more devices reaching it over the network) and as a desktop app (one person, offline). The same API runs in both ([ADR 0003](./0003-one-api-for-desktop-and-server.md)). Before `cf8b3ca`, the desktop app's local mode needed a Postgres the user ran themselves; that commit says it "removes the last manual-setup requirement for local/offline mode (previously needed a separately-running Postgres)".

The catalog is large: about 134,000 species, 8,000 regions and 2.5 million checklist rows ([Rebuilding the data](../rebuilding-data.md)). Catalog updates merge into it in one transaction ([State and sync](../state-and-sync.md#catalog-updates)).

## Decision

Use PostgreSQL in every deployment. On the desktop, run plain Postgres through the [`postgresql_embedded`](https://github.com/theseus-rs/postgresql-embedded) crate (`apps/desktop/src-tauri/src/embedded_db.rs`), with its data in the app data folder, a random per-install password, and an OS-chosen port. Restrict the schema to extensions every standard Postgres has (`pgcrypto`, `pg_trgm`, `unaccent`) so that plain, prebuilt Postgres binaries work on every platform. Geometry and vector math are done in TypeScript, not in the database.

The reason for no PostGIS is recorded in the code. The original `embedded_db.rs` header said the schema "never actually calls any PostGIS function", which is what made embedding plain Postgres viable, since "bundling PostGIS's native GEOS/PROJ/GDAL dependencies portably across three OSes would have been a much harder problem." The current header: "Plain Postgres, no PostGIS: the schema never calls a PostGIS function, and geometry lives in TS."

Postgres rather than SQLite, for three reasons:

- **One codebase and one SQL dialect.** The desktop app and a server run the same queries and the same migrations, so a desktop library moves to a server with no schema translation: the server is the same database design, and [migration](../state-and-sync.md#moving-a-desktop-library-to-a-server) replays the library through the server's ordinary upload API.
- **One catalog seed format.** The seed is a `pg_dump` that the desktop app loads with `psql` and a server merges with `COPY`; a second database engine would need a second seed and a second merge path.
- **Postgres features the code relies on**, which SQLite lacks or provides differently: `pg_trgm` `similarity` and `word_similarity` with `unaccent` for fuzzy species search (`apps/api/src/species/search.ts`); advisory locks to serialise migrations, first-run registration, and catalog, pack and vector jobs (`migrate.ts`, `auth/routes.ts`, `packages/core/src/lib/referenceDataLock.ts`); statement-level triggers that keep the collection version and search names current (M111); and `jsonb`, arrays, `DISTINCT ON` and `LATERAL` joins throughout the queries.

## Alternatives considered

- **A Postgres the user installs and runs** (the earlier desktop setup): rejected as manual setup.
- **SQLite on the desktop, Postgres on servers:** rejected for the reasons above: two dialects, two migration sets, two seed formats, and the features in the last list rewritten for SQLite.
- **PGlite** (Postgres compiled to WebAssembly, running inside the Node process): not adopted yet. It would remove the separate database process, but it's young, allows a single connection, and its performance at the catalog's size (millions of checklist rows, merged in one transaction) is unproven.
- **PostGIS and pgvector:** used before, or available in the pipeline's database, but kept out of the app so the embedded build stays plain. The maintainer pipeline still needs PostGIS for two scripts ([Development setup](../development.md#requirements)).

## Consequences

Positive:

- One schema, one migration path (`packages/data-pipeline/migrations`) and one set of SQL for both deployments.
- The catalog seed is a `pg_dump` loaded with `psql` or merged with `COPY`, and installs restore it in about a minute.
- Moving a desktop library to a server needs no schema translation ([State and sync](../state-and-sync.md#moving-a-desktop-library-to-a-server)).
- Fuzzy search, job locking and cache invalidation use the database's own features instead of application code.

Negative:

- **First launch needs the internet** in released versions: `postgresql_embedded` downloads the engine from the theseus-rs release archives into `~/.theseus/postgresql/` ([Requirements](../../install/requirements.md)).
- **macOS 15 or later** in released versions, because of the engine binaries that download provides ([Install the desktop app](../../install/desktop.md)).
- Both of these are being removed. Work in progress in `apps/desktop` bundles a checksum-pinned Postgres in the app (`scripts/stage-postgres.js`; `embedded_db.rs` runs it in place and downloads nothing) and builds the macOS binaries for an older target (`scripts/build-postgres-macos.sh`, `MACOSX_DEPLOYMENT_TARGET=11.0`; `tauri.conf.json` sets `minimumSystemVersion` 14.0). Until that ships in a release, the two costs above apply. The bundled engine makes the installer larger.
- A full database server per desktop install: stale lock files, PID reuse after a crash, a per-install password with a migration from the older shared one, and a watchdog to stop Postgres when the app dies, all handled in `embedded_db.rs`.
- **Major Postgres versions need a data upgrade on every desktop install.** The path for it exists: `apps/desktop/src-tauri/src/pg_upgrade.rs` runs `pg_upgrade` (a clone or copy, falling back to a dump and restore) on the first launch after the app moves to a new major, keeps the old data folder until the user deletes it, and recovers from a crash part way through. It needs the previous major's server, which the release that changes majors bundles for a few releases (about 18 MB more on macOS). The 17 to 18 jump is tested end to end on both Mac architectures (`apps/desktop/src-tauri/tests/pg-upgrade-test.sh`). See [Upgrading the bundled PostgreSQL to a new major version](../desktop-app.md#new-major).
- No vector index: species matching ranks candidates in JavaScript over `real[]` columns (`packages/core/src/species/embeddings.ts`), since the embedded Postgres has no pgvector. Region geometry is computed in TypeScript.
- Backups need `pg_dump` or a stopped app; copying a live data folder isn't safe ([Backup and restore](../../install/backup-restore.md)).
