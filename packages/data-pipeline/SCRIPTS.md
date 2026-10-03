# Maintainer scripts

A map of the maintainer scripts in `apps/api/src/scripts/`, `packages/data-pipeline/src/scripts/`
and `apps/desktop/scripts/`, and the one command that refreshes everything installs download.

All scripts are run with `npx tsx <path>` from their package (`apps/api` or
`packages/data-pipeline`) and read `DATABASE_URL` from the environment (`.env` at the repo root, or
exported). Several also need `GBIF_USER`/`GBIF_PWD` (a GBIF.org account, for bulk SQL Downloads).

## Refreshing the data: one command

Everything that turns source data into what installs download (the species catalog, every
province and country checklist, rarity tiers, vectors, offline packs, the catalog seed) runs from
one command, meant for about once a quarter or whenever taxonomy changes (splits, lumps, renames)
should reach installs:

```
npm run refresh -w data-pipeline                                  # everything that changed, no publish
npm run refresh -w data-pipeline -- --publish                     # same, then publish if the gate passes
npm run refresh -w data-pipeline -- --countries="Costa Rica,Peru" # just these countries
npm run refresh -w data-pipeline -- --stages=tiers,packs,gate     # just some stages
npm run refresh -w data-pipeline -- --refresh-occurrences         # re-download GBIF data first
npm run refresh -w data-pipeline -- --full                        # redo every country
npm run refresh -w data-pipeline -- --resume                      # continue an interrupted run
npm run refresh -w data-pipeline -- --publish --accept-drift=<pack id>,...
```

Stages, in order (`src/scripts/refresh.ts` has the details): **occurrences** (GBIF country
downloads, and the list of every species name in them), then **catalog** (current names from
Catalogue of Life, iNaturalist and eBird; species the catalog lacks; duplicate merges; species
iNaturalist has split), **enrich** (photos and descriptions for new species, Wikipedia
pageviews), **regions** (iNaturalist places, province checklists, new catalog species onto lists
built before them, iNaturalist photo counts, escaped pets off the lists, country checklists,
introduced flags), **tiers** (absolute local tiers, then worldwide tiers), **vectors** (CLIP and
identification model embeddings, occurrence stats), **packs** (the photo store, then every pack's
checklist, only changed ones kept), **gate** and **publish** (photo store shards and index, then
packs and their index, then the catalog seed).

Packs hold checklists only. Photos live once in the photo store (`src/pipeline/photoStore.ts`,
release `photos-latest`): shard files of photo bytes plus an index of where each photo sits.
Installs fetch the photos they're missing by byte range, so a species in 200 packs is uploaded
and stored once. A rebuild reuses every unchanged photo's place and writes new shards only for
new or changed photos, so a refresh uploads only those. Vectors ship in the catalog seed.

Each stage's start and end is logged in `pipeline_runs`, so `--resume` continues a run that
stopped. iNaturalist lists are reused while younger than `LIFER_INAT_CACHE_MAX_AGE_DAYS` (90 by
default); `LIFER_INAT_OFFLINE=1` never calls iNaturalist for anything the caches can answer. Needs
`DATABASE_URL`, `GBIF_USER`/`GBIF_PWD` for downloads, `EBIRD_API_KEY`, `gh` signed in to publish,
`PG_DUMP_BIN` matching the database's Postgres version for the catalog seed, and once, the Python
environment for the identification model:
`python3 -m venv packages/data-pipeline/.venv && packages/data-pipeline/.venv/bin/pip install -r packages/data-pipeline/python/requirements.txt`.

### The gate

`src/pipeline/gate.ts` checks the data before anything is published and refuses on any failure,
because the build scripts report success whether or not the data is right:
- a known species missing from its region, or tiered differently from what's expected
  (`data/reference/checklist-anchors.json`; add species here when you spot a gap);
- a rare or legendary row with no records behind it;
- species on iNaturalist or eBird lists that the catalog still lacks;
- a country with species in a taxon but no pack for it;
- a pack depending on a sea zone pack that isn't in the index;
- a user's own Other Taxa species inside a pack;
- a pack whose species count moved more than 25% from the published one (review the list in
  `data/build/gate-<date>.json`, then publish with `--accept-drift=<pack id>,...`).

### Still check a real pack

The gate catches what it knows about. After publishing, pull one pack and look inside:
`tar -xzf <pack>.pack.tar.gz manifest.json -O | node -e '...'`. A script's own log can look fine
while what it published is wrong.

## Script inventory by category

### Catalog names and species (`packages/data-pipeline/src/scripts/` unless noted)
- `reconcile-species-names.ts`: links catalog species to the names GBIF (Catalogue of Life),
  iNaturalist and eBird use now, as synonyms, iNaturalist ids and eBird codes. `--zip-names`,
  `--stage=col,inat,history,ebird`, `--checkpoint=` (resumable), `--report=`, `--apply`, or
  `--apply-report=<reviewed.json>`.
- `add-missing-species.ts`: adds species on cached iNaturalist place lists or in eBird's taxonomy
  that the catalog lacks, and links respellings and genus moves to their existing entry instead.
  `--apply`, `--offline`.
- `find-species-splits.ts`: records which catalog species iNaturalist has split, and into what
  (`species_splits`); possible duplicates and missing replacements go to
  `data/review/inat-taxon-changes.tsv`. `--apply`.
- `merge-duplicate-species.ts` (apps/api): folds the reviewed pairs in
  `data/reference/species-merges.tsv` into one species each, the same way installs apply them.
  `--apply`, `--list=`.
- `fetch-wiki-pageviews.ts`: a year of English Wikipedia pageviews per tiered species, the
  interest correction for photo-rated tiers. Skips species fetched in the last 90 days.
- `catalog-quality-report.ts <out.json>`: tier spread and must-have species for a few regions, to
  compare before and after a rebuild.
- `backfill-aba-codes.ts`, `backfill-common-names.ts`: eBird codes and ABA codes from
  `data/reference/ebird-taxonomy.csv`; common names and aliases from GBIF vernacular names.
- `backfill-iucn-status.ts` (apps/api): IUCN status from GBIF's IUCN Red List checklist.
- `build-species-name-index.ts`, `build-species-synonym-map.ts` (apps/api): resolve names in a GBIF
  bulk download to catalog species, and the gbif_key synonym map `load-seed.ts` uses.

### Region checklists (`apps/api/src/scripts/`)
- **`refresh-all-provinces.ts`**: runs `compute-provinces-bulk.ts`'s per-country GBIF download
  cycle for every country, one at a time. Checkpointed after each country, so rerunning the same
  command resumes with the next one without re-submitting downloads. `--countries=`, `--apply`,
  `--reset-checkpoint`, `--checkpoint=`. A full sweep runs for hours.
- `compute-provinces-bulk.ts`: province checklists from one GBIF SQL Download per country, with
  coordinates matched to province outlines. `--countries=`, `--apply`, `--cache-only`,
  `--refresh-gbif-cache`, `--refresh-aggregate-cache`.
- `compute-provinces-inat.ts`: lists for provinces with none, from iNaturalist Research Grade
  records only.
- `compute-all-regions.ts`: per-country live GBIF calls, for a single region. Exports
  `drillDownAllCountries`.
- `resolve-inat-places.ts`: iNaturalist place ids for regions that have none. Rerunnable.
- `add-new-species-to-checklists.ts`: puts species the catalog gained after a province was built
  onto that province's list, from the cached iNaturalist and eBird lists only. Rerunnable.
  `--apply`
- `refresh-inat-counts.ts`: every place's iNaturalist research-grade list with photo counts, for
  places cached without them. About 1 request a second; run it on its own.
- `remove-escapes.ts`: takes escaped pets and one-off releases off province and country lists.
  Land mammals except bats, reptiles and amphibians only; a thin listing goes only when no chain
  of nearby listings links it to an established population. `--apply`
- `build-country-checklists.ts`: each country's list from its provinces, its own well-evidenced
  species, and its iNaturalist list. `--countries=`, `--apply`
- `apply-introduced-flags.ts`: which listings are introduced species, from iNaturalist's
  establishment status for each province and country (cached, about 1 request a second).
  Established ones get the Introduced flag, strays the Vagrant flag, and natives only flagged by
  the old distance guess lose it. Rewrites `species_nonnative_countries`. `--apply`
- `gbif-bulk-ab-test.ts`: compares the bulk-download approach with live-call results.
  `--dir=`, `--country=`, `--iso2=`

### Rarity tiers (`apps/api/src/scripts/`)
- `compute-local-tiers.ts`: absolute tiers for every checklist row from the province data on disk
  and the cached iNaturalist counts (`packages/data-pipeline/src/build/local-tier-model.ts`), plus
  the removal checks that need those inputs (unconfirmed, extinct, never-photographed species, and
  birds eBird never had). Offline, minutes for every country. `--countries=`, `--inputs`,
  `--calibrate[=anchors.json]`, `--strict`, `--apply`.
- `compute-global-tiers.ts`: each species' worldwide tier, its easiest native country's tier.
  `--apply`.

### Enrichment and vectors
- **`enrich-all-species.ts`** (apps/api): photos and descriptions from iNaturalist and Wikipedia.
  `--taxa=`, `--listed-only`. Skips enriched species, safe to rerun.
- `enrich-listed-batch.ts` (apps/api): the same for listed species without a photo, 30 to an
  iNaturalist request.
- `recheck-null-photo-species.ts` (apps/api): retries enriched species that came up with no photo.
  `--countries=`
- `repair-missing-reference-photos.ts` (apps/api): re-downloads cached main and gallery photos
  whose file is missing. `--dry-run`, `--countries=`, `--adopt`. Needs `APP_DATA_DIR` set to the
  folder the recorded paths live under. `build-region-pack.ts` fails on a missing photo file and
  names this script (`ALLOW_MISSING_PHOTOS=1` overrides).
- `flag-non-photo-reference-images.ts` (apps/api): finds reference images that are range maps,
  charts or spectrograms by comparing their CLIP vectors with text descriptions. Report first
  (`--out=flagged.json`), review, then `--apply=reviewed.json`: each URL goes into
  `reference_photo_blocklist` (shipped in the catalog), gallery images are deleted, and a map used
  as a main photo is replaced by the first real gallery photo. Hits above a margin of 0.06 are
  reliably maps or charts; between 0.02 and 0.06, review by eye.
- `fetch-occurrence-stats.ts`: `species_traits.occurrence_count` / `last_occurrence_year` (powers
  Hide-Obscure/Ghost/Lost). `--only-missing`
- `backfill-reference-embeddings.ts`: CLIP vectors for reference and gallery photos.
- `backfill-text-embeddings.ts` (apps/api): `species_text_embeddings`, the zero-shot text blend
  used when a species has no photo vector yet.
- `python/compute_id_model_vectors.py`: the identification model's (BioCLIP 2) text,
  reference-photo and gallery-photo vectors, into the `id_model_*` tables. Full precision on the
  GPU; installs match against them with the int8 ONNX export. `--only=text|reference|gallery`,
  `--region=<name>`.
- `python/export_id_model.py <dir>`: the identification model files installs download, int8 for
  the CPU (`bioclip-2-v1.onnx`) and float16 for a GPU (`bioclip-2-v1-fp16.onnx`). Only when the
  model or its version changes; publish with `gh release upload models <file> --clobber`
  (create the release once with
  `gh release create models --title "Models" --notes "Model files installs download." --prerelease`).
  `ID_MODEL_URL` in apps/api/src/config.ts points at it.
- `python/export_clip_model.py <dir> [fp32.onnx]`: the CLIP model's per-channel int8 CPU file
  (`<dir>/clip-vit-l14-v2.onnx`) from Xenova's full-precision export, which it downloads to
  `<dir>/clip-vit-l14-v2-fp32.onnx` (1.2GB, checked by sha256) unless given. GPUs run the fp32
  file. Publish the int8 file with `gh release upload models <dir>/clip-vit-l14-v2.onnx --clobber`.
- `regenerate-clip-vectors.ts`: CLIP vectors at `clip-vit-l14-v2` for every reference and gallery
  photo, at full precision, through the app's own inference code. Resumable and incremental.
  Stages into `clip_vector_regen`; `--apply` swaps them into `species_reference_embeddings` /
  `species_reference_gallery_embeddings` in one transaction, refusing while any photo is missing
  one. `--limit=N`, `--dry-run`, `--model=<fp32.onnx>` (or `CLIP_V2_FP32_MODEL`; default
  `data/build/models/clip-vit-l14-v2-fp32.onnx`). Switch `EMBEDDING_MODEL_VERSION` (apps/api
  config.ts and data-pipeline embeddings.ts) and the catalog seed's default in the same change as
  the `--apply`, or the vectors stage recomputes every vector with the old model.

### Data checks (`apps/api/src/scripts/`)
- `check-fossil-status.ts`: flags fossil-only species as fully extinct.
- `detect-unobserved-legendary.ts`, `detect-implausible-regions.ts`: read-only passes flagging
  likely-bad data for review.
- `flag-nonnative-obscure-taxa.ts`: checks reptiles, amphibians and marine invertebrates on lists
  against iNaturalist's establishment status per place. `--apply`
- `flag-vagrant-mismatch-inat.ts`, `report-vagrant-ebird.ts`: read-only reports of listings
  iNaturalist or eBird don't back up.
- `verify-vagrant-flags.ts`, `verify-vagrant-fishbase.ts`: check vagrant flags against GBIF
  distributions and FishBase's country table.

### Packs and the catalog seed (`packages/data-pipeline/src/`)
- **`scripts/refresh.ts`**: the one command (see above). Its pack stage is `pipeline/packs.ts`
  and its gate `pipeline/gate.ts`.
- `build/build-region-pack.ts`: builds one region's or sea zone's pack archive (taxon-split); used
  by the pack stage, and runnable alone for one pack.
- `build/build-pack-index.ts`: builds `pack-index.json` from built packs' manifests and merges in
  every published pack this batch didn't rebuild, so a build in a scratch folder never drops
  published packs.
- `pipeline/packStore.ts`: the pack store. Packs are published as a few shard files
  (`lifer-packs-<build>-<n>.bin`) next to `pack-index.json` on `packs-latest`, not one release
  asset per pack; each index entry has its shard's `url`, a `range` and a `sha256`, and installs
  fetch just that range. Rebuilt packs go into new shards, unchanged ones keep their place, and a
  shard nothing uses is deleted on publish.
- `scripts/build-catalog-seed.ts <out.sql.gz>`: the bootstrap snapshot every fresh install
  (desktop and Docker) restores on first launch, published as `catalog-latest`, plus one float16
  `*.bin.gz` per vector table (CLIP and identification model) and `catalog-manifest.json` with
  each file's sha256. `refresh --publish` builds and uploads it after the packs. Needs
  `DATABASE_URL` pointed at a fully enriched database and `PG_DUMP_BIN` (with only the embedded
  Postgres, `~/.theseus/postgresql/<version>/bin/pg_dump`, matching version). Run alone, follow
  it with `gh release upload catalog-latest <seed>.sql.gz <dir>/*.bin.gz --clobber`, then the
  manifest last. **Danger**: it NULLs every local file-path column before dumping and restores
  them in a `finally` block, so if the process dies without reaching it, the source database
  keeps those columns NULL. The files are still on disk, named by id
  (`reference-display/<species.id>.webp`,
  `reference-display/<species_reference_photos.species_id>-gallery-<sort_order>.webp`): restore
  each path column whose file exists, and check
  `SELECT count(*) FILTER (WHERE reference_display_path IS NOT NULL) ...` before and after. Let it
  finish cleanly (check its exit code) before trusting the path columns, and don't run it while
  anything else reads them.

### Recurring ops
- `backup.ts` (data-pipeline): the one cron-worthy script outside the refresh. Needs `DATA_DIR`,
  `LIFER_BACKUP_DIR`, `LIFER_POSTGRES_CONTAINER`, `POSTGRES_DB`, `POSTGRES_USER`.
- `clear-gbif-cache.ts` (data-pipeline): clears cached GBIF responses. `--like=`

### Desktop build tooling (`apps/desktop/scripts/`)
`npm run dist -w desktop` chains `prepare-resources.js`, `fetch-node-sidecar.js`,
`fetch-catalog-seed.js`, `tauri-build.js` and `resign-macos.js`. `headless-postgres.js`
(`start`/`stop`/`status`/`url`) runs the app's embedded Postgres as an independent process, so a
long-running script can point `DATABASE_URL` at it while the app is rebuilt or relaunched.

### Everything else
`packages/data-pipeline/src/fetch/*.ts` and `src/build/build-seed-*.ts` (one per taxon group) are
library modules with their own npm-aliased entry points, only rerun when onboarding a new taxon
group. `src/scripts/archive/` holds one-time scripts already applied; see its README.
