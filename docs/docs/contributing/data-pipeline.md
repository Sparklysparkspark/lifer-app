---
title: Data pipeline
description: How the species catalog, region packs and reference photos are built and published.
---

# Data pipeline

Lifer's species data (the catalog, every region's checklist, rarity tiers, reference photos and their vectors) isn't built on users' machines. A maintainer builds it with `packages/data-pipeline` and the scripts in `packages/data-pipeline/src/scripts`, and publishes the result as GitHub releases that installs download. See [Architecture](./architecture.md#data-lifer-downloads) for what installs fetch.

Two reference files live next to the code:

- [SCRIPTS.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/packages/data-pipeline/SCRIPTS.md): every maintainer script, its flags and what it needs.
- [DATA_SOURCES.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/packages/data-pipeline/DATA_SOURCES.md): every outside dataset and model, with its license and credit.

## What you need

A Postgres database with PostGIS, a GBIF account, an eBird API key, a Python environment for the identification model, `gh` to publish, and about 200 GB of disk. A first run takes days, mostly waiting on GBIF downloads. [Rebuilding the data](./rebuilding-data.md) lists every prerequisite with real sizes and times, how to start from an empty database, and how to publish to a fork. Check a machine with:

```bash
npm run doctor -w data-pipeline
```

## Refresh everything

One command turns source data into everything installs download. Run it about once a quarter, or when taxonomy changes (splits, lumps, renames) should reach installs:

```bash
npm run refresh -w data-pipeline                # rebuild what changed, don't publish
npm run refresh -w data-pipeline -- --publish   # the same, then publish if the gate passes
```

Other useful flags: `--countries="Costa Rica,Peru"` for some countries only, `--stages=tiers,packs,gate` for some stages, `--refresh-occurrences` to download GBIF country files again (only the priority countries in `compute-provinces-bulk.ts`, unless you give `--countries`), `--full` to redo every country, and `--resume` to continue a run that stopped.

The stages run in this order:

| Stage | What it does |
|---|---|
| `occurrences` | The list of every species name in the GBIF country files, for the catalog stage; with `--refresh-occurrences`, downloads files again first. The regions stage downloads any that are missing. |
| `catalog` | Links species to the names GBIF (Catalogue of Life), iNaturalist and eBird use now, adds species their lists have that the catalog lacks, merges duplicates, records splits, and sets each species' IUCN Red List status (`backfill-iucn-status.ts`). |
| `enrich` | Photos and descriptions for species that have none yet. |
| `regions` | iNaturalist places, province checklists, then country checklists, with escaped pets removed and introduced species flagged, then every sea zone's fish and marine mammals from the same GBIF downloads. |
| `tiers` | Rarity tiers for every checklist row, then each species' worldwide tier. |
| `vectors` | CLIP and BioCLIP 2 vectors for species photos and names that have none, and occurrence stats. |
| `packs` | The reference photo store, then every region's pack, keeping only those whose content changed. |
| `gate` | Checks the result before anything is published (below). |
| `publish` | With `--publish`: the photo store, then the packs and their index, then the catalog seed. |

Each stage's start and end is recorded in the `pipeline_runs` table, which is how `--resume` knows where to continue. [Rebuilding the data](./rebuilding-data.md#the-refresh-stage-by-stage) has what each stage writes and how long it takes.

## The publish gate

The build scripts report success whether or not the data is right, so `src/pipeline/gate.ts` checks the result and refuses to publish on any failure. It catches, among others:

- a known species missing from its region, or tiered differently from what's expected (the anchors in `data/reference/checklist-anchors.json`; add a species there when you spot a gap);
- a rare or legendary listing with no records behind it;
- species on iNaturalist or eBird lists that the catalog still lacks;
- a country with species in a group but no pack for it, or a pack depending on a sea zone pack that isn't in the index;
- a user's own Other Taxa species inside a pack;
- a pack whose species count moved more than 25% from the published one. Review the list in `data/build/gate-<date>.json`, then publish with `--accept-drift=<pack id>,...`.

The gate only catches what it knows about. After publishing, download one pack and look inside it. [Rebuilding the data](./rebuilding-data.md#the-gate) explains how to read its report.

## Add a new species group

Packs are split by group (birds, mammals, fish, and so on). To add one:

1. Add the group to `TaxonClass` in `packages/shared/src/species.ts`.
2. Write `packages/data-pipeline/src/build/build-seed-<group>.ts`. Most groups wrap `build-seed-generic.ts`, which builds from GBIF, common names and Wikidata. Add an npm script for it in `packages/data-pipeline/package.json`, like the existing `build-seed-*` ones.
3. Run it and load the result:

   ```bash
   npm run build-seed-<group> -w data-pipeline
   npm run load-seed -w data-pipeline
   ```

4. Add the group to `PACK_TAXA` in `src/pipeline/packs.ts`, and to `ALL_TAXA` in `src/scripts/refresh.ts` so the enrich stage covers it.
5. Run a refresh. Every country with species in the new group gets a pack for it.

If the group uses a new outside source, add it to `DATA_SOURCES.md` and to [Data sources and credits](../credits.md).

## Publishing data releases

`refresh --publish` uploads to the `catalog-latest`, `packs-latest` and `photos-latest` releases. Model files go to `models` and the offline map to `map-latest`, by hand (see [Rebuilding the data](./rebuilding-data.md#publishing-to-your-fork), which also covers publishing to a fork). All data releases are prereleases and must never be marked "Latest". See [Releasing](./releasing.md#data-releases).
