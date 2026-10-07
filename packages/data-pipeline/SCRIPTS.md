# Maintainer scripts

A map of the maintainer scripts in `packages/data-pipeline/src/scripts/` and `apps/desktop/scripts/`, and the one command that refreshes everything installs download.

To set up a machine, start from an empty database, or publish to a fork, follow
[Rebuilding the data](https://sparklysparkspark.github.io/lifer-app/contributing/rebuilding-data)
(`docs/docs/contributing/rebuilding-data.md`): prerequisites with sizes and times, every
environment variable, and troubleshooting. `npm run doctor -w data-pipeline` checks a machine.

All scripts are run with `npx tsx <path>` from `packages/data-pipeline` and read `DATABASE_URL` from the environment (`.env` at the repo root, or
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
npm run refresh -w data-pipeline -- --refresh-occurrences         # re-download GBIF files first (--countries, else the priority ones)
npm run refresh -w data-pipeline -- --full                        # redo every country
npm run refresh -w data-pipeline -- --resume                      # continue an interrupted run
npm run refresh -w data-pipeline -- --publish --accept-drift=<pack id>,...
```

Stages, in order (`src/scripts/refresh.ts` has the details): **occurrences** (GBIF country
downloads, and the list of every species name in them), then **catalog** (current names from
Catalogue of Life, iNaturalist and eBird; species the catalog lacks; duplicate merges; species
iNaturalist has split), **enrich** (photos and descriptions for new species, descriptions
straight from Wikipedia and a refetch of edited articles, Wikipedia pageviews), **regions** (iNaturalist places, province checklists, new catalog species onto lists
built before them, iNaturalist photo counts, escaped pets off the lists, country checklists,
introduced flags, sea zone checklists), **tiers** (absolute local tiers, then worldwide tiers), **vectors** (CLIP and
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
default); `LIFER_INAT_OFFLINE=1` never calls iNaturalist for anything the caches can answer. What it needs
(accounts, keys, PostGIS, the Python environment, `pg_dump` 18, disk) is in
[Rebuilding the data](https://sparklysparkspark.github.io/lifer-app/contributing/rebuilding-data);
`npm run doctor -w data-pipeline` checks it.

### The gate

`src/pipeline/gate.ts` checks the data before anything is published and refuses on any failure,
because the build scripts report success whether or not the data is right. Its checks and how to
read its report (`data/build/gate-<date>.json`) are in
[Rebuilding the data](https://sparklysparkspark.github.io/lifer-app/contributing/rebuilding-data#the-gate).
Add species to `data/reference/checklist-anchors.json` when you spot a gap, and publish past a
reviewed species-count change with `--accept-drift=<pack id>,...`.

### Still check a real pack

The gate catches what it knows about. After publishing, pull one pack and look inside:
`tar -xzf <pack>.pack.tar.gz manifest.json -O | node -e '...'`. A script's own log can look fine
while what it published is wrong.

### Replacing the sea zones

Sea zones (the "nearby water" for fish) are the IHO Sea Areas' named seas
(`src/fetch/fetch-iho-sea-areas.ts`, 94 zones) plus each country's or territory's part of the
oceans from the EEZ x IHO intersect (`src/fetch/fetch-eez-iho.ts`, 171 zones, e.g. "Chilean part
of the South Pacific Ocean"). After a new version of either source, or on a database that still
has older zones (the MEOW ecoregions), run these in order, each with `DATABASE_URL` set to the
database you mean:

1. `npm run replace-sea-zones -w data-pipeline`: a dry run that prints the database it connected
   to and lists the zones it would remove and insert. Then
   `npm run replace-sea-zones -w data-pipeline -- --apply`. It deletes every zone not in the new
   set (their `sea_zone_species` rows cascade, and this database's `downloaded_packs` rows for
   their packs go too), inserts the new ones, and rewrites `regions.nearby_sea_zone_ids` for
   every region from the zones' full outlines. A few minutes, plus downloads of about 250 MB and
   75 MB the first time. Rerunning is safe; unchanged zones keep their species. Rerun it after
   adding regions, to link them.
2. `npx tsx src/scripts/fetch-worms-environment.ts` from `packages/data-pipeline`: each fish and
   marine mammal's habitats (marine, brackish, freshwater, land) from WoRMS, 50 names a request.
   About 15 minutes the first time; later runs only look up species not checked in 180 days.
3. `npx tsx src/scripts/compute-sea-zones-offline.ts --apply` from `packages/data-pipeline`:
   every zone's fish and marine mammal checklist from the GBIF country downloads already on disk
   (`data/gbif-country-cache`), in one pass over the coastal countries' files. Each record goes to
   the zones whose full outline contains it (islands count as part of their sea), and each zone's
   list follows the live path's rules. About 15 minutes and 2 GB of memory; without `--apply` it
   prints each zone's count and writes nothing. `--zones=` limits what it writes (it still reads
   every download). The regions stage of the refresh runs it too. Records GBIF gave no country
   (the high seas) aren't in the downloads, and the type-specimen check needs a field they lack;
   the script's header lists the other differences from `compute-sea-zones.ts`.
3. `npm run refresh -w data-pipeline -- --stages=packs,gate,publish`: new sea zone packs, every
   country pack again (their sea zone dependencies changed), the old zones' packs dropped from
   the index, and a catalog seed carrying the new zones and links. Installs drop the old zones
   when they apply that seed (`catalogSeedUpdate.ts`). The occurrences, catalog, regions and
   tiers stages don't read sea zones and needn't rerun.

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
- `merge-duplicate-species.ts`: folds the reviewed pairs in
  `data/reference/species-merges.tsv` into one species each, the same way installs apply them.
  `--apply`, `--list=`.
- `fetch-wiki-pageviews.ts`: a year of English Wikipedia pageviews per tiered species, the
  interest correction for photo-rated tiers. Skips species fetched in the last 90 days.
- `catalog-quality-report.ts <out.json>`: tier spread and must-have species for a few regions, to
  compare before and after a rebuild.
- `backfill-aba-codes.ts`, `backfill-common-names.ts`: eBird codes and ABA codes from
  `data/reference/ebird-taxonomy.csv`; common names and aliases from GBIF vernacular names.
- `backfill-iucn-status.ts`: IUCN Red List status for every catalog species, into
  `species_traits.iucn_status` as the IUCN code (EX, EW, CR, EN, VU, LR/cd, NT, LC, DD, NE; the
  mapping is `packages/shared/src/iucn.ts`). Reads the Red List archive GBIF hosts (one 20 MB
  download, cached 30 days in `data/raw/iucn-red-list`) and matches by accepted name, IUCN's
  synonyms, the catalog's synonyms, GBIF's key link and Latin-ending spelling, in that order
  (`src/pipeline/iucnMatch.ts`). A split IUCN still assesses as part of its parent gets NE with a
  note naming the parent, not the parent's status. A species with no assessment is stored as NE
  with `iucn_checked_at`, except in groups IUCN covers comprehensively (birds, mammals,
  amphibians, reptiles, sharks and rays, corals), where it stays NULL with a note unless GBIF's
  own key link finds nothing either. Report only without `--apply`; `--report=FILE` writes every
  decision as TSV; `--gbif-fallback=listed|comprehensive|all|none` (default listed: about 2,000
  cached calls the first time). The refresh's catalog stage runs it.
- `build-species-name-index.ts`, `build-species-synonym-map.ts`: resolve names in a GBIF
  bulk download to catalog species, and the gbif_key synonym map `load-seed.ts` uses.

### Region checklists (`packages/data-pipeline/src/scripts/`)
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
- `fetch-worms-environment.ts`: WoRMS habitats (marine, brackish, freshwater, land) for every
  fish and marine mammal, into `species_traits.worms_*`. Run by the regions stage before the sea
  zones. `--recheck-after-days=` (default 180), `--limit=`
- `compute-sea-zones-offline.ts`: every sea zone's fish and marine mammal checklist from the
  cached GBIF country downloads, in one pass (see "Replacing the sea zones"). Freshwater-only
  species (by WoRMS) are left off, and a marine species with only a sliver of its records in a
  zone stays when a neighbouring zone has it well recorded. Run by the regions stage. `--apply`, `--zones=`, `--countries=` (some downloads only, for trying it out),
  `--concurrency=`
- `compute-sea-zones.ts`: one sea zone's checklist from live GBIF polygon searches, for a targeted
  recompute; ~13s a request, so not for every zone. `--apply`, `--zones=`, `--recompute`
- `gbif-bulk-ab-test.ts`: compares the bulk-download approach with live-call results.
  `--dir=`, `--country=`, `--iso2=`

### Rarity tiers (`packages/data-pipeline/src/scripts/`)
- `compute-local-tiers.ts`: absolute tiers for every checklist row from the province data on disk
  and the cached iNaturalist counts (`packages/data-pipeline/src/build/local-tier-model.ts`), plus
  the removal checks that need those inputs (unconfirmed, extinct, never-photographed species, and
  birds eBird never had). Offline, minutes for every country. `--countries=`, `--inputs`,
  `--calibrate[=anchors.json]`, `--strict`, `--apply`.
- `compute-global-tiers.ts`: each species' worldwide tier, its easiest native country's tier.
  `--apply`.

### Enrichment and vectors
- **`enrich-all-species.ts`**: photos and descriptions from iNaturalist and Wikipedia.
  `--taxa=`, `--listed-only`. Skips enriched species, safe to rerun.
- `enrich-listed-batch.ts`: the same for listed species without a photo, 30 to an
  iNaturalist request.
- `recheck-null-photo-species.ts`: retries enriched species that came up with no photo, taking only
  photos whose license allows publishing. Each species is checked again only after
  `--recheck-after-days` (90 by default, tracked in `species.photo_checked_at`); the refresh passes
  `--listed-only`. It stops early if iNaturalist keeps refusing requests, and carries on next run.
  `--countries=`
- **`backfill-descriptions.ts`**: descriptions straight from the Wikipedia article for every
  species without Wikipedia-sourced text (none, or iNaturalist's cut-off copy of the lead). Finds
  the article by the catalog's `wikipedia_title`, iNaturalist's cached link, Wikidata (GBIF id or
  taxon name) or the scientific name, 20 leads a request, and keeps text by the shared rule in
  `packages/core/src/species/descriptionText.ts`. Stores the article's revision id
  (`species.wikipedia_revision_id`); `--refresh` checks 50 revisions a request and refetches only
  edited articles. Resume-safe (each batch is stamped in `species.wikipedia_checked_at`, species
  without an article are looked up again after `--recheck-after-days`, 90). Stops early when
  Wikipedia or Wikidata keeps refusing. `--missing-only`, `--lead-only`, `--limit=`, `--species=`,
  `--dry-run`, `--lang=` (only `en` is stored today). About an hour for 76,000 species with no text.
- `repair-missing-reference-photos.ts`: re-downloads cached main and gallery photos
  whose file is missing. `--dry-run`, `--countries=`, `--adopt`. Needs `APP_DATA_DIR` set to the
  folder the recorded paths live under. `build-region-pack.ts` fails on a missing photo file and
  names this script (`ALLOW_MISSING_PHOTOS=1` overrides).
- `flag-non-photo-reference-images.ts`: finds reference images that are range maps,
  charts or spectrograms by comparing their CLIP vectors with text descriptions. Report first
  (`--out=flagged.json`), review, then `--apply=reviewed.json`: each URL goes into
  `reference_photo_blocklist` (shipped in the catalog), gallery images are deleted, and a map used
  as a main photo is replaced by the first real gallery photo. Hits above a margin of 0.06 are
  reliably maps or charts; between 0.02 and 0.06, review by eye.
- `fetch-occurrence-stats.ts`: `species_traits.occurrence_count` / `last_occurrence_year` (powers
  Hide-Obscure/Ghost/Lost), the same values one GBIF call per species gives, but about 200
  species per request, grouped by order. Each species GBIF answered for is stamped in
  `occurrence_checked_at` (no records means 0 and no year) and skipped until older than
  `--recheck-after-days` (90 by default; 0 takes every species). `--only-missing` (species
  with no count yet; the refresh passes this), `--limit=`, `--batch-size=`, `--interval-ms=`
  (1000). Stops early if GBIF keeps answering 429; the next run carries on.
- `backfill-reference-embeddings.ts`: CLIP vectors for reference and gallery photos.
- `backfill-text-embeddings.ts`: `species_text_embeddings`, the zero-shot text blend
  used when a species has no photo vector yet.
- `python/compute_id_model_vectors.py`: the identification model's (BioCLIP 2) text,
  reference-photo and gallery-photo vectors, into the `id_model_*` tables. Full precision on the
  GPU; installs match against them with the int8 ONNX export. `--only=text|reference|gallery`,
  `--region=<name>`.
- `python/export_id_model.py <dir>`: the identification model files installs download: int8 for
  the CPU (`bioclip-2-v1.onnx`) and a copy for GPUs. Only when the model or its version changes.
  The script writes a float16 GPU copy (`bioclip-2-v1-fp16.onnx`), but `ID_MODEL_GPU_URL` in
  `packages/core/src/config.ts` downloads `bioclip-2-v1-fp32.onnx`, which the script deletes after
  quantizing: check the name and its checksum in `packages/core/src/species/modelChecksums.ts`
  before uploading. Publish with `gh release upload models <file> --clobber` (create the release once with
  `gh release create models --title "Models" --notes "Model files installs download." --prerelease`).
- `python/export_clip_model.py <dir> [fp32.onnx]`: the CLIP model's per-channel int8 CPU file
  (`<dir>/clip-vit-l14-v2.onnx`) from Xenova's full-precision export, which it downloads to
  `<dir>/clip-vit-l14-v2-fp32.onnx` (1.2GB, checked by sha256) unless given. GPUs run the fp32
  file. Publish the int8 file with `gh release upload models <dir>/clip-vit-l14-v2.onnx --clobber`.
- `regenerate-clip-vectors.ts`: CLIP vectors at `clip-vit-l14-v2` for every reference and gallery
  photo, at full precision, through the app's own inference code. Resumable and incremental.
  Stages into `clip_vector_regen`; `--apply` swaps them into `species_reference_embeddings` /
  `species_reference_gallery_embeddings` in one transaction, refusing while any photo is missing
  one. `--limit=N`, `--dry-run`, `--model=<fp32.onnx>` (or `CLIP_V2_FP32_MODEL`; default
  `data/build/models/clip-vit-l14-v2-fp32.onnx`). Switch `EMBEDDING_MODEL_VERSION` (packages/core
  config.ts and data-pipeline embeddings.ts) and the catalog seed's default in the same change as
  the `--apply`, or the vectors stage recomputes every vector with the old model.

### Data checks (`packages/data-pipeline/src/scripts/`)
- `check-fossil-status.ts`: flags fossil-only species as fully extinct.
- `detect-unobserved-legendary.ts`, `detect-implausible-regions.ts`: read-only passes flagging
  likely-bad data for review.
- `flag-nonnative-obscure-taxa.ts`: checks reptiles, amphibians and marine invertebrates on lists
  against iNaturalist's establishment status per place. `--apply`
- `flag-vagrant-mismatch-inat.ts`, `report-vagrant-ebird.ts`: read-only reports of listings
  iNaturalist or eBird don't back up.
- `verify-vagrant-flags.ts`, `verify-vagrant-fishbase.ts`: check vagrant flags against GBIF
  distributions and FishBase's country table.

The four vagrant scripts write their JSONL logs to `data/reports/vagrant/` at the repo root
(gitignored), or to `VAGRANT_REPORTS_DIR` when it's set.

### Packs and the catalog seed (`packages/data-pipeline/src/`)
- **`scripts/refresh.ts`**: the one command (see above). Its pack stage is `pipeline/packs.ts`
  and its gate `pipeline/gate.ts`.
- `scripts/doctor.ts` (`npm run doctor -w data-pipeline`, `-- --publish` for publishing too):
  checks this machine against what the refresh needs and prints a pass/fail list. Read-only.
- `build/build-region-pack.ts`: builds one region's or sea zone's pack archive (taxon-split); used
  by the pack stage, and runnable alone for one pack.
- `scripts/replace-sea-zones.ts` (`npm run replace-sea-zones`): swaps the sea zones for the IHO
  seas and national parts of the oceans, and relinks every region to them (see "Replacing the
  sea zones"). `--apply`
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
  `DATABASE_URL` pointed at a fully enriched database and a `pg_dump` 18: `PG_DUMP_BIN`, else a
  desktop build's bundled one (`LIFER_POSTGRES_DIR`, the staged `resources-staging/postgres`, an
  installed Lifer.app), else `docker exec <container> pg_dump` when `DATABASE_URL` is a port a
  local Docker container publishes, else `PATH`'s (`src/pipeline/pgDump.ts`). Run alone, follow
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

### Taxon seeds (`packages/data-pipeline/src/build/`)
`build-seed-*.ts` build one taxon group's species from GBIF and the trait sources in
[DATA_SOURCES.md](./DATA_SOURCES.md). Each has an npm alias: `build-seed` (birds),
`build-seed-mammals`, `-fish`, `-amphibians`, `-squamata`, `-testudines`, `-corals`,
`-jellies-anemones`, `-sponges-tunicates`, `-echinoderms`, `-crustaceans`, `-marine-mollusks`,
`-cephalopods`, `-nudibranchs`, and `build-seed-test` (a handful of species, to run the whole pipeline end to end in minutes). Run one with
`npm run build-seed-<group> -w data-pipeline`, then `npm run load-seed -w data-pipeline`.
`build-seed-generic.ts` is the shared builder (GBIF, common names, Wikidata) for groups with no
trait source of their own. They're only rerun
when onboarding a new taxon group; the refresh keeps existing groups current.

### Everything else
`packages/data-pipeline/src/fetch/*.ts` are library modules, one per source, used by the seed
builders and the refresh.
