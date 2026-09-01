# Maintainer scripts

This repo has accumulated a large number of one-off and recurring scripts across
`apps/api/src/scripts/`, `packages/data-pipeline/src/scripts/`, and `apps/desktop/scripts/`. This
doc is a map of what exists and, more importantly, **the actual sequence to run when adding or
refreshing a region's data pack** — the single most common maintainer task these scripts support.

All scripts are run with `npx tsx <path>` from the relevant package (`apps/api` or
`packages/data-pipeline`), and read `DATABASE_URL` from the environment (via `.env` at the repo
root, or exported directly). Several also need `GBIF_USER`/`GBIF_PWD` (a GBIF.org account, used
for bulk SQL Downloads) — see `.env`.

## The pack-update sequence

**`update-pack.ts` chains all of this into one command:**
```
npx tsx packages/data-pipeline/src/scripts/update-pack.ts --countries=Belgium,Netherlands --apply
```
It runs compute → enrich (new species) → photo recheck → cleanup → build/publish in order,
shelling out to the same individual scripts described below (no new region/enrichment logic of
its own — see its own header comment). Defaults to a dry run on the compute step (same as
`compute-provinces-bulk.ts` alone) — pass `--apply` to actually write; also gates
`purge-wrong-continent-outliers.ts`'s own delete-confirmation requirement in the cleanup stage.
`--taxa=` overrides auto-detection of which taxa need the "brand new species" enrich sub-stage;
`--skip-compute` / `--skip-enrich` / `--skip-photo-recheck` / `--skip-cleanup` / `--skip-build`
resume a partial run after a mid-sequence failure; `--budget-gb=` / `--packs-dir=` forward to the
build stage.

### What it does, stage by stage

1. **Compute the checklist.** `compute-provinces-bulk.ts --countries=... --apply` (needs
   `GBIF_USER`/`GBIF_PWD`) drills provinces and computes checklists for the given countries. For
   a country with no province split needed, use `compute-all-regions-bulk.ts --dir=<gbif-bulk-dir>`
   directly instead (not currently wired into `update-pack.ts`).
2. **Enrich brand-new species only.** `update-pack.ts` auto-detects which taxon classes have at
   least one species that's NEVER been enriched (`enriched_at IS NULL`) among the given countries
   — a refresh of an already-published region normally finds nothing here, since every one of its
   species has already been through this at least once. Deliberately does NOT re-run full
   enrichment (new gallery photos, description/habitat text, etc) on species that already have it.
3. **Recheck photoless species.** `recheck-null-photo-species.ts --countries=...` retries just
   the species that WERE already enriched but came up with no `reference_photo` — cheap, worth
   doing on every refresh, since a photo can genuinely become available later even though nothing
   else about that species needs re-enriching.
4. **Data-quality cleanup.** `check-extinction-status.ts` → `purge-implausible-extinct-regions.ts`
   → `purge-wrong-continent-outliers.ts` → `fix-fish-region-vagrancy.ts` →
   `detect-implausible-regions.ts` (report only, never auto-deletes — see its own header comment).
   Catches the kind of thing that lets a weird vagrant slip onto a checklist (a near-single-record
   outlier, a hardcoded-false vagrancy flag, an extinct-in-the-wild reintroduction misread as a
   real wild population).
5. **Build and publish.** `build-and-publish-all-packs.ts` is itself resumable and skips countries
   already published, so re-running the whole controller after an earlier partial run is safe.

### Refreshing an already-published region

Same command, but re-running `compute-provinces-bulk.ts` for an already-computed country doesn't
by itself force `build-and-publish-all-packs.ts` to rebuild it — that script's own "already
published" check only looks at the pack index, not whether the underlying checklist changed since.
**Known gap:** refreshing one specific already-published region currently requires manually
removing its entry from the published index first, or a `--force`/`--only=` flag on the build
stage that doesn't exist yet.

## Script inventory by category

### Region / province / checklist computation (`apps/api/src/scripts/`)
- **`refresh-all-provinces.ts`** — runs `compute-provinces-bulk.ts`'s automated per-country GBIF
  download cycle for every country in the catalog, one country at a time (real coordinates, real
  province splits — unlike the world-scale bulk path, which has no lat/lon). Checkpointed to a
  JSON file after each country succeeds, so killing it mid-run and re-running the exact same
  command skips everything already done and resumes with the next country — no lost progress, no
  re-submitted GBIF downloads. `--countries=` (default: every country), `--apply`,
  `--reset-checkpoint`, `--checkpoint=`. A full sweep is genuinely long (each country's download
  alone typically takes several minutes); this is meant to run unattended over hours.
- `compute-all-regions.ts` — per-country live GBIF calls (superseded by the bulk version below for
  anything at scale; still useful for a single region). Exports `drillDownAllCountries` for reuse
  by the scripts below — its own `main()` is guarded to only run when this file is the actual
  process entry point, not merely imported for that export (a real bug this used to trip: every
  import silently re-ran a full unscoped drill+compute pass as a side effect, then crashed on a
  double `pool.end()` — fixed 2026-09-01).
- `compute-all-regions-bulk.ts` — world-scale, one pre-aggregated GBIF SQL Download instead of
  many live calls. `--dir=`
- `compute-provinces-bulk.ts` — province/state-level checklists via per-country GBIF SQL Download
  with coordinates + point-in-polygon matching. Needs `GBIF_USER`/`GBIF_PWD`. `--countries=`,
  `--apply`
- `compute-us-states-from-bulk.ts` — US state checklists specifically (live calls 429'd for
  several states). `--states=`, `--csv=`, `--zip=`, `--apply`
- `recompute-all-regions.ts` — unconditional full recompute, ahead of a pack-build pass.
- `recompute-stale-regions.ts` — recomputes only regions computed before a specific
  rare-resident-detection fix.
- `backfill-missing-provinces.ts` — fixes countries whose first province drill-down was
  incomplete.
- `probe-province-value.ts` — cheap read-only check: do a country's provinces actually carry
  distinct data, before paying for a full recompute.
- `gbif-bulk-ab-test.ts` — validates the bulk-download approach against live-call results.
  `--dir=`, `--country=`, `--iso2=`

### Species enrichment — photos, traits, occurrence data (`apps/api/src/scripts/` +
`packages/data-pipeline/src/scripts/`)
- **`enrich-all-species.ts`** — the main bulk enrichment pass (iNaturalist + Wikipedia). `--taxa=`
  (default: every unenriched species). Skips already-enriched species, safe to re-run.
- `fetch-occurrence-stats.ts` (data-pipeline) — backfills `species_traits.occurrence_count` /
  `last_occurrence_year` (global GBIF aggregates — powers Hide-Obscure/Ghost/Lost). `--only-missing`
- `backfill-reference-embeddings.ts` (data-pipeline) — computes embeddings for species reference
  photos (species auto-suggest feature).
- `verify-and-label-endemics.ts` — verifies and labels endemic-species flags.
- `check-extinction-status.ts` / `backfill-extinction-from-iucn-checklist.ts` — verify/bulk-check
  "possibly extinct" candidates against GBIF/IUCN data.
- `detect-unobserved-legendary.ts` / `detect-implausible-regions.ts` — read-only QA passes flagging
  likely-bad data for review, paired with `purge-implausible-extinct-regions.ts` /
  `purge-wrong-continent-outliers.ts` (needs `LIFER_CONFIRM_DELETE`) to apply the findings.
- A long tail of one-time, already-applied photo/name-quality fixes (portrait-crop repairs,
  common-name casing, Wikimedia→iNaturalist upgrades, etc) — historical, no ongoing role. See each
  script's own header comment before assuming it still needs to run.

### Pack building / publishing (`packages/data-pipeline/src/`)
- **`scripts/update-pack.ts`** — the end-to-end controller: compute → enrich → build/publish for
  a list of countries in one command. See "The pack-update sequence" above.
- `build/build-region-pack.ts` — builds one region's downloadable pack archive (taxon-split).
- **`scripts/build-and-publish-all-packs.ts`** — the existing controller: walks the priority
  country list, builds, publishes, and cleans up unattended. Resumable. `--budget-gb=`,
  `--packs-dir=`
- `build/build-pack-index.ts` — builds `pack-index.json` from already-built packs' manifests.
- `scripts/publish-packs.ts` — uploads packs + index to the GitHub Release.
- `scripts/build-catalog-seed.ts` — builds the fresh-install DB snapshot shipped as `catalog-latest`
  (every new install downloads this once). Needs `DATABASE_URL`, `PG_DUMP_BIN`.

### Verification / cleanup / recurring ops
- `backup.ts` (data-pipeline) — the one genuinely cron-worthy recurring script outside the pack
  workflow. Needs `DATA_DIR`, `LIFER_BACKUP_DIR`, `LIFER_POSTGRES_CONTAINER`, `POSTGRES_DB`,
  `POSTGRES_USER`.
- `clear-gbif-cache.ts` — clears cached GBIF bulk-download responses. `--like=`

### Desktop build tooling (`apps/desktop/scripts/`)
Already has a controller — `npm run dist -w desktop` chains `prepare-resources.js` →
`fetch-node-sidecar.js` → `fetch-catalog-seed.js` → `tauri-build.js` → `resign-macos.js`.
`headless-postgres.js` (`start`/`stop`/`status`/`url`) runs the same embedded-Postgres
binary/data-directory as the app itself, but as an independent process — start it once, then any
rebuild/relaunch cycle (or a long-running background script) can point `DATABASE_URL` at it
instead of the app's own embedded instance, without either killing the other. See its own header
comment for the full reasoning.

### Everything else
`packages/data-pipeline/src/fetch/*.ts` and `src/build/build-seed-*.ts` (one per taxon group) are
library modules with their own npm-aliased entrypoints, not part of the ongoing pack-update
cycle — only re-run when onboarding a wholly new taxon group from scratch. A long tail of
already-applied one-time backfills/dedup scripts (species-name dedup chains, region-attribute
backfills, etc) live alongside the active scripts above; each carries its own header comment
explaining whether it's still relevant.
