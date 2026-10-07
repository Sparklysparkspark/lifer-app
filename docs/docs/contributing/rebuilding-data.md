---
title: Rebuilding the data
description: Rebuild every species data release Lifer publishes, from an empty machine, on a fork.
---

# Rebuilding the data

This page takes you from a fork and an empty machine to your own copy of every data release Lifer publishes: the catalog seed, the offline packs, the photo store, the offline map and the model files. It's written so you can do it without asking the maintainer. [Data pipeline](./data-pipeline.md) explains what the pipeline is for; this page is how to run it.

Budget for it: a machine with about 200 GB free, a GBIF account, and several days, most of it waiting on GBIF and iNaturalist.

## What gets published

| Release | Files | Built by | How installs find it |
|---|---|---|---|
| `catalog-latest` | `lifer-catalog-seed.sql.gz`, one `*.bin.gz` per vector table, `catalog-manifest.json` | the refresh's `publish` stage (`src/scripts/build-catalog-seed.ts`) | `CATALOG_MANIFEST_URL` in `packages/core/src/config.ts`; the Docker image and desktop installer bundle it at build time |
| `packs-latest` | `pack-index.json` and pack shards (`lifer-packs-<build>-<n>.bin`) | the `packs` and `publish` stages (`src/pipeline/packs.ts`, `packStore.ts`) | `PACK_INDEX_URL` |
| `photos-latest` | `lifer-photo-store.json.gz` and photo shards (`lifer-photos-<build>-<n>.bin`) | the same stages (`src/pipeline/photoStore.ts`) | the `photoStore.indexUrl` inside `pack-index.json` |
| `map-latest` | `world-z8.pmtiles` | by hand, not in this repository (see [The offline map](#the-offline-map)) | `MAP_DOWNLOAD_URL` |
| `models` | `clip-vit-l14-v2.onnx`, `bioclip-2-v1.onnx`, `bioclip-2-v1-fp32.onnx` | by hand, `packages/data-pipeline/python/export_*.py` (see [The model files](#the-model-files)) | `EMBEDDING_MODEL_URL`, `ID_MODEL_URL`, `ID_MODEL_GPU_URL` |

For scale, the published releases in October 2026: the catalog seed 208 MB plus about 820 MB of vector files, packs 2.5 GB, the photo store 8.6 GB, the map 525 MB, the models 1.7 GB.

## Prerequisites

### Machine

| | Needed | Notes |
|---|---|---|
| Operating system | macOS or Linux | The pipeline shells out to `unzip`, `du`, `npx` and `gh`. On Windows, use WSL 2. |
| Memory | 24 GB or more | Each country's province pass runs with a 16 GB heap (`refresh-all-provinces.ts`), next to Postgres. The maintainer's runs use a 24 GB Mac. |
| GPU | Recommended | The identification model's vectors (`python/compute_id_model_vectors.py`) use an Apple Silicon GPU (`mps`) or CUDA when there is one. On a CPU they take many hours longer. |
| Disk | About 200 GB free | See the table below. |

Disk, from the maintainer's machine in October 2026:

| What | Where | Size |
|---|---|---|
| GBIF country downloads, one zip per country (239) | `packages/data-pipeline/data/gbif-country-cache` | 64 GB |
| Province aggregates, built from those zips | `packages/data-pipeline/data/province-aggregate-cache` | 99 GB |
| Build output: photo store and pack shards, catalog seed | `packages/data-pipeline/data/build` | up to about 15 GB during a full build |
| Reference photos (display and thumbnail sizes) | `APP_DATA_DIR`, under `reference-display/` and `reference-thumb/` | about 9 GB |
| Postgres data | the Docker volume | 14 GB |
| Raw source downloads (trait tables, sea areas, boundaries) | `data/raw` at the repo root | under 1 GB |
| iNaturalist and eBird caches | `packages/data-pipeline/data/inat-*`, `ebird-spplist-cache` | about 150 MB |
| Python environment and model weights | `packages/data-pipeline/.venv`, the Hugging Face cache in your home folder | a few GB |

### Software

- **Node.js 22** or newer (the repo's `.nvmrc`).
- **Docker**, for Postgres with PostGIS.
- **Python 3.10 or newer**, for the identification model's vectors. The maintainer uses 3.14.
- **`unzip`**, which reads the GBIF country files.
- **`gh`**, the GitHub CLI, signed in, to publish.
- **`pg_dump` 18**, for the catalog seed. Installs restore it into Postgres 18. The refresh picks one in this order (`packages/data-pipeline/src/pipeline/pgDump.ts`), and `npm run doctor -w data-pipeline` shows which:
  1. `PG_DUMP_BIN`, when set.
  2. A desktop app build's, which bundles `pg_dump`: the folder `LIFER_POSTGRES_DIR` names (a `build-postgres-macos.sh` output), then the one `npm run prepare-resources -w desktop` staged in `apps/desktop/src-tauri/resources-staging/postgres`, then an installed `/Applications/Lifer.app` on a Mac.
  3. When `DATABASE_URL` points at a port on this machine that a running Docker container publishes from its 5432 (the pipeline's usual Postgres), that container's own `pg_dump`, through `docker exec`.
  4. `pg_dump` on your `PATH`. Install the Postgres 18 client tools if none of the above applies.

### Accounts and keys

- **GBIF.org account** (free, [gbif.org](https://www.gbif.org/)): `GBIF_USER` and `GBIF_PWD`. The pipeline submits one SQL download per country with it. GBIF lets an account run 3 downloads at once, and the pipeline waits for a free slot.
- **eBird API key** (free, [ebird.org/api/keygen](https://ebird.org/api/keygen)): `EBIRD_API_KEY`. Without it the refresh still runs, but province bird lists don't get eBird's region lists to keep birds GBIF has few records of.
- **GitHub**: a fork of the repository, and `gh` signed in with permission to write to it (see [Publishing to your fork](#publishing-to-your-fork)).

iNaturalist, Catalogue of Life (ChecklistBank), Wikipedia, Wikidata and Hugging Face need no account.

### Environment variables

Put them in `.env` at the repo root (every pipeline script reads it) or export them. A variable set in the shell wins over `.env`.

| Variable | Needed | What it's for |
|---|---|---|
| `DATABASE_URL` | Required | The pipeline database. Always set it explicitly: without it, scripts fall back to `postgres://lifer:lifer@localhost:5432/lifer`. |
| `GBIF_USER`, `GBIF_PWD` | Required | GBIF country downloads (`compute-provinces-bulk.ts`). |
| `EBIRD_API_KEY` | Recommended | eBird region species lists (`compute-provinces-bulk.ts`, `report-vagrant-ebird.ts`). |
| `LIFER_DATA_REPO` | Publishing to a fork | Your fork (`owner/name`): the releases the build compares against and publishes to. Defaults to upstream. |
| `PG_DUMP_BIN` | Optional | The `pg_dump` for the catalog seed. Default: a desktop build's, else the Docker container's behind `DATABASE_URL`, else `pg_dump` on your `PATH` (see [Software](#software)). |
| `APP_DATA_DIR` | Optional | Where reference photos are saved. Default: `DATA_DIR` when that's set, else `data/lifer-app-data`. |
| `DATA_DIR` | Optional | The app's library folder; also the photo folder when `APP_DATA_DIR` isn't set. |
| `LIFER_INAT_CACHE_MAX_AGE_DAYS` | Optional | How long cached iNaturalist lists are reused. Default 90. |
| `LIFER_INAT_OFFLINE` | Optional | `1` answers every iNaturalist question the caches can from the caches. |
| `INAT_MIN_HOST_INTERVAL_MS` | Optional | The pause between requests to one photo host during enrichment. Default 1000. Don't lower it for iNaturalist. |
| `PHOTO_STORE_FROM_SCRATCH` | Optional | `1` writes every photo store shard anew instead of reusing published ones (see [The photo store](#the-photo-store)). |
| `PACK_CONCURRENCY` | Optional | Packs built at once. Default 6. |
| `ALLOW_MISSING_PHOTOS` | Optional | `1` lets `build-region-pack.ts` build past a missing photo file. Not for a run you publish. |
| `LIFER_ALLOW_NONCOMMERCIAL_PHOTOS` | Optional | Local development only: widens the photo fetchers. Publishing refuses non-publishable photos either way. |
| `EMBEDDING_MODEL_VERSION`, `TEXT_MODEL_VERSION`, `GALLERY_MODEL_VERSION` | Optional | Override which vectors the catalog seed exports. Only during a model change. |
| `CLIP_V2_FP32_MODEL` | Optional | The full-precision CLIP file for `regenerate-clip-vectors.ts`. |
| `LIFER_BUILD_ID` | Optional | Which `data/build/<id>` folder at the repo root `load-seed` reads (see [Build from raw sources](#alternative-build-from-raw-sources)). |
| `LIFER_POSTGRES_CONTAINER` | Optional | The Postgres container's name, if the doctor can't find it from the port. Also used by `backup.ts`. |
| `TEST_DATABASE_URL` | Tests only | The database integration tests use. |

## Set up the machine

```bash
git clone https://github.com/<you>/lifer-app.git
cd lifer-app
npm install

# Postgres 18 with PostGIS, on 127.0.0.1:5432, with 256 MB of shared memory
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml up -d postgres
export DATABASE_URL=postgres://lifer:lifer@127.0.0.1:5432/lifer
npm run migrate
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml exec postgres \
  psql -U lifer -d lifer -c 'CREATE EXTENSION IF NOT EXISTS postgis;'

# The identification model's Python environment, once
python3 -m venv packages/data-pipeline/.venv
packages/data-pipeline/.venv/bin/pip install -r packages/data-pipeline/python/requirements.txt
```

A new database volume from the dev image already has PostGIS; the `CREATE EXTENSION` is for one created before you switched to it, and is harmless otherwise. If you run Postgres with `docker run` instead of the compose files, add `--shm-size=256m` (see [Troubleshooting](#troubleshooting)).

Then put `GBIF_USER`, `GBIF_PWD` and `EBIRD_API_KEY` in `.env` and check everything:

```bash
npm run doctor -w data-pipeline              # what a refresh needs
npm run doctor -w data-pipeline -- --publish # also what publishing needs
```

The doctor only reads. It checks Node, the operating system and memory, the variables a refresh reads (it never prints a secret's value), that the database answers, is fully migrated and has PostGIS, Postgres's shared memory when it runs in Docker, the Python environment and its packages, `unzip`, `pg_dump`'s version against the server's, `gh` and where it would publish, each cache's size, and free disk against what the caches still need. It exits 1 when a check fails. Here is its output, shortened, on a freshly migrated scratch database started with plain `docker run` (hence the shared memory warning) and the published catalog seed loaded, on the maintainer's machine, so the caches are full:

```text
PASS  Operating system: darwin
PASS  Node.js: v22.22.1
PASS  Memory: 24.0 GB of RAM
PASS  env DATABASE_URL: set
PASS  env GBIF_USER: set
PASS  env GBIF_PWD: set
PASS  env EBIRD_API_KEY: set
PASS  env PG_DUMP_BIN: not set: pg_dump for the catalog seed (default: a desktop build's bundled one, else the Docker container's behind DATABASE_URL, else pg_dump on PATH)
...
PASS  Database: postgres://lifer:***@127.0.0.1:55510/lifer, Postgres 18.6
PASS  Migrations: all 120 applied
PASS  PostGIS extension: installed
PASS  Catalog: 134129 species, 74938 on a checklist, 0 with a photo file on disk
WARN  Postgres shared memory (/dev/shm): 64 MB in container lifer-doctor-pg
      fix: recreate it with --shm-size=256m, or use the compose files (shm_size: 256mb)
PASS  Python environment: Python 3.14.3, torch, open_clip, psycopg2, pillow, onnx and onnxruntime import
PASS  GPU for the identification model: mps
PASS  unzip: on PATH
PASS  pg_dump for the catalog seed: pg_dump 18 (docker exec -i lifer-postgres-1 pg_dump, from Docker container lifer-postgres-1)
PASS  GitHub CLI (gh): signed in
PASS  Publish target: gh publishes to Sparklysparkspark/lifer-app, the repo pack and photo URLs point at
PASS  Release catalog-latest: exists on Sparklysparkspark/lifer-app
PASS  Cache: GBIF country downloads: 64.0 GB in packages/data-pipeline/data/gbif-country-cache (239 country files)
PASS  Cache: province aggregates: 99.1 GB in packages/data-pipeline/data/province-aggregate-cache (rebuilt from the country files)
...
PASS  Free disk (disk holding packages/data-pipeline/data/gbif-country-cache): 46.1 GB free, about 45.1 GB still needed for ...

36 passed, 1 warning(s), 0 failed, 0 skipped
```

On a new machine, expect a warning for each empty cache: the refresh fills them.

## Point your fork at itself

Pack and photo URLs are written into the files you publish, so do this before the first build:

1. **`LIFER_DATA_REPO`**: set it to `<you>/lifer-app` in `.env` (it overrides `GITHUB_REPO` in `packages/data-pipeline/src/build/release-groups.ts`). Every shard URL in `pack-index.json`, the photo store URL in it, and the published indexes the build compares against all come from it. Left at the upstream value, your build reuses upstream's photo shards and your index points installs at upstream's files.
2. **`gh repo set-default <you>/lifer-app`**: the pipeline's `gh release` calls name no repository, so they go to gh's default for this checkout. The doctor's "Publish target" check fails while the two disagree.
3. **Create `catalog-latest`** once. The publish stage creates `packs-latest` and `photos-latest` itself, but only uploads to `catalog-latest`:

   ```bash
   gh release create catalog-latest --title "Catalog (latest)" --notes "Species catalog seed." --prerelease --latest=false
   ```

4. **What installs read**: the defaults in `packages/core/src/config.ts` point at the upstream repository. For an install of your own, set these (or change the defaults in your fork):

   | Variable | Set it to |
   |---|---|
   | `CATALOG_MANIFEST_URL` | `https://github.com/<you>/lifer-app/releases/download/catalog-latest/catalog-manifest.json` |
   | `CATALOG_SEED_URL` | the same release, `lifer-catalog-seed.sql.gz` |
   | `PACK_INDEX_URL` | `https://github.com/<you>/lifer-app/releases/download/packs-latest/pack-index.json` |
   | `MAP_DOWNLOAD_URL` | `https://github.com/<you>/lifer-app/releases/download/map-latest/world-z8.pmtiles` |
   | `EMBEDDING_MODEL_URL`, `ID_MODEL_URL`, `ID_MODEL_GPU_URL` | your `models` release, if you publish your own model files |

   The photo store needs no variable: installs read its URL from `pack-index.json`. Two build scripts fetch the catalog seed from a fixed upstream URL, `apps/api/scripts/fetch-catalog-seed.js` (the Docker image) and `apps/desktop/scripts/fetch-catalog-seed.js` (the desktop installer); change them if you build images or installers from your fork. Model checksums (`packages/core/src/species/modelChecksums.ts`) are keyed by URL, so a model from any other URL downloads without a checksum check unless you add its hash there.

## Bootstrap an empty database

A migrated database has no species, regions or sea zones, and the refresh only updates a catalog: it doesn't create one. There are two ways to start one. Both work from the code; the first is the one to use.

### Recommended: start from the published catalog seed

The catalog seed is a data-only `pg_dump` of the catalog tables (species, names, traits, regions with their outlines, every checklist, sea zones, merges, splits, the photo blocklist). It loads straight into a freshly migrated database. On a scratch database this took 85 seconds and gave 134,129 species, 8,089 regions, 232 sea zones and 2.5 million checklist rows:

```bash
curl -L -o lifer-catalog-seed.sql.gz \
  https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz
gunzip -c lifer-catalog-seed.sql.gz | docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml \
  exec -T postgres psql -U lifer -d lifer -v ON_ERROR_STOP=1 -q
```

Use the container's `psql`, as above: the dump comes from `pg_dump` 18, and an older `psql` stops at its first line it doesn't know (`\restrict`). Load it only into an empty, migrated database; the `COPY` statements fail on rows that already exist.

What the seed doesn't carry:

- **Photo files.** The seed blanks every local photo path, so no species has a photo on disk, and the enrich stage skips species already enriched. Clear the main photo of every listed species so the enrich stage fetches it again, with its current credit and license:

  ```sql
  UPDATE species s
  SET enriched_at = NULL, reference_photo = NULL, reference_credit = NULL, reference_license = NULL
  WHERE s.reference_display_path IS NULL
    AND (EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
         OR EXISTS (SELECT 1 FROM sea_zone_species z WHERE z.species_id = s.id));
  ```

  That was 77,236 species on the October 2026 seed. Enrichment then downloads each one's main photo and gallery at about one request a second per host, so this is the longest single wait of the rebuild: plan on two to three days. Gallery rows keep their URLs and get their files back as each species is enriched; any left without a file are simply not in the photo store.
- **Descriptions** do ship in the seed. A seed published before the Wikipedia backfill has many species with no description, or iNaturalist's cut-off copy of the lead; the enrich stage's `backfill-descriptions.ts` fills them from Wikipedia directly (about an hour for 76,000 species, most of it spent fetching long articles one at a time for their Description section; `--lead-only` skips that).
- **Vectors.** They ship as separate `*.bin.gz` files, not in the dump. The vectors stage computes them from the photos (see below).
- **Caches and history**: GBIF downloads, iNaturalist lists, the `pipeline_runs` log. The first run fills them.

### Alternative: build from raw sources

The taxon seed builders make the catalog from GBIF's backbone and the trait datasets in [DATA_SOURCES.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/packages/data-pipeline/DATA_SOURCES.md), with no published file. Each writes a folder under `data/build/<LIFER_BUILD_ID>` at the repo root, and `load-seed` loads the newest folder (or the one `LIFER_BUILD_ID` names). The birds build also writes the region hierarchy (World, continents, countries) from Natural Earth:

```bash
npm run build-seed -w data-pipeline && npm run load-seed -w data-pipeline            # birds and regions
npm run build-seed-mammals -w data-pipeline && npm run load-seed -w data-pipeline
# ...the same for -fish, -amphibians, -squamata, -testudines, -corals, -jellies-anemones,
# -sponges-tunicates, -echinoderms, -crustaceans, -marine-mollusks, -cephalopods, -nudibranchs
npm run replace-sea-zones -w data-pipeline -- --apply                                  # sea zones, linked to regions
```

Provinces are created by the regions stage as it reaches each country. `npm run build-seed-test -w data-pipeline` builds a handful of species, for trying the whole pipeline end to end in minutes. This path wasn't run end to end for this page, and it rebuilds only what the code knows: anything the maintainer fixed by hand in the database over time is missing. Use it when you can't or don't want to start from a published seed.

## The first run

On a new machine the GBIF country files don't exist yet, so run the refresh twice. The first pass downloads them while building province lists; the second has everything on disk and rebuilds properly:

```bash
npm run refresh -w data-pipeline -- --stages=regions   # pass 1: GBIF downloads, province and country lists
npm run refresh -w data-pipeline -- --full             # pass 2: every stage, every country
```

The second pass matters because the `occurrences` and `catalog` stages run before `regions`: on a machine with no country files, the name list the catalog stage reconciles against would be empty. After that, a normal refresh (`npm run refresh -w data-pipeline`) redoes only what changed.

Pass 1 takes as long as GBIF does. Each country is one SQL download, prepared on GBIF's side in minutes to hours depending on the country's size and GBIF's queue; three at a time per account, 239 countries in all. Expect **one to several days**. It's checkpointed after each country, so stopping and rerunning carries on with the next one.

## The refresh, stage by stage

```bash
npm run refresh -w data-pipeline                                  # every stage but publish
npm run refresh -w data-pipeline -- --publish                     # then publish if the gate passes
npm run refresh -w data-pipeline -- --countries="Costa Rica,Peru" # just these countries
npm run refresh -w data-pipeline -- --stages=tiers,packs,gate     # just some stages
npm run refresh -w data-pipeline -- --refresh-occurrences         # re-download GBIF country files first (see below)
npm run refresh -w data-pipeline -- --full                        # redo every country
npm run refresh -w data-pipeline -- --resume                      # continue an interrupted run
npm run refresh -w data-pipeline -- --publish --accept-drift=<pack id>,...
```

To download every country's file again, for newer GBIF records, move the files out of `packages/data-pipeline/data/gbif-country-cache` and run with `--full`: the regions stage downloads whatever is missing.

Durations are from the maintainer's run in October 2026, with every cache already on disk, unless the table says otherwise.

| Stage | What it does | What it writes | Time |
|---|---|---|---|
| `occurrences` | Lists every species name in the GBIF country files, for the catalog stage. With `--refresh-occurrences`, downloads files again first: those in `--countries`, or without it only the 22 priority countries listed in `compute-provinces-bulk.ts`. Only the catalog's classes are tallied, which keeps memory in check. | `packages/data-pipeline/data/build/zip-names.tsv` | Reads all 239 country files (64 GB). Rebuilt only when a file is newer than the list. |
| `catalog` | Links species to the names GBIF (Catalogue of Life), iNaturalist and eBird use now; adds species their lists have that the catalog lacks; merges reviewed duplicates (`packages/data-pipeline/data/reference/species-merges.tsv`); records iNaturalist splits; sets IUCN Red List status from the archive GBIF hosts (codes, Not Evaluated for species IUCN never assessed, and a note for splits IUCN still assesses as part of their parent). | `species`, `species_synonyms`, `species_merges`, `species_splits`, the `iucn_*` columns of `species_traits`; `reconcile-report-<date>.json` and `iucn-status-report.tsv` in `packages/data-pipeline/data/build`; files for you to review in `packages/data-pipeline/data/review` | About 113 minutes, plus about 15 for the first IUCN run (GBIF calls, cached after) and under a minute after that |
| `enrich` | Photos and descriptions for listed species that have none, a retry for those that came up with no photo, descriptions straight from Wikipedia for every species without Wikipedia-sourced text plus a refetch of articles edited since, and a year of Wikipedia pageviews. | `species` photo and description columns, `species_reference_photos`, photo files under `APP_DATA_DIR` | Minutes to hours on an update; two to three days after a seed bootstrap |
| `regions` | iNaturalist places, province checklists from the GBIF files, new species onto older lists, iNaturalist photo counts, escaped pets off the lists, country checklists, introduced and vagrant flags, WoRMS habitats for fish and marine mammals, every sea zone's list. Downloads any missing GBIF country file. | `region_species`, `sea_zone_species`, `regions`; `province-aggregate-cache`; iNaturalist and eBird caches | About 75 minutes from cached files; days with downloads (pass 1) |
| `tiers` | Rarity tiers for every checklist row, then each species' worldwide tier. Needs PostGIS. | tiers and their inputs in `region_species`, worldwide tiers in `species_rarity` | About 65 minutes |
| `vectors` | CLIP vectors for photos and names that have none, the identification model's vectors (Python), and GBIF occurrence stats (record count and last year) for species that have none. Occurrence stats are fetched for about 200 species per request; each species GBIF answered for, including those with no records, is checked again only after 90 days. | the embedding tables, `species_traits` | Over an hour on an update; many hours after a seed bootstrap, when every photo needs one |
| `packs` | The photo store (each photo once), then every pack's checklist, keeping only those that changed. | `photo-store` and `packs-out` in `packages/data-pipeline/data/build` | Not timed for this page; roughly an hour for a full build |
| `gate` | Checks the result (below). | `packages/data-pipeline/data/build/gate-<date>.json` | Minutes |
| `publish` | With `--publish`: new photo shards and the photo index, new pack shards and `pack-index.json`, then the catalog seed and its vector files, manifest last. | the three releases | Upload time: about 12 GB the first time, much less after |

Each stage's start, end and outcome go in the `pipeline_runs` table, and the run's id and arguments in `packages/data-pipeline/data/build/refresh-current-run.json`.

### Resuming

If a run stops (a crash, a reboot, iNaturalist refusing requests), rerun it with `--resume`:

```bash
npm run refresh -w data-pipeline -- --resume
```

It continues the last run with that run's own arguments (its countries, `--publish`), skipping every stage `pipeline_runs` has as done. A stopped stage starts again, but most of its steps carry on where they were: the catalog stage's name check is checkpointed per run, the province pass per country, enrichment and vectors skip what's done. `packs`, `gate` and `publish` always run again, since publish needs the packs built in the same run.

## The gate

The build scripts report success whether or not the data is right, so the `gate` stage checks it and, with `--publish`, refuses to publish on any failure. It prints a summary:

```text
Gate FAILED: 2 failure(s), 1 warning(s), 1 pack(s) with a big species-count change.
  anchor_missing (1):
    <species> is not on <region>'s list
  drift (1):
    <pack id>: 912 species published, 640 now (30%)
  warning no_photo: 41 listed species have no reference photo yet
```

and writes the full report to `packages/data-pipeline/data/build/gate-<date>.json`: `ok`, then `failures` and `warnings` (each a `check` and a `detail`), and `drift` (every pack whose species count moved more than 25%, accepted or not). The checks, by the name the report uses:

- `anchor_missing`, `anchor_tier`: a known species missing from its region, or tiered differently from `packages/data-pipeline/data/reference/checklist-anchors.json` (add species there when you spot a gap);
- `rare_without_records`: a rare or legendary row with no records behind it;
- `catalog_gaps`: species on iNaturalist or eBird lists the catalog still lacks;
- `pack_missing`: a country with species in a group but no pack for it; `index`: a pack depending on a sea zone pack that isn't in the index;
- `other_taxa_in_pack`: a user's own Other Taxa species inside a pack;
- `drift`: a pack's species count moved more than 25% from the published one. Look at those packs, and when the change is right, publish with `--accept-drift=<pack id>,...` (or `--accept-all-drift`).

Warnings (`no_photo`, species with no photo yet) don't stop a publish. On a fork's first publish there's nothing published to drift from, so the drift check passes. The gate only catches what it knows about: after publishing, download a pack and look inside.

## Publishing to your fork

`npm run refresh -w data-pipeline -- --publish` runs everything, then publishes if the gate passes. The pieces go out in an order that never leaves installs pointing at a file that isn't there: photo shards, then the photo index; pack shards, then `pack-index.json`; then the catalog seed and vector files, and `catalog-manifest.json` last. Shards nothing uses any more are deleted afterwards.

- **Permissions.** `gh` needs to create releases, upload and delete assets, and delete releases and tags: the `repo` scope for a classic token (`gh auth login` asks for it), or a fine-grained token with Contents read and write on your fork.
- **Tags.** `catalog-latest` (create it once, above), `packs-latest` and `photos-latest` (created on first publish), `map-latest` and `models` (by hand, below). All are prereleases and must never be marked "Latest": the desktop updater and the web app's update banner read the repository's latest release.
- **Don't name a release `packs-<anything>`.** Publishing deletes every `packs-*` release other than `packs-latest`, a cleanup of the old per-continent releases.

### The photo store

The photo store build starts from the published index at `GITHUB_REPO` and reuses every unchanged photo's place, so a refresh uploads only new or changed photos. On your fork's first publish nothing is published yet, so every photo is written and uploaded (about 9 GB).

`PHOTO_STORE_FROM_SCRATCH=1` writes every photo anew even when an index is published, so after publishing every old shard is unused and deleted. Use it when published shards hold photos that must go, such as ones whose license no longer allows publishing:

```bash
PHOTO_STORE_FROM_SCRATCH=1 npm run refresh -w data-pipeline -- --stages=packs,gate,publish --publish
```

### The model files

The model files are exports of public models (BioCLIP 2 and CLIP ViT-L/14), not built from Lifer's data, so the simplest path is to keep installs on the upstream `models` release, or copy its three files to your own and check them against the sha256 hashes in `packages/core/src/species/modelChecksums.ts`. To build them yourself:

```bash
packages/data-pipeline/.venv/bin/python packages/data-pipeline/python/export_clip_model.py <dir>
packages/data-pipeline/.venv/bin/python packages/data-pipeline/python/export_id_model.py <dir>
gh release create models --title "Models" --notes "Model files installs download." --prerelease --latest=false
gh release upload models <dir>/clip-vit-l14-v2.onnx <dir>/bioclip-2-v1.onnx --clobber
```

`export_id_model.py` currently writes a float16 GPU file (`bioclip-2-v1-fp16.onnx`), while installs download `bioclip-2-v1-fp32.onnx`; until that's reconciled, copy the fp32 file from the upstream release.

### The offline map

`world-z8.pmtiles` is a [Protomaps](https://protomaps.com/) basemap of OpenStreetMap data, cut at zoom 8. Nothing in this repository builds it. Copy it from the upstream `map-latest` release, or cut your own from a Protomaps daily build with the [`pmtiles` CLI](https://docs.protomaps.com/pmtiles/cli) (`pmtiles extract <build>.pmtiles world-z8.pmtiles --maxzoom=8`), then:

```bash
gh release create map-latest --title "Offline map" --notes "Offline basemap." --prerelease --latest=false
gh release upload map-latest world-z8.pmtiles --clobber
```

## Troubleshooting

**iNaturalist refuses requests (HTTP 429).** Enrichment and the photo recheck pace themselves, and stop early when iNaturalist keeps refusing, leaving the rest for the next run: the recheck records each species it checked in `species.photo_checked_at` and checks it again only after 90 days (`--recheck-after-days`). Let the run finish, wait a few hours, and `--resume`. Don't run two iNaturalist-heavy scripts at once.

**Wikipedia or Wikidata refuses requests (HTTP 429, or "maxlag").** `backfill-descriptions.ts` sends one request at a time with `maxlag=5`, waits as told, and stops once most recent batches were refused. Batches it didn't finish aren't stamped, so the next run picks them up. Rerun it, or `--resume` the refresh.

**GBIF refuses requests (HTTP 429) during occurrence stats.** `fetch-occurrence-stats.ts` paces itself (one request a second, `--interval-ms`) and stops once most recent requests were refused. Species it didn't reach keep no stats and no `species_traits.occurrence_checked_at`, so the next run picks them up. Wait a while and `--resume`.

**"could not resize shared memory segment" from Postgres.** Docker gives a container 64 MB of `/dev/shm` by default, too little for Postgres's parallel queries on the big tables. `docker-compose.yml` sets `shm_size: 256mb`, and the dev override inherits it; with `docker run`, add `--shm-size=256m`. The doctor checks this when Postgres runs in Docker.

**"needs PostGIS in the database."** `remove-escapes.ts` (regions stage) and `compute-local-tiers.ts` (tiers stage) measure distances between region outlines with PostGIS and stop with this message without it. Use the dev image (`docker/docker-compose.dev.yml`) and run `CREATE EXTENSION IF NOT EXISTS postgis;`, then `--resume`.

**The occurrences stage runs out of memory.** It used to tally every species name in the country files, insects and plants included. It now counts only the classes the catalog holds (`src/catalogClasses.ts`); if it still runs out, you're on an older checkout.

**A country runs out of memory in the regions stage.** Each country gets a 16 GB heap. On a smaller machine, close other work, or run big countries alone with `--countries=`.

**The disk fills up.** The GBIF files and province aggregates are about 165 GB together, and a full photo store build writes about 9 GB more under `packages/data-pipeline/data/build`. `npm run doctor -w data-pipeline` compares free space with what each cache still needs. `packs-out` there is cleared after a publish, and old `reconcile-checkpoint-*.jsonl` files can go once their run is done.

**`gh release upload` fails with "release not found".** Create `catalog-latest` on your fork first (see [Point your fork at itself](#point-your-fork-at-itself)).

**The catalog seed is over 400 MB.** `build-catalog-seed.ts` refuses a seed that big, since the Windows installer bundles it. Something large was added to the dumped tables.

**`build-catalog-seed.ts` died partway.** It blanks the photo path columns and Other Taxa rows before dumping and restores them after. If it's killed in between, see the danger note under `build-catalog-seed.ts` in [SCRIPTS.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/packages/data-pipeline/SCRIPTS.md).

**A GBIF download never finishes.** Downloads submitted by a stopped run keep running on GBIF's side and hold one of your 3 slots; the pipeline waits for a free one. See your downloads at [gbif.org/user/download](https://www.gbif.org/user/download) and cancel stuck ones there.
