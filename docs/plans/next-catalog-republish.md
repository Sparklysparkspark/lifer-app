# Next catalog republish: checklist

## Decisions needed

Decided by the maintainer 2026-11-24 and applied the same day:

1. **6c membership: flag, don't remove.** A species iNaturalist lacks where it covers the group
   is flagged vagrant (kept, hidden by default) instead of removed. Applied: +35,498 listings,
   56,423 newly vagrant (16,140 country rows not on iNaturalist), 0 removed by the rule; the
   escape and eBird-exotics passes after it took the Netherlands' birds from 793 to 767 at most.
   Great Kiskadee is vagrant in Canada and Ontario. Side effect: the default view hides many
   real strays, e.g. Iceland shows 97 of 377 birds, Venezuela 899 of 1,400.
2. **Coyote occasional in the US:** anchor changed (`checklist-anchors.json`, with a note).
3. **Follow iNaturalist's taxonomy:** _Milvus aegyptius_ merged into _M. migrans_, plus 124
   pairs where iNaturalist files one name under the other's taxon (5,374 checklist rows carried
   over, old names kept as synonyms; `species-merges.tsv`, 6b's merge list). Left alone: 12 pairs
   that each have their own iNaturalist id (Trichiurus japonicus and lepturus, Coregonus
   sardinella and albula, Pampus cinereus and argenteus...) and 3 bird pairs eBird keeps apart.
4. **Pack drift, investigated** (see the status entry). Still open: restore the freshwater fish
   lost on 2026-10-10 (below).
5. **Zoo records and tiers, investigated** (see the status entry).

Decided 2026-11-24 (second round):

6. **Restore the lost freshwater fish? Decided 2026-11-24: yes, where they belong; done (see
   Status).** Original question: The 2026-10-10 province rebuild deleted thinly recorded
   species iNaturalist lacks (now flagged instead, in `compute-provinces-bulk.ts` and
   `occurrences.ts`). That took 744 freshwater fish off Colombia (238 now on no list anywhere),
   about 2,840 across 42 packs, plus other thin species. The GBIF downloads are gone, so the only
   copy is the published 2026-10-08 packs (1.4 GB from Lifer's own release). A restore would
   re-add, flagged vagrant, the published province rows whose species still exist and that no
   clean-up since removed on purpose.
7. **Wolverine worldwide. Decided 2026-11-24: no exception, keep the model.** Now uncommon (was common): Finland's Kainuu photo hides find them
   reliably, which the tier philosophy calls not legendary. Legendary in Canada, the US, Sweden,
   Russia and Mongolia. Keep, or make an exception.
8. **Accept the pack drift. Decided 2026-11-24: accept drift explained by flagging and
   better sources** (309 packs, 265 after the restore) at publish time with `--accept-all-drift` once 6 is
   settled.

## Status (2026-11-25, 09:30): built and verified, not published

Everything up to publishing is done on the Docker `lifer` database and built locally.

- **6c reapplied** offline (07:54) with the yearly counts that arrived: +8,248 listings, 9,673
  newly vagrant, 94 unflagged; then escapes (7,963 province listings off, mostly farm animals and
  pets iNaturalist lists), eBird exotics from cache (2,584 province and 816 group or country
  listings off; 81 naturalized and 21 provisional marked introduced), introduced flags. Backup:
  `data/backups/lifer-catalog-before-6c-morning-2026-11-25-tables.dump`.
- **6b** (08:42): 1,873 decisions, 34 range removals, 0 merges, 1,839 bat and rodent listings
  un-flagged by the resident rule; `data/review/catalog-audit-fixes-applied-2026-11-25T154243.tsv`.
  Backup: `data/backups/lifer-catalog-before-6b-morning-2026-11-25-tables.dump`.
- **Tiers** (09:01, `refresh --stages=tiers`): worldwide 6,258 common, 13,266 occasional, 2,717
  uncommon, 1,927 rare, 956 legendary. Every anchor passes.
- **Freshwater fish restore** (2026-11-24, decision 6): 81,972 rows plus 1,809 derived group and
  country rows, flagged vagrant; see the entry below.
- **Photo-withheld flags** (`backfill-photo-withheld --no-network`): 52 species marked; 23,098
  still unknown until iNaturalist can be asked.
- **Vectors** (offline steps): done. **Packs** (`refresh --stages=packs,gate`): built in
  `data/build/packs-out` (6,001 packs, about 1.45 GB; `pack-index.json` and `pack-index-lite.json`).
- **Gate:** 265 failures, all pack drift, which the maintainer accepts when explained (decision
  8). Explanation per pack: `data/review/pack-drift-explained.tsv`: 190 sea zone packs grew
  with 6a's marine life, 63 packs grew (iNaturalist additions, marine mammals moved out of
  fish, restored rows), 12 shrank from clean-ups (escapes, 6b ranges and splits, extinct, tiers
  removals). No anchor or shared-taxon failure.
- **Catalog seed, verified:** `packages/data-pipeline/data/build/catalog-seed/` (manifest
  `catalog-manifest.json`, version 1795623808084), against the schema through migration 202.
  Sizes and sha256 match the manifest (`verifyCatalogSeed`), and it loads into a freshly migrated
  database (`catalogSeedLoad`, the CI job's check). Files:
  - `lifer-catalog-seed.sql.gz` 221,703,635 bytes, sha256 e9f5cad18569774ffeff27038185cff6fb6773d5aa6365c0602513ea11fe9b0a
  - `lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz` 192,278,065
  - `lifer-species-image-embeddings-clip-vit-l14-v2.bin.gz` 85,215,098
  - `lifer-species-text-embeddings-clip-vit-l14-text-v2.bin.gz` 192,069,102
  - `lifer-id-gallery-embeddings-bioclip-2-v1.bin.gz` 191,471,726
  - `lifer-id-species-image-embeddings-bioclip-2-v1.bin.gz` 84,860,705
  - `lifer-id-species-text-embeddings-bioclip-2-v1.bin.gz` 191,508,215

- **Homo sapiens off every list** (16:40): its 47 listings deleted under the catalog lock (10
  from the province build, 37 from the restore); packs and seed never carried them, so nothing
  needed rebuilding. The tiers stage now removes `NEVER_LISTED_SPECIES` (`compute-local-tiers.ts`)
  and the restore skips them. Backups:
  `data/backups/lifer-catalog-before-homo-sapiens-removal-2026-11-25-tables.dump` (region_species
  and hotspots) and `lifer-homo-sapiens-region-species-rows-2026-11-25.csv`. Gate rechecked
  against the built index afterwards: the same 265 drift failures, each matching
  `pack-drift-explained.tsv` count for count, nothing else.

Not done (iNaturalist refused this machine all night):

- The gallery top-up (`/tmp/run-topup.sh`). If it runs later: then `backfill-photo-withheld`,
  vectors, packs and the seed again, with the top-up paused while the seed builds.
- The vagrant yearly counts for about 290 well-birded regions: their flags stay GBIF's.

Before the maintainer can say go: look over `pack-drift-explained.tsv`, decide whether to ship
without the gallery top-up, then `refresh --stages=packs,gate,publish --publish
--accept-all-drift` (it rebuilds and checks the seed itself).

## Status (checked 2026-11-24 against the Docker `lifer` database)

Done and verified:

- **1. Seasonality.** `region_species.seasonality` is gone (migration 173). Suggestions read months
  from `weekly_frequency` (`monthlyFromWeekly`); pack schemas still accept the old field.
- **4, 5. Index and placeholders.** Migration 169 adds `example_city`, `populous_child_id`, `aliases`
  and indexes on `parent_id` and `home_country_id`. The web placeholders already read them.
- **6. Description rewrites, first pass loaded.** `final/summary_notes.json` (32,433 species) is in
  `species.summary_notes` (32,407 rows, each credited and linked; a rerun writes 0). It was never loaded before, and it was missing the
  31 pilot species (Pileated Woodpecker, Red Fox among them): `build_summary_final.py` now merges
  `all mine`. 26 notes are for species merged away since. Before and after for 25 species:
  `final/sample-for-review.md`.
- **6. Thin-source ledger.** `final/thin_species.json` (47,166 checklist species) from
  `compose_all.py final`. It measures the v2 merge, so 622 species short in the loaded first pass
  are not in it.
- **6b. Catalog audit.** Third run applied 2026-11-23 after the leftovers below (424 decisions:
  91 merges, 26 bird names, 7 extinct, 288 old-concept rows off, 6 thin birds off, 6 iNaturalist
  ids), `data/review/catalog-audit-fixes-applied-2026-11-23T213802.tsv`. Backup:
  `data/backups/lifer-catalog-leftovers-before-6b-2026-11-23-tables.dump` (plus `-merged-rows/`
  for the embedding and hotspot rows of the merged species).
- **2, 3 and alias lists (5b).** Applied 2026-11-23: 5,125 of 5,218 regions have an example city,
  591 a most populous child, 48 an alias list. 26 small territories have no place in Natural Earth
  (Jersey, Guernsey, Anguilla, Nauru, Saint Helena and others) and keep none. Backup:
  `data/backups/lifer-regions-before-places-2026-11-23.dump`.

- **6d. iNaturalist common names.** Applied 2026-11-23: 16,055 non-bird species renamed (old name
  kept as an alias), 509 held back for a name another species of the class shows (review list),
  40,158 with no English iNaturalist name kept. Same-class shared names fell from 1,251 to 668.
  Backup: `data/backups/species-names-before-inat-common-names-1795492398183.json`. Their text
  embeddings wait for the `vectors` stage (8).

- **6. Descriptions v2 and filler, loaded 2026-11-24.** The compose run finished (1,798
  batches, $101.93), then repair, final, accept and filler. Loaded with `load-species-notes`
  after a dry run: v2 27,978 rows (40 for species merged away since), filler 3,518 (2 merged
  away), each credited in its row (Wikipedia 32,606, FishBase 3,266, The Reptile Database 252).
  Backup: `data/backups/lifer-species-before-description-v2-filler-load-2026-11-24.dump`.
- **6b rerun (2026-11-24),** after the eBird change below: 1 decision (Thresher Shark to Common
  Thresher), `data/review/catalog-audit-fixes-applied-2026-11-24T161449.tsv`. Backup:
  `data/backups/lifer-catalog-before-6b-rerun-2026-11-24-tables.dump`.
- **iNaturalist wins over eBird absence (2026-11-24).** 6b's `unlisted-birds` pass and the tiers'
  `removeBirdsEbirdNeverHad` no longer remove a bird iNaturalist confirms in that region (a
  research-grade observation in its cached place list, `inatConfirmedListings` in
  `apply-inat-membership.ts`; a vernacular group counts its provinces). eBird absence still
  removes the rest.
- **7. Tiers, applied 2026-11-24** with `npm run refresh -w data-pipeline -- --stages=tiers`,
  which now works without `province-aggregate-cache/`: a country with no partitions on disk is
  rated from the province inputs already stored, its groups and country summed again
  (`sumAreaRecordInputs`). That also fixed the country and group rows: rebuilding their lists
  (`build-country-checklists.ts`) had dropped their record inputs and tiers, so no country row
  had a tier (Canada 0 of 2,523) and the worldwide tiers had nothing current to read. Now
  country rows: 160,612 of 330,700 tiered (the rest are invertebrates, which have no tier, or
  too few photos), Canada 1,125, Aruba 313 of 580, Puerto Rico 638 of 1,174 (both from their one
  province). Removed on the way: 575 birds eBird never had and nobody recorded in 15 years, 58
  photographed only elsewhere, 42 unconfirmed, 20 extinct. Worldwide tiers changed for 1,024
  species. Vagrant rows carry `tier_reason` 'vagrant' (40,950). Sea zone rows have no local tier
  by design; the app shows the worldwide tier (`localTier ?? tier`, `SpeciesCard.tsx`). Spot
  checks: Great Kiskadee in Canada legendary (vagrant only once 6c is applied), Whooping Crane
  legendary in Canada, Scarlet Macaw and Green Basilisk common in Costa Rica, Mallard common in
  the UK, Green Turtle in the Caribbean Sea zone common worldwide. Backups:
  `data/backups/lifer-catalog-before-tiers-2026-11-24-tables.dump` and the refresh snapshot
  `data/backups/lifer-db-before-refresh-2026-11-24T16-39-26-489Z.dump` (repo root).
- **Schema (2026-11-24).** The `lifer` database stopped at migration 183, so 184 to 197 were
  applied (189 is the photo kinds item 8 needs; the seed must match the current schema). Two
  ledger rows for migrations that exist nowhere in git (`079_home_location`,
  `083_drop_home_location`, an add then drop that left nothing) blocked `migrate` and were
  removed; saved in `data/backups/lifer-schema-migrations-stale-rows-2026-11-24.txt`.
- **8. Vectors, offline steps (2026-11-24):** licence policy, reference embeddings (none
  missing), text embeddings for the 16,055 renamed species, BioCLIP vectors, then photo kinds:
  183,025 photos scored, 181 main photos swapped for a portrait. The stage's GBIF
  occurrence-stats step was left out (no new GBIF data).
- **10. Packs and seed built locally, nothing published (2026-11-24).**
  `npm run refresh -w data-pipeline -- --stages=packs,gate` (24 min): 6,001 packs, 1,443 MB in
  all (largest: US birds 55.5 MB, France birds 54.8, Brazil birds 40.9); 2,632 sea zone packs,
  46 MB together (largest Coral Sea 0.6 MB); `pack-index.json` 29.7 MB, `pack-index-lite.json`
  3.5 MB; photo store in `data/build/photo-store`. Catalog seed built with
  `build-catalog-seed.ts` into a scratch folder: seed 215 MB plus six embedding files (84 to 192
  MB each), sizes and sha256 match its manifest (`verifyCatalogSeed`), and it loads into a
  freshly migrated database (`catalogSeedLoad`, the CI job's check). Rebuild both after the
  gallery top-up and any 6c change; the seed is rebuilt by `refresh --publish` anyway.
- **6c applied 2026-11-24 (afternoon)**, flags instead of removals, with
  `LIFER_INAT_OFFLINE=1` and `--no-followups`, then `remove-escapes --apply`,
  `apply-ebird-exotics --apply --max-requests=0` (cache only: no eBird calls) and
  `LIFER_INAT_OFFLINE=1 apply-introduced-flags --apply`. Escapes removed 7,933 province listings
  (mostly farm animals and pets iNaturalist had just added), eBird exotics 2,848. 292 regions
  still lack some yearly counts (iNaturalist throttling); their vagrant flags stay GBIF's until a
  later preview fetches them. Backup:
  `data/backups/lifer-catalog-before-6c-inat-membership-2026-11-24-tables.dump`.
- **6b after 6c (2026-11-24):** 125 merges, 18 range rows, 1 extinct, 1 flag override, 1,068 bat
  and rodent listings un-flagged by the resident rule; 6b and the tiers now count a child
  region's iNaturalist confirmation for its parent too. Backup:
  `data/backups/lifer-catalog-before-6b-merges-2026-11-24-tables.dump`.
- **Tiers after 6c and 6b:** `refresh --stages=tiers` (76 listings off: 51 extinct, 24 birds,
  1 never photographed). For a group rated on photos (mammals, herps, fish), a province rated
  on GBIF records now counts for the country only when no province is rated on photos:
  Norway's Wolverine monitoring records (DNA, tracks) had made it common. Every anchor passes.
- **Zoo and captive records do not inflate tiers.** The tiers read research-grade iNaturalist
  photos only, and captive observations never reach research grade (US Lion: 1,382 captive, 0
  research; Giant Panda in China 365 captive, 32 research; Tiger in India 325 and 2,668). GBIF
  inputs count human and machine observations only, never `LIVING_SPECIMEN`. Worldwide before
  and after: Wolverine common to uncommon (Finland), Snow Leopard common to uncommon, Tiger
  common (wild safari photos, Madhya Pradesh), Osprey common (eBird rate in Delaware; birds
  unchanged), Lion common (Tanzania), African Elephant common (Kruger), Greater Flamingo common
  (Spain), Polar Bear occasional (Greenland), Red Panda uncommon, Giant Panda legendary.
- **Pack drift, why:** the drops happened on 2026-10-10, not in this work. Colombia fish 2,814 to
  1,543: 461 marine fish moved to the sea zone packs the country depends on (correct), 744
  freshwater fish deleted by the province rebuild's iNaturalist reconcile (a bug, decision 6),
  about 66 others to clean-ups. Japan fish 2,800 to 2,015: 667 moved to sea zones, 33 freshwater
  lost, about 129 to clean-ups. Of the 63 packs that shrank, 20 mostly lost fish to sea zones,
  18 mostly lost freshwater fish, 23 lost listings to clean-ups (6b, escapes, tiers); most of the
  246 that grew are sea zone packs (6a's marine life) and mammal packs (whales moved out of
  fish, iNaturalist additions).
- **Rebuilt locally after all of it (2026-11-24, nothing published):** vectors (offline steps),
  packs (6,001, 1,450 MB; sea zones 46 MB; index 29.7 MB, lite 3.5 MB), catalog seed (207 MB
  plus embedding files, 1,132 MB in all; sha256 and sizes match; loads on a fresh database).
  The gallery top-up must pause while the seed builds (it changes gallery embeddings mid-export).
- **Gate:** 309 failures, all pack drift (decision 8). Anchors pass, no shared iNaturalist taxa.
  Warning: 18,328 listed species have no reference photo.

Still to do:

- Decisions 6, 7 and 8.
- **Gallery top-up** (`/tmp/run-topup.sh`, nice 19, retries every 30 minutes while iNaturalist
  throttles), then `npm run backfill-photo-withheld -w data-pipeline`, the offline vectors steps,
  and the packs and seed again (`refresh --stages=packs,gate`, then `build-catalog-seed.ts`).
- A later `npm run apply-inat-membership -w data-pipeline` preview to fetch the 292 regions'
  missing yearly counts, then `-- --apply` and 6b and tiers again.
- **5b, 5c, 5d, 5f, 5h** leftovers as listed under each item.
- Then publish, only with the maintainer's go-ahead.

The catalog (species, regions, rarity tiers) and region packs are held back until the **description
rewrites** land. That's when one complete republish happens. Everything below has to be done first, in
this order, so the republish carries it all. Ask the maintainer before running anything against the
`lifer` database and before publishing.

## Already applied to the `lifer` database (not yet published)

- **Escapes and eBird exotics (2026-10-21)**, run as `npm run refresh -- --stages=regions --keep-provinces`
  in `packages/data-pipeline`.
  - Removes escapees.
  - Marks Naturalized and Provisional species as introduced.
  - Keeps reintroduced natives (`data/reference/reintroduced-natives.json`) and known feral populations
    (`data/reference/known-feral-populations.json`).
  - Fixes 472 eBird region codes.
  - Backup taken before it ran: `data/backups/lifer-db-before-refresh-2026-10-21T06-46-29-370Z.dump`.

## Still to do before the republish

1. **Seasonality cleanup.**
   - Drop the unused `region_species.seasonality` column and derive months from `weekly_frequency`.
   - Fix the suggestion seasonal boost, the species page and pack back-compat to match.
2. **Example city per region.**
   - The capital, else the largest populated place, else the country's capital. Territories use their
     own capital.
   - Source: Natural Earth populated places. It's used for placeholders in region search and place
     names.
   - Command: `npm run refresh -w data-pipeline -- --stages=places` (also items 3 and the 5b alias
     lists). Rerun it after any regions-stage run.
3. **Most populous province per country**, from the same source.
4. **Index** `regions(parent_id, home_country_id)`.
5. **Hook the web placeholders** (region search and place name inputs) to the new fields.
   5b. **Countries within countries.**
   - Give constituent countries, realms, SARs, territories, overseas regions and crown dependencies a
     consistent model: each is reachable on its own and under its sovereign, with one naming rule and
     consistent downloads.
   - Fix the duplicate rows (Aruba and Puerto Rico each appear twice).
     **Checked 2026-11-23, decision needed, nothing changed.** Not duplicates: each is a country row
     plus its one province (Natural Earth's single admin-1 area, `AW-X01~`, `US-PR`), which the
     drill-down makes for every country. 17 countries have one same-named province (Guam, Curaçao,
     Jersey, Isle of Man, Monaco and others). The country row is a superset (Aruba 581 species, its
     province 370) but the province holds the local tiers and is what the province build and tiers
     stage compute from, so deleting it would leave the country untiered. Options: the app treats a
     country's only same-named province as the country (search and area pills), or the pipeline
     tiers one-province countries on the country row before the province is dropped.
   - Add region alias lists (Britain, Holland, USA, Burma, Czech Republic, Türkiye...) for search.
   - The app side is the region search backlog item.
     5c. **Stale GBIF keys.** About 1.8% of checklist species carry GBIF taxon keys that no longer match
     GBIF's current backbone (e.g. "Pipra europaea" in the UK, "Psittacus moluccanus" in Queensland).
     Re-resolve them during the name-drift work.
     **Partly done 2026-11-23** (6b's `names` pass, no GBIF): the 12 nameless birds that eBird lists
     under a code were stale names. 8 renamed to eBird's name (_Pipra europaea_ to _Aegithalos
     caudatus_, _Psittacus moluccanus_ to _Trichoglossus moluccanus_ and 6 more), 3 merged into the
     row already there (_Falco ichthyaetus_, _Aramides avicenniae_, _Babax woodi_); the old names stay
     as synonyms. The general re-resolve is still open.
     5d. **Escapees the exotics pass missed.** British Columbia still lists Cockatiel, Black Swan, Egyptian
     Goose, Ruddy Shelduck, Demoiselle Crane, White-rumped Munia, White-cheeked Starling and
     White-cheeked Pintail. They have 1 to 6 old records, so eBird's 30-day exotic windows never saw
     them. Check species with known captive or pet origins that have a handful of records outside their
     native and established range, across all regions, and remove them or flag them for review.
     **Applied 2026-11-23:** the escape rule already judges these birds (`captive-origin-species.json`,
     regions stage), but no regions run had happened since. Rerun on its own, offline:
     `npx tsx src/scripts/remove-escapes.ts` (dry run), then `--apply`, from `packages/data-pipeline`
     (the regions stage runs the same step). 135 listings off worldwide (Cockatiel 20, Budgerigar 11,
     Wild Turkey 10, lovebirds, munias, Demoiselle Crane, Black Swan 8...), listed in
     `data/review/escapes-removed-2026-11-23.tsv`. BC lost Demoiselle Crane, Ruddy Shelduck,
     White-cheeked Pintail, White-cheeked Starling and White-rumped Munia. Cockatiel, Black Swan and
     Egyptian Goose stay, marked introduced: Washington, Oregon and Alberta list them with 8 to 783
     records (mostly eBird escapes), which the rule reads as a population next door. Telling those
     apart needs eBird Naturalized status, which its 30-day windows rarely show. The rule also missed
     Pygmy Right Whale's family (Cetotheriidae, once the classes pass made whales mammals); added.
     Backup: `data/backups/lifer-catalog-cleanup-before-escapes-2026-11-23-region-species.dump`.
     5e. **GBIF records dropped by the land-boundary match.** Museum specimens without coordinates, and
     offshore seabird records, are lost because checklists only use records inside the land boundary.
   - Also match on the record's province/state name, and include nearshore waters for seabirds.
   - Keep the "occurrenceStatus = present" filter (atlases publish "absent" rows).
   - This recovers real vagrants and seabirds for every region.
   - Superseded 2026-11-08: no new GBIF occurrence data for this republish. Reuse the data from the last
     publish; the 165 GB re-download approved on 2026-10-25 is not run now.
     5f. **eBird-only species that no other list supports.** Some regional checklists carry species backed
     only by a handful of eBird records and by no official or open list. Examples: Florida Scrub-Jay,
     Altamira Oriole and Rock Partridge in Ontario; Ferruginous Hawk and Paddyfield Pipit in the UK;
     Pallas's Bunting in BC.
   - Cross-check each region's eBird-only species against open lists (clean GBIF records, open
     government lists such as BC's CDC list, Wikipedia's regional bird lists) and drop or mark
     "unconfirmed" those with no support and very few records.
   - Map taxonomy mismatches to the accepted species (Vega Gull, Black-backed Swamphen).
   - Escapees are covered by 5d.
   - Decided 2026-10-25: open regional checklists are approved as cross-check sources.
   - **Status 2026-11-23:** the rule is built (`check-ebird-only.ts`, in the regions stage after
     the escapes) but `data/reference/open-region-lists.json` is still empty, so it judges nothing.
     No open regional list is on disk; filling it needs those lists downloaded and their licences
     checked. eBird's own region lists already drive 6b's `unlisted-birds` pass.
   - **Checked 2026-11-23, left empty.** The only list-like file on disk,
     `inat-listed-taxa-cache.json`, is iNaturalist's user-curated place establishment data: no
     stated open licence, and iNaturalist photos already count as records, so it supports nothing
     new. Government lists (BC CDC) and Wikipedia lists are not on disk; each needs its own fetch
     and licence check. The check now judges only regions an open list covers (before, one
     entry would have pruned thin eBird-only birds in every province worldwide).
   - The method and scripts are in the private culling research (vagrant coverage). The same
     cross-check makes free Lifer's lists more trustworthy.
     5g. **Openly licensed gallery vectors, tagged per vector.** Prefer CC0 and CC BY photos for the
     per-species gallery embeddings (iNaturalist observation photos, Wikimedia Commons), quality-filtered
     (research grade, minimum size, subject detected), up to the existing 6 per species. Keep the current
     non-commercial vectors only where a species has fewer than 3 open ones. Store each vector's licence,
     photographer and source URL, so the open subset can be told apart and credited. Measure first:
     top-1 and top-5 on confirmed GPS captures, current gallery vs new, per group; ship only if matching
     holds. One parameterised, resumable stage, incremental on species whose photos changed.
     **Collection started 2026-10-26:** `npm run open-vectors -w data-pipeline` (SCRIPTS.md) gathers the
     iNaturalist vectors into `data/open-vectors/` as files only. Importing them into the catalog waits
     for this republish and the maintainer's go-ahead; GBIF fills gaps later.
     **Collection finished 2026-10-27:** 165,438 photos for 36,938 species in 23 h 20 min.
   - Coverage of common and occasional species (by `species_rarity.tier`) is 95% for birds, 92% for
     mammals (without bats, rodents and shrews), 91% for reptiles and 79% for fish.
   - Most species with no photo are unrated or rare, or are island and tropical endemics.
   - The downloaded photos (32 GB in `data/open-vectors/inat/`) are only needed to extend the run.
     Before importing:
   - **Match on iNaturalist taxon id, not the scientific name.** Recent renames hide photos. For
     example, Lesser Sand-Plover has 6 photos under iNaturalist's _Anarhynchus mongolus_, but the
     catalog still says _Charadrius mongolus_, so it reads as missing. `species.inat_taxon_id` already
     exists; join the provenance file's `inat_taxon_id` column on it.
   - **Find out why some very common species got nothing.** Savannah Sparrow (_Passerculus
     sandwichensis_) has no photos at all, which points to a gap in the collection step itself (the
     taxon lookup or licence filter), not missing open photos. Check a sample of common North American
     birds, fix the cause, then rerun only the species that came back empty. Never redo the whole run.
     **Checked 2026-11-14:** not a collection gap. Matching was already by taxon id first. Savannah
     Sparrow (and Mallard) were skipped on purpose: Lifer's own gallery already holds 6 or more CC BY
     or CC0 vectors, and a species short in `rows.jsonl` usually tops up to 6 from them. So the
     import must count Lifer's open gallery vectors plus the file, never the file alone. The real
     empties among common species are duplicate catalog rows from renames and splits (Charadrius
     mongolus next to Anarhynchus mongolus, Tamias merriami next to Neotamias merriami, Milvus
     aegyptius sharing Milvus migrans's taxon id): the photos sit on the current-name row, which the
     name drift cleanup should merge. Of the rest with fewer than 3 open vectors (102,764 species),
     60,389 have no `inat_taxon_id` and no iNaturalist name match, 36,439 have no open research-grade
     photo on iNaturalist and 5,868 have only 1 or 2. The script now reopens finished species that
     fall short; the extension run (29 s) checked 14,025 of them and added 1 photo.
   - **Gallery top-up (piloted 2026-11-13, not run on `lifer`).** `npm run top-up-galleries -w data-pipeline`
     fills galleries under 5 publishable photos up to 6 from the most-voted research-grade iNaturalist
     observations (publishable licences, one photo per observation, non-portraits left out), with their
     matching vectors. Resumable; `--class`, `--region`, `--per-class`, `--limit` (SCRIPTS.md).
     Pilot on a scratch copy, Belize, up to 100 thin species per class (683 species): 668 gained
     photos (3,144 in all), 14 had no open-licence photos, the portrait check left out 31 (mostly
     mammal specimens and labels; marine classes almost none). Licences: 76% CC BY-NC, 14% CC BY.
     On one held-out observation photo per species (633), top-1 / top-5 against every species went
     from 39.5 / 61.8 to 54 / 77.6 (regional 62.6 / 80.4 to 74.1 / 91), with gains in every class
     but mammals (38 to 39 top-1). The 306 labelled Belize photos were unchanged (278 top-1).
     Catalog-wide: about 67,000 thin species, about 350,000 empty slots; at the pilot's pace (about
     7 s per species) roughly 5 to 6 days and about 15 GB of reference images. Run before the
     `vectors` stage (item 8) and the pack build.
     5h. **Catalog name and taxon clean-up** (found while checking open-vector coverage, 2026-10-27).
   - **Fossil and extinct-only taxa.** The bird list includes fossil ducks with no common name (_Nettion
     ogallalae_, _Querquedula integra_, _Shiriyanetta hasegawai_, _Fuligula sepulta_, _Geochen rhuax_,
     _Miotadorna sanctibathansi_ and others). Drop fossil taxa. Keep recently extinct species only if
     there's a reason to (decide the rule).
     **Done 2026-11-23** (6b's `extinct` pass). Rule: a species on no region or sea zone list and in
     no one's captures or marks is flagged `fully_extinct` (kept in the catalog; lists, Collection
     and search already leave those out) when eBird's taxonomy marks it extinct, when the cached
     GBIF species profiles call it extinct from a taxonomic source with none saying extant and no
     observation since 1990 (check-fossil-status.ts's rule, offline, never fetched), or when it is a
     bird eBird's taxonomy doesn't know that has no English name. eBird lists every living bird, so
     the last are fossils or retired old names. Listed species are never touched: a list means a
     person should look (_Turdus poliocephalus_, now eBird's extinct Norfolk Island Thrush, is still
     the catalog's Island Thrush on 103 lists). First run: 845 flagged (831 nameless birds, 6
     recorded extinctions such as Wake Island Rail, 8 fossil penguins), the fossil ducks among them.
   - **Species with no common name.** 2,082 bird rows have an empty `common_name`. Fill them from
     iNaturalist or Wikipedia (via iNaturalist's `wikipedia_summary`), or drop them where they're
     fossils.
     **Done 2026-11-23** (6b's `bird-names` pass): no name source on disk covers them (eBird,
     iNaturalist caches, EltonTraits), except eBird by eBird code, which named the 8 renamed rows of
     5c. Of 2,070 nameless birds left, 2,068 are now hidden by the extinct rule above; 2 stay
     listed and unnamed (_Muscicapa flabellifera_, listed in central Africa, and _Passer indicus_ in
     Kazakhstan), for the name-drift work.
   - **Outdated scientific names.** Bring scientific names in line with current taxonomy, with the old
     names kept as synonyms for search (for example _Charadrius mongolus_ to _Anarhynchus mongolus_).
     This overlaps 5c and the name-drift work.
   - **Typos.** Barnacle Goose is stored as _Branta leucopis_; the correct name is _Branta leucopsis_.
     Scan for near-miss names against GBIF's or iNaturalist's backbone and fix them.
     **Branta leucopis merged 2026-11-23** (`species-merges.tsv`, 6b's `names` pass).
     **Wider scan done 2026-11-23:** 2,718 pairs in `data/review/typo-candidates-2026-11-23.tsv`
     (same family, binomials 1 or 2 letters apart with a shared genus or epithet, or one-letter
     genus with a shared epithet; plus same-name pairs whose genus changed), ranked by shared
     lists. Merged only where eBird (birds) or iNaturalist's taxonomy accepts one name and not the
     other, with the same common name, and the names differ by a spelling variant (one letter, or
     the ending: -i/-ii, -us/-a) or by an old genus iNaturalist lists as inactive: 91 merges
     (Ochotona pallasi, Oenanthe heuglini, Babax lanceolatus, Cossypha caffra, Psitteuteles iris...).
     1,199 are two species, 1,428 unclear and left (both names unknown, or the evidence is mixed,
     like Oedipina complex/komplex and Montipora verrucosa/verruculosa, two real corals).
   - **eBird-extinct names on living rows** (2026-11-23). Scan of eBird's extinct species by name
     and by code: one collision, _Turdus poliocephalus_, the catalog's broad Island Thrush (IUCN
     LC, 103 lists) carrying eBird's extinct Tasman Sea Island-Thrush code. Its eBird code is
     unlinked and it is pinned alive (`species-corrections.json`, new `ebirdCode` field). Still
     open: splitting its lists into eBird's island thrushes, most of which the catalog lacks; its
     iNaturalist id also points at the narrow taxon. 7 recorded extinctions under old names
     (Laysan Rail, Stephens Island Wren...) are now hidden by matching eBird's code too. Not
     collisions but for the maintainer: eBird-extinct species still on lists as themselves
     (South Island Kokako 12, Pink-headed Duck 3, Jamaican Pauraque 3, Laughing Owl 3, Crested
     Shelduck 2, Himalayan Quail 2, Guadalupe Storm-Petrel 2).
   - **Shared common names** (2026-11-23). 26 birds that shared a name with another bird of the
     same class got eBird's name (Coconut Lorikeet for _Trichoglossus haematodus_, Grass Wren,
     Morepork, Kurdish and Persian Wheatear...), the old name kept as an alias. Where the renamed
     species is the narrow half of a split, its old-concept rows (no research-grade photos, the
     sister listed) came off through `replacedNames`: 288 rows for 14 splits (Grass Wren in the
     US and Canada, Coconut Lorikeet in Australia). Left: the mutual splits (Xenops, the two
     wheatears, Southern Boobook and Morepork, the yellow-throated greenbuls), 28 bird groups
     (mostly fossils with names like "Gull"), and about 1,300 groups in other classes, which no
     name source on disk settles (the iNaturalist cache holds names for few of them); 6b's
     `shared-common-names.tsv` lists those seen in one country. _Milvus aegyptius_ into _Milvus
     migrans_ sits in `species-merges.tsv` unapplied (751 lists): a taxonomic call to make.
   - **Measure afterwards:** re-count open-vector coverage per group and tier. The joined counts should
     rise once renamed species match by taxon id.
     5i. **Offline town list (MAP-07).** Migration 183 adds `gazetteer_places`; the refresh command's
     `gazetteer` stage fills it from GeoNames `cities1000` (CC BY 4.0, 171,771 towns, 6.2 MB compressed
     in the seed). **First run on the `lifer` database 2026-11-04** (about a minute, no snapshot needed).
     Rerun `npm run refresh -w data-pipeline -- --stages=gazetteer` after any region changes above (it
     reads region outlines; unchanged towns are not rewritten), check its spot-check lines in the log,
     then the seed build includes the table on its own. Until the republish, installs have an empty
     list and keep region names for search and place localities.
6. **Description rewrites** (the reason this republish is waiting).
   - **CC BY-SA credit.** Rewritten text is an adaptation of Wikipedia, so it ships under CC BY-SA 4.0
     with "Wikipedia contributors (CC BY-SA)" and the article link. `load-species-notes` stamps
     `credit` and refuses (throws) any note with no article title; any new description loader must
     set `description_credit` and `description_source_url` the same way and refuse rows without them.
   - **Thin-source ledger.** Species whose Wikipedia sources are too thin (under about 75 usable
     words) or whose text stays short publish as they are, and are listed in
     `packages/data-pipeline/data/habitat-notes-cache/final/thin_species.json` (source words, final words, reason, sources tried).
     Use it to target a later pass from another source (for example Reptile Database for reptiles,
     FishBase for fish) once their licences are checked.
   - **6.1 v2 compose run.** In `packages/data-pipeline/data/habitat-notes-cache/`:
     `./run_compose_all.sh --stage compose 4`, then `--stage repair 4`, then `--stage final`. Resumable:
     only batches with no result run. A rate limit (429) pauses every worker 10 minutes
     (`logs-v2/ratelimit.log`). Cost and checker pass rate: `python3 compose_all.py stats`.
   - **6.2 Accept v2 over the first pass.** `python3 compose_all.py accept` writes
     `final/summary_notes_v2_load.json` and `review/v2-before-after.md`. A species loads v2 only when it
     was composed, its opening survived, every sentence passes `check.py` against its cited Wikipedia
     sentences, no lint flag is left, it has 2 to 8 sentences and 45 to 75 words (or no fewer words
     than the first pass when the source is short), and it differs from the first pass. Others keep
     the first pass. Load: back up `species(id, summary_notes)`, take the catalog lock, then
     `npm run load-species-notes -w data-pipeline -- --summary=data/habitat-notes-cache/final/summary_notes_v2_load.json --habitat=/nonexistent --identification=/nonexistent`
     (add `--dry-run` first).
   - **6.3 Filler from a second source.** `./run_compose_all.sh --stage filler 4` (`filler.py`):
     thin species (ledger entries under 75 Wikipedia words, plus loaded first-pass texts under 25
     words) written from FishBase (fish) or the Reptile Database (reptiles), common species first,
     same prompt, checker and lint. Writes `final/summary_notes_filler.json` with per-row `credit`,
     `source_url`, `licence` and `licence_url` (the species page shows "Adapted from FishBase (CC
     BY-NC 4.0)" with links), and `final/sample-filler-for-review.md`. A paragraph is kept when its
     opening and at least 2 sentences pass and it is 25+ words and longer than the loaded text.
     Rerun `python3 filler.py final` after 6.2 so it compares with the v2 text. Load the same way as
     6.2 with `--summary=.../final/summary_notes_filler.json`.
     Sources, licences checked 2026-11-23: FishBase text is CC BY-NC 4.0 and may be used on
     non-commercial sites with a credit and a link back (https://fishbase.se/summary/citation.php;
     data from the rfishbase snapshot v24.07, https://huggingface.co/datasets/cboettig/fishbase).
     The Reptile Database: its own Dec 2014 data dump, CC BY 4.0
     (https://doi.org/10.6084/m9.figshare.3180265), used instead of Internet Archive snapshots of
     the live site, whose text carries no open licence. Both downloads sit in
     `data/filler-cache/` (git-ignored). SeaLifeBase (same licence as FishBase) could fill marine
     invertebrates the same way later.
     6a. **Sea life beyond fish in the sea zones.** `npm run build-sea-zones-marine -w data-pipeline`
     (dry run), then the same with `-- --apply`. Adds each zone's nudibranchs and other molluscs,
     corals, anemones and jellies, echinoderms, crustaceans, sponges and tunicates, sea turtles and
     sea snakes from OBIS checklists of the zone polygon (the zones had fish and marine mammals
     only). Needs the sea zones and their region links (`replace-sea-zones`), the catalog names
     after 5h, and the cached iNaturalist place lists. A first run asks OBIS once per zone and group
     (about an hour); answers are cached in `data/obis-checklist-cache/`, so reruns are offline and
     resumable (`--offline`, `--zones=`). Keeps a species with 5 or more records in the zone, or 1 or
     more plus 3 research-grade iNaturalist photos in a place next to it, then drops strays from
     another ocean (`sea-basins.ts`) into `data/review/sea-zones-marine-strays.tsv`. The regions
     stage runs it after the fish. Run before 6b, the tiers (7) and the packs (10).
     6b. **Catalog audit fixes** (from `docs/plans/belize-data-audit.md`; applied to `lifer` on 2026-11-19
     and, with the new passes, on 2026-11-20).
   - Command, from the repo root: `npm run fix-catalog-audit -w data-pipeline` (dry run), then the same
     with `-- --apply`. One transaction of about a minute and a half, no downloads: zone outlines come
     from `data/raw`, eBird region lists from `data/ebird-spplist-cache`, iNaturalist names from
     `data/open-vectors/inat/taxa.csv.gz` (each pass that needs a missing file is skipped with a
     warning). `--passes=inat-ids,names,bird-names,extinct,ranges,additions,unlisted-birds,flags,resident-mammals,classes,sea-basins,shared-names`
     runs some passes only.
   - Order: after every regions-stage run (5b, 5d, 5f, and item 9 if it is done; a province rebuild
     puts the trimmed rows back, so rerun this after it) and before the tiers (7), vectors (8) and
     packs and seed (10). Safe to rerun: a second run changes nothing.
   - Back up first (`npm run backup -w data-pipeline`); undo by restoring that dump.
   - Decisions live in `data/reference/catalog-audit-fixes.json`, plus two merge rows in
     `species-merges.tsv` and five names in `species-corrections.json`. Every change goes to
     `data/review/catalog-audit-fixes.tsv` (an applied run keeps its own `-applied-<time>.tsv`), the
     per-zone counts to `catalog-audit-sea-zone-counts.tsv`, and common names two species share in one
     country's view to `shared-common-names.tsv` (report only).
   - First run (2026-11-19): 1 merge, 2 renames, 7 common names, 240 checklist rows off (range
     exclusions, old split names), 13 flag overrides, 137 marine mammals moved out of the fish class
     (item 8b), 324 sea zone rows off in 45 zones (Caribbean Sea 139, and 7 more there from the range
     exclusions), 10 deep-sea rows listed for review.
   - Second run (2026-11-20): 26,311 iNaturalist ids linked, _Dasyatis hastata_ merged into Roughtail
     Stingray, the 10 deep-sea rows off (now reviewed range exclusions), 6 Belize freshwater fish
     added, 8,010 thin bird listings off that eBird never had there, 3,068 bat and rodent listings no
     longer flagged vagrant (2,913, then 155 more once the rule followed chains of neighbours).
   - Third run (2026-11-23, after 5h's leftovers and 6a): 91 merges, 26 common names, 7 extinct
     under old names, 288 old-concept rows off for 14 splits, 6 thin birds off, 6 iNaturalist
     ids; the sea-basins pass found nothing new in the marine rows. The ids reach the gallery top-up (it selects species with an id), so run
     `top-up-galleries` and then `backfill-photo-withheld` before the packs and seed.
     6c. **iNaturalist decides membership and vagrants** (maintainer decision: iNaturalist is the source
     of truth for whether a species is in a region, GBIF is secondary occurrence data). Until now GBIF
     built the lists, any single research-grade iNaturalist photo cleared a vagrant flag, and the
     country list took a vagrant only when every province flagged it, so Canada's 760 birds had 5
     vagrants and Great Kiskadee (46 observations, all in 2018) showed by default. The new step lists a
     species where its place has a research-grade observation, flags vagrant one iNaturalist lacks
     where it covers the group (20,000 observations of it there), and flags a bird seen in at most 2 of the
     last 10 complete years where birds are that well observed (a province otherwise takes its
     country's call, then GBIF's existing flag). Hand-checked overrides still win; GBIF range
     checklist overrides no longer do. Rules: `src/regions/inatVagrancy.ts`.
   - Command: `npm run apply-inat-membership -w data-pipeline` (dry run: per-region counts and 30 spot
     checks), then the same with `-- --apply`. Back up `region_species` first. About 11,000 iNaturalist
     requests (3 hours or more), cached in `data/inat-year-counts-cache`, so a throttled or stopped run
     resumes. `--apply` reruns `remove-escapes`, `apply-ebird-exotics` and `apply-introduced-flags`
     after it. The regions stage runs it after the country lists.
   - Dry run on the 2026-11-23 backup: Canada 760 birds to 656, vagrants 5 to 120 (536 shown by
     default), Great Kiskadee flagged; removals are old split concepts (Yellow Warbler, Common Snipe),
     escapes and GBIF-only strays.
   - Order: after 6b and before the tiers (7). 6b's `unlisted-birds` pass and the tiers'
     `removeBirdsEbirdNeverHad` keep every bird iNaturalist confirms in the region (2026-11-24).
   - A species iNaturalist lacks is flagged vagrant, never removed (maintainer, 2026-11-24);
     applied that day. Every change goes to `data/review/inat-membership-changes.tsv`. Run the
     follow-ups cache only when eBird calls aren't allowed (`--no-followups`, then the three
     scripts by hand, `apply-ebird-exotics --max-requests=0`).
     6d. **iNaturalist common names** (maintainer decision: iNaturalist is the source of truth for
     non-bird names; birds keep eBird's). `npm run apply-inat-common-names -w data-pipeline` (dry
     run: counts per class, 40 spot checks), then `-- --apply` (backs up the names it changes to
     `data/backups/species-names-before-inat-common-names-*.json`, writes under the catalog lock).
     The old name becomes an alias, so search still finds it. Names are cached in
     `data/inat-common-names-cache`, so a rerun fetches only new taxa. A rename onto a name another
     species of its class shows is held back and listed in
     `data/review/inat-common-name-collisions.tsv`. `--apply` drops the CLIP text embeddings of
     renamed species: the `vectors` stage (8) recomputes them. Manual choices live in
     `data/reference/common-name-overrides.json` and win over iNaturalist's name on every rerun.
     Order: after 6c, before the tiers, packs and seed (all carry the name).
7. **Re-run the rarity tiers stage.** Tiers are older than the regions run above, and the publish gate
   will notice.
   Command: `npm run refresh -w data-pipeline -- --stages=tiers` (local tiers, then worldwide).
   Without `province-aggregate-cache/` on disk it rates each country from the province inputs
   already stored and sums its groups and country again, so it works without the partitions.
   Read the preview first (`npx tsx src/scripts/compute-local-tiers.ts --calibrate` from
   `packages/data-pipeline`; it writes the summed inputs, so take the lock): the stage also
   removes listings (unconfirmed, extinct, never photographed there, birds eBird never had and
   iNaturalist doesn't confirm). Sea zone rows get no local tier by design; the app shows each
   species' worldwide tier there, and marine-only species with no country listing stay unrated.
   Domestic breeds (added 2026-11-26): species marked `domesticWhereIntroduced` in
   `species-corrections.json` (Red Junglefowl's chicken, Indian Peafowl, Helmeted Guineafowl, Swan
   Goose, Muscovy Duck) count as domestic in every country where iNaturalist lists them as
   introduced. This stage then gives them no local tier and clears their vagrant flag there (the
   chicken in Belize shows "Vagrant" and "Legendary here" until it runs). In the native range the
   wild bird is unchanged. Check one in the preview: Gallus gallus in Belize should be unrated.
8. **Reference photo kinds (migration 189).** The `vectors` stage of the refresh command scores every
   reference photo as a portrait or not (eggs, nests, specimens, drawings, maps...) and swaps a main
   photo that isn't a portrait for the species' best portrait. It only scores rows that have no
   score yet, so it is quick. Run it before the packs and seed, so they ship the scores and the
   swapped covers (about 120 species on the current data, Common Pauraque among them) and
   installs have nothing left to score. Check its log line for the counts.
   - Open issue found while doing this: 6,134 species display a promoted gallery file as their main
     photo, and 5,484 of them also have a separate, newer main file on disk, so the photo shown and its
     credit may not match (as with Common Pauraque, whose eggs photo showed under another person's
     credit). Packs ship the displayed file, so this is also an attribution problem for the
     Creative Commons licences. The cause was `persistReference.ts` and `load-seed.ts` updating the
     photo's address but keeping the old file path. Decide whether to re-fetch the mismatched main
     files before the republish; until then credits can be wrong for those species.
     8b. **Wrong taxon class on some species.** The dev catalog lists West Indian Manatee (`Trichechus
manatus`) with taxon class `actinopterygii` (fish), although its order is Sirenia. Any "is this a
     mammal" check that reads the class misses it (found when a mangrove river photo was suggested as
     manatee). Audit the class of every species against its order and class from the taxonomy source,
     fix the mismatches in the pipeline, and report how many species changed.
     **Covered by item 6b** (its `classes` pass): 137 species (99 whales and dolphins under
     Artiodactyla, 34 seals and otters under Carnivora, 4 Sirenia) move to `mammalia`, the class the
     rest of their order has. No other order mixes classes.
9. **Province rebuild for countries whose eBird codes were corrected.** Their refreshed eBird species
   lists only take effect when those countries' provinces are rebuilt. This is optional, but best done
   now.
10. **Rebuild the packs and the catalog seed.** Check the gate (`src/pipeline/gate.ts`), then **ask the
    maintainer before publishing**.
    - Publish `pack-index-lite.json` (no `scientificNames`, about 3.9 MB) next to the full
      `pack-index.json` (about 22 MB), lite file first. The app fetches the lite file first and falls
      back to the full one, so on a slow connection the pack list fills in about 5 times sooner. The
      code to write both files is done (`writePackIndexFiles`); decided 2026-11-10 to ship it with this
      republish.
    - Also confirm the republished seed matches the current schema (migration 173 dropped
      `region_species.seasonality`), so first launch no longer relies on the tolerant loader.

Items 1 to 5 change the schema or the pipeline. Any migration needs the maintainer's approval first.
Data refreshes must stay one parameterised, resumable command; never rerun a finished long job.
