# Maintainer scripts

This repo has accumulated a large number of one-off and recurring scripts across
`apps/api/src/scripts/`, `packages/data-pipeline/src/scripts/`, and `apps/desktop/scripts/`. This
doc is a map of what exists and, more importantly, **the actual sequence to run when adding or
refreshing a region's data pack** — the single most common maintainer task these scripts support.

All scripts are run with `npx tsx <path>` from the relevant package (`apps/api` or
`packages/data-pipeline`), and read `DATABASE_URL` from the environment (via `.env` at the repo
root, or exported directly). Several also need `GBIF_USER`/`GBIF_PWD` (a GBIF.org account, used
for bulk SQL Downloads) — see `.env`.

## Full release checklist

For "I want every fresh install — desktop or Docker — to actually have today's best data," in
order. Skipping the last two steps is the mistake that's bitten this project the most: the region
packs can be perfect and a fresh install still ships wrong species matches, because it bootstraps
from a completely separate, easy-to-forget artifact.

1. **Recompute occurrence data** for whatever regions changed — `compute-provinces-bulk.ts` /
   `compute-all-regions-bulk.ts` / `update-pack.ts` (see below).
2. **Enrich species** — `enrich-all-species.ts` (photos, habitat text), plus any of the data-quality
   cleanup scripts relevant to what changed.
3. **Clean up and backfill vectors**: `repair-missing-reference-photos.ts --dry-run` (should
   report 0 missing), `flag-non-photo-reference-images.ts` (review, then apply), then
   `backfill-reference-embeddings.ts` (species + gallery photo embeddings)
   and `backfill-text-embeddings.ts` (zero-shot text blend) for CLIP, then
   `python/compute_id_model_vectors.py` for the species identification model (BioCLIP 2: text,
   reference and gallery vectors into the `id_model_*` tables; about 3.5 hours for the whole
   catalog on an Apple Silicon GPU, minutes for one region with `--region=`). All are safe to
   re-run; they skip already-embedded rows. The Python one needs a venv once:
   `python3 -m venv .venv && .venv/bin/pip install -r packages/data-pipeline/python/requirements.txt`.
4. **Fetch/refresh occurrence stats** — `fetch-occurrence-stats.ts --only-missing` (powers
   Hide-Obscure/Ghost/Lost).
5. **Build and publish region/sea-zone packs** — `build-and-publish-all-packs.ts` (or
   `update-pack.ts` for a scoped set of countries). Remember: this SKIPS any country the index
   already lists, even if that country's underlying data changed in steps 1-4. Follow it with
   `rebuild-changed-packs.ts` (see "Refreshing an already-published region" above) to refresh
   those.
6. **Rebuild and republish the catalog seed**: run the "Publish catalog seed" GitHub workflow
   (`.github/workflows/catalog-seed.yml`), or locally run `build-catalog-seed.ts` against the same
   database everything above just updated, then `gh release upload catalog-latest <seed>.sql.gz
   <dir>/*.bin.gz --clobber` (every vector asset, CLIP and identification model) followed by
   `gh release upload catalog-latest <dir>/catalog-manifest.json --clobber` (manifest last). **Do this every time steps 1-4 touch data that isn't
   purely per-region** (species traits, rarity tiers, embeddings, endemic labels) — packs alone
   don't carry this to a fresh install; only the catalog seed does, and only if it's actually
   rebuilt.
7. **Spot-check a fresh install's actual data**, not just that the scripts exited 0 — e.g. pull a
   just-published pack and confirm a species you expect to have embeddings actually has one
   (`tar -xzf <pack>.pack.tar.gz manifest.json -O | node -e '...find species, check .embedding...'`).
   Every stale-data bug this session turned up (Canada/Finland's zero-embedding packs, the
   17-day-stale catalog seed, 180 orphaned pack assets missing from the index) looked completely
   fine from the script's own log output — the scripts ran, printed success, and moved on. Only
   pulling the actual published artifact and checking its content caught any of them.

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

`build-and-publish-all-packs.ts` skips anything the published index already lists, so data fixes
(new checklist data, restored photos, recomputed vectors, removed maps) never reach packs that are
already out on their own. **This bit us for real on 2026-09-22**: Canada and Finland sat with zero
embeddings and zero gallery photos for weeks because every rebuild treated them as published.

Use `src/scripts/rebuild-changed-packs.ts`, which rebuilds published packs from the current
database and keeps only the ones whose content actually changed (manifest `contentVersion`
differs from the published one):
```
npx tsx src/scripts/rebuild-changed-packs.ts <outDir> [--species-file=names.txt] [--concurrency=4]
npx tsx src/build/build-pack-index.ts <outDir>   # merges with the currently-published index
npx tsx src/scripts/publish-packs.ts <outDir>
```
`--species-file` limits it to packs listing any of those scientific names; without it every
published pack is rebuilt and compared. Whenever a change touches how packs are BUILT or what
data they carry, run this, since the automated sequence never will.

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
- `flag-non-photo-reference-images.ts` (apps/api): finds reference images that are range maps,
  charts, tables or spectrograms rather than pictures of the animal, by comparing each image's
  CLIP vector with text descriptions (filenames miss too many, e.g. `Aix_galericulata_dis.PNG`).
  Report first (`--out=flagged.json`), review the list, then `--apply=reviewed.json`: each URL goes
  into `reference_photo_blocklist` (shipped in the catalog, so installs delete them too), gallery
  images are deleted, and a map used as a species' MAIN photo is replaced by its first real
  gallery photo (or cleared). Above a margin of 0.06 every hit was a map or chart in the
  September 2026 review; between 0.02 and 0.06 real photos mix in, so review those by eye.
- `repair-missing-reference-photos.ts` (apps/api): re-downloads cached main and gallery reference
  photos whose file is missing even though the database points at it (same download and
  derivative code enrichment uses, to the exact recorded paths). `--dry-run` counts,
  `--countries=` scopes, `--adopt` moves rows recorded outside `APP_DATA_DIR` into it. Needs
  `APP_DATA_DIR` set to the folder the recorded paths live under (e.g. `<repo>/data/lifer`).
  `build-region-pack.ts` now fails on any missing photo file instead of silently shipping a pack
  without it, and names this script (`ALLOW_MISSING_PHOTOS=1` overrides).
- `python/compute_id_model_vectors.py` (data-pipeline): the species identification model's
  (BioCLIP 2) text, reference-photo and gallery-photo vectors, into `id_model_text_embeddings`,
  `id_model_reference_embeddings` and `id_model_gallery_embeddings`. Full-precision PyTorch on the
  GPU; installs match against them with the int8 ONNX export (they agree to ~0.997 cosine).
  `--only=text|reference|gallery`, `--region=<name>`.
- `python/export_id_model.py <dir>` (data-pipeline): builds the int8 ONNX file installs download
  (`<dir>/bioclip-2-v1.onnx`, ~308MB). Only needed when the model or its version changes; publish
  with `gh release upload models <dir>/bioclip-2-v1.onnx --clobber` (create the `models` release
  once with `gh release create models --title "Models" --notes "Model files installs download." --prerelease`).
  The app's `ID_MODEL_URL` (apps/api/src/config.ts) points at that release.
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
  **Also decides which GitHub Release each pack uploads to** (`build/release-groups.ts`): one
  release per continent (`packs-europe`, `packs-asia`, ...) plus `packs-seazones`, rolling over to
  `packs-<group>-2`/`-3`/... automatically once a release nears GitHub's hard 1000-asset cap —
  `packs-latest` hit that ceiling for real on 2026-09-22 with everything dumped on one release, which
  is why this split exists. `pack-index.json` itself always stays on `packs-latest` (the one URL
  `PACK_INDEX_URL` is hardcoded to); only the individual pack files moved. **Merges with the
  currently-published index**, not just the local batch just built — a plain overwrite here is what
  let 180 already-published pack assets (across 107 countries, including most of Canada's own taxa)
  quietly vanish from the catalog while their files stayed live on GitHub, undetected until a user
  reported wrong species-match results. If a build ever needs to run against a fresh/scratch
  `packsDir` with nothing else in it, this merge is exactly what makes that safe.
- `scripts/publish-packs.ts` — uploads packs + `pack-index.json` to their respective releases (reads
  each pack's target release straight out of the index `build-pack-index.ts` just built — never
  re-derives continent/overflow assignment itself, so the two scripts can't disagree about where a
  pack lives).
- `scripts/build-catalog-seed.ts` (writes the seed, one compact float16 `*.bin.gz` per vector
  table: `lifer-gallery-embeddings`, `lifer-species-image-embeddings` and
  `lifer-species-text-embeddings` for CLIP, plus `lifer-id-gallery-embeddings`,
  `lifer-id-species-image-embeddings` and `lifer-id-species-text-embeddings` for the
  identification model, and `catalog-manifest.json` with each file's sha256; the gallery vectors are no longer inside the seed, which keeps it well under
  the 200MB limit the script enforces) builds the **shared bootstrap DB snapshot** every fresh install
  (desktop AND self-hosted Docker alike) restores on first launch, published as `catalog-latest`.
  Needs `DATABASE_URL` pointed at a real, fully-enriched database and `PG_DUMP_BIN` (no system-wide
  `pg_dump` on a machine that only has the embedded Postgres theseus manages — point this at
  `~/.theseus/postgresql/<version>/bin/pg_dump`, matching version). Streams `pg_dump`'s output
  straight through gzip to disk rather than buffering it — this dump can now run past 1GB once
  `species_reference_gallery_embeddings` is included, well past `execFileSync`'s old buffer ceiling.
  **This is the single easiest piece of the whole pipeline to forget.** It is not part of
  `update-pack.ts`'s sequence or `build-and-publish-all-packs.ts` at all — nothing else in this repo
  ever re-triggers it. Any session of enrichment, embedding backfills, or trait recomputation that
  isn't followed by a fresh `build-catalog-seed.ts` + `gh release upload catalog-latest ...` leaves
  every brand-new install (on any platform) bootstrapping from whatever was published last —
  `catalog-latest` sat 17+ days stale here, published *before the zero-shot text-embedding feature
  existed at all*, so `species_text_embeddings` was completely empty for every fresh install despite
  the feature having shipped and been tested for over two weeks. **Danger**: this script NULLs out
  every local file-path column before dumping and restores the real values afterward in a `finally`
  block — if the process dies mid-run in a way that skips that `finally` (an unhandled rejection, an
  event-listener race causing a silent early exit — both hit for real building this doc), the source
  database is left with those path columns permanently NULL. If that happens: the files are still on
  disk (named by id, e.g. `reference-display/<species.id>.webp`,
  `reference-display/<species_reference_photos.species_id>-gallery-<sort_order>.webp`) — walk every
  `species`/`species_reference_photos` row, check for a matching file, and restore the path column
  if one exists; verify with `SELECT count(*) FILTER (WHERE reference_display_path IS NOT NULL) ...`
  before and after. Always let this script finish cleanly (check its exit code) before trusting the
  source DB's path columns again.
- `scripts/backfill-text-embeddings.ts` (also in `apps/api/src/scripts/`) — computes
  `species_text_embeddings` (the zero-shot text blend `embeddings.ts`'s `blendWithText` uses to
  strengthen a match when a species has no photo embedding yet). Not part of `update-pack.ts` or
  `build-and-publish-all-packs.ts` either — same "nothing automatically re-triggers this" risk as
  the catalog seed above, and its output only ever reaches a fresh install through that same seed.

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
