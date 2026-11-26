# Marine invertebrate coverage (Belize and everywhere)

Status: investigation 2026-11-25, read-only. B and C built 2026-11-25 (code and tests, scratch
databases only); nothing applied to the `lifer` database yet. A is a separate change in
`apps/api`. Trigger: Belize's Tree of life shows 49 shells and marine molluscs.

## Status: B and C built, waiting for the gallery top-up

Defaults applied (the coordinator's, for the maintainer to confirm):

- **C covers every group of the worldwide table except isopods**, in every country.
- **Marine only.** Bivalves, ceriths and nerites have freshwater and land members, so a species of
  those three clades joins only when OBIS records it as marine or brackish in a cached sea zone
  (`MARINE_ONLY_CLADES` in `add-missing-species.ts`). This drops about 440 bivalves, 170 ceriths
  and 57 nerites worldwide, freshwater ones and some marine ones whose WoRMS name differs from
  iNaturalist's (Belize keeps 38 of 40 bivalves and 6 of 12 nerites).
- **Sea hares, sap-sucking and headshield slugs go in `nudibranchs`.** The visible label stays
  "Nudibranchs"; renaming it "Sea Slugs" is a decision below.
- **B:** OBIS rows land on the country with evidence `obis`; 6c flags an OBIS row iNaturalist
  lacks (where it covers the group) as vagrant, never removes it.

### What was built

- `add-missing-species.ts`: the new clades in `GROUP_CLADES` (`WIDENED_MARINE_CLADES`), the marine
  check, and offline clade ids and family names from the iNaturalist dump. The regular catalog
  stage now adds these clades too.
- `widen-marine-catalog.ts` (`npm run widen-marine-catalog`): the one command for C, stages
  `species, checklists, audit, tiers, photos, vectors` (header comment and SCRIPTS.md).
- `build-country-marine-obis.ts` (`npm run build-country-marine-obis`): option B. Also added to the
  refresh regions stage after the country lists, so a later country rebuild keeps its rows.
- `top-up-galleries.ts --species-file=`; `refresh.ts` exports its tiers and vectors stages
  (vectors can skip its GBIF occurrence-stats step); `dbSnapshot.ts` can dump some tables only.
- Seed builders (`seed-groups.ts`, `build-seed-marine-mollusks.ts`): comments only. Their GBIF
  backbone keys were not widened: a backbone pull of bivalves or sea cucumbers would bring in the
  unphotographed and freshwater tail the plan warns about; the iNaturalist route is the scope.
- Tests: `add-missing-species.test.ts` (clade expansion, isopods out, marine check, visibility
  floor), `sea-zone-marine.test.ts`, `build-country-marine-obis.test.ts` (OBIS areas to countries,
  licences, keep rule), `widen-marine-catalog.test.ts` (top-up guard, stages, species file), and
  `marine-widening.integration.test.ts` on a scratch database (new species once and marked
  iNaturalist-derived, `obis` rows beside other sources and replaced on a rerun, 6c flags an `obis`
  row). The command itself ran end to end on a scratch database (`lifer_e2e_marine`, migrations
  plus a Belize fixture): 3,777 species, Belize 0 to 119 rows, a resume after a failed step, and a
  second run adding nothing.

### Measured (offline, read-only on `lifer`, 2026-11-25)

The species stage needs no iNaturalist call: every candidate taxon's details are already in
`data/inat-taxa-cache.json` (the plan's estimate of 250 calls is not needed). Dry run:
3,777 species to add.

| Clade (bucket)                                       | Species | Belize |
| ---------------------------------------------------- | ------- | ------ |
| Bivalves (shells)                                    | 1,646   | 38     |
| Chitons (shells)                                     | 248     | 7      |
| Ceriths, nerites, true limpets, keyhole limpets      | 568     | 16     |
| Sea hares, sap-sucking, headshield slugs (sea slugs) | 392     | 21     |
| Octocorals, zoanthids, corallimorphs, black corals   | 329     | 15     |
| Sea cucumbers, brittle stars, feather stars          | 406     | 13     |
| Barnacles, mantis shrimp                             | 188     | 9      |

Belize against the plan's prediction: bivalves 38 (40 predicted, 2 lack an OBIS marine record),
chitons 7 (10; 3 under the visibility floor), other snails and slugs 37 (about 41), crustaceans 9
(31 predicted, but those included 12 Decapoda under the floor and isopods), echinoderms 13 (14),
corals 15 (19). Other countries: United States +1,097, Australia +982, Japan +469, Philippines
+434 (all in `data/build/marine-widening-dry-run.tsv`).

B for Belize (OBIS area 22, 10 requests, today's catalog): +88 rows at 5+ records (molluscs 38,
cnidarians 16, echinoderms 5, crustaceans 5, sponges and tunicates 24), +322 with any record.
Belize's OBIS datasets: 84, of which 17 CC0, 31 CC BY, 31 CC BY-NC, 5 other (20% of records
CC BY-NC). 179 countries map to 211 OBIS areas.

### Run sequence (after the top-up has finished)

From `packages/data-pipeline`, against the Docker `lifer` database:

1. `npm run widen-marine-catalog -w data-pipeline` (dry run, a minute, read-only)
2. `npm run widen-marine-catalog -w data-pipeline -- --apply`
3. If it stops: `npm run widen-marine-catalog -w data-pipeline -- --apply --resume`
4. `npm run refresh -w data-pipeline -- --stages=packs,gate`, then the republish's own publish
   command (`--stages=packs,gate,publish --publish --accept-all-drift`).

Step 2 refuses to start while the top-up supervisor or a `top-up-galleries` process runs, or while
`data/logs/top-up-status.json` is anything but `done` (`--ignore-top-up` only if the maintainer
drops the rest of the top-up), or under 20 GB free. It holds `/tmp/lifer-catalog-write.lock` for
the whole run (other catalog writers wait), and first dumps the tables it writes to
`data/backups/lifer-catalog-before-marine-widening-<time>-tables.dump`.

Expected cost:

| Stage       | Time          | Network                                                                          | Disk                                      |
| ----------- | ------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| backup      | 10 to 20 min  | none                                                                             | 0.5 to 1 GB                               |
| species     | a minute      | none                                                                             | none                                      |
| checklists  | about 2 hours | about 1,900 OBIS requests the first time (1 s apart), no iNaturalist             | 100 MB cache                              |
| audit       | 2 min         | none                                                                             | none                                      |
| tiers       | 20 to 40 min  | none                                                                             | none                                      |
| photos      | 1 to 1.5 days | about 7,500 iNaturalist calls at the top-up's pace (9.1 s), plus image downloads | about 1 GB                                |
| vectors     | 2 to 4 hours  | none                                                                             | small                                     |
| packs, gate | 25 min        | none                                                                             | photo store grows by about the new images |

About 2 days in all, almost all of it the paced photo stage; 2 to 3 GB of disk. A Haiku
description rewrite for the new species (about $15 to $25) is a separate, optional pass with the
compose scripts; until then they show iNaturalist's Wikipedia summary.

### Preen

Preen must never take iNaturalist-derived or OBIS checklist data as is. How to tell them apart:

- New species: `gbif_key < 0` and `species_traits.source_attribution = 'iNaturalist taxonomy'`.
- OBIS country rows: `region_species.evidence_source = 'obis'`. A country rebuild relabels an OBIS
  row iNaturalist also confirms as `country`, so exclude `inat`, `country` and `obis` together.
- Sea zone rows of these classes (`sea_zone_species`, `MARINE_EXTRA_CLASSES`) all come from OBIS;
  they carry no per-row source.
- OBIS dataset licences per country: `data/obis-checklist-cache/areas/<id>/datasets.json` and
  `data/review/obis-country-licences.tsv`.

### Not verified

- No run against `lifer`; B's full country fetch (only Belize was fetched).
- The photo stage's real pace (enrich plus top-up per species) and image sizes are estimates.
- OBIS areas combining two catalog countries (Puerto Rico with the US Virgin Islands, Guam with
  the Northern Marianas) and France's overseas regions get no country rows.

### Decisions for the maintainer

1. Rename the "Nudibranchs" group "Sea Slugs" now that sea hares and sap-sucking slugs are in it?
2. Keep the marine check for bivalves, ceriths and nerites (drops some marine species OBIS names
   differently), or list them all, freshwater included?
3. B's threshold: 5+ records (default, Belize +88) or any record (`--any-records`, Belize +322)?

## Short answer

- **Our Belize list already has every in-scope species iNaturalist has.** Of iNaturalist's
  research-grade Belize species that the catalog contains, 100% are listed in Belize (molluscs,
  crustaceans, echinoderms, corals, sponges, nudibranchs, cephalopods). 6c works.
- **The gap is the catalog's scope, not the lists.** The seed builders took narrow clades: corals
  are Scleractinia only, echinoderms only sea stars and urchins, crustaceans only Decapoda,
  "shells" only three snail orders. So no bivalves, chitons, nerites, ceriths, limpets, sea hares,
  sap-sucking slugs, sea fans, soft corals, zoanthids, sea cucumbers, brittle stars, feather stars,
  barnacles or mantis shrimp exist in the catalog at all. Common Sea Fan (267 Belize photos on
  iNaturalist), Lettuce Sea Slug (58), Donkey Dung Sea Cucumber (73) and Spotted Sea Hare (35)
  are missing species, not missing listings.
- **The Tree of life hides the sea zones.** A country's region filter reads only `region_species`.
  The Caribbean Sea zone lists 550 shells for Belize's waters, which the checklist page shows
  when the zone is selected but the Tree of life never does (`apps/api/src/collection/tree.ts`).
- **The 21,847 molluscs on no list are mostly a dead tail.** The mollusc seed pulled every GBIF
  backbone species of the three snail orders: 18,373 of the unlisted have under 20 GBIF records
  worldwide, 330 have a common name, 257 a photo. Micro-snails (Eulimidae, Rissoidae,
  Marginellidae, turrid families), deep-sea taxa, plus freshwater and land snails that
  Littorinimorpha drags in (Hydrobiidae 900, Annulariidae 577). Not worth listing.

## Measured gap: Belize

Sources: Lifer `lifer` DB (read-only, 2026-11-25); iNaturalist research-grade species list for
Belize (place 6953, cached 2026-09-28 in `data/inat-species-counts-cache/6953.json`, no new
call); OBIS checklist for OBIS area 22 "Belize" (6 calls, species rank only).

| Group                             | Lifer Belize        | Caribbean Sea zone | iNat Belize         | iNat, in catalog | iNat, not in catalog     | OBIS Belize (5+ records) |
| --------------------------------- | ------------------- | ------------------ | ------------------- | ---------------- | ------------------------ | ------------------------ |
| Shells (3 snail orders)           | 57                  | 550                | 56                  | 56, all listed   | 0                        |                          |
| Other marine snails, slugs        | 0                   | 0                  | about 41            | 0                | about 41                 |                          |
| Bivalves                          | 0                   | 0                  | 40                  | 0                | 40                       |                          |
| Chitons                           | 0                   | 0                  | 10                  | 0                | 10                       |                          |
| Nudibranchs                       | 10                  | 77                 | 10                  | 10, all listed   | 0                        |                          |
| Cephalopods                       | 6                   | 31                 | 6                   | 6, all listed    | 0                        |                          |
| All molluscs (OBIS)               |                     |                    | 197 (incl. 17 land) |                  |                          | 607 (201)                |
| Crustaceans                       | 84                  | 358                | 115                 | 84, all listed   | 31 (12 Decapoda)         | 330 (87)                 |
| Echinoderms                       | 18                  | 130                | 32                  | 18, all listed   | 14                       | 111 (51)                 |
| Anthozoa (stony corals, anemones) | 33 + 21             | 99 + 93            | 60                  | 41, all listed   | 19 (sea fans, zoanthids) | Cnidaria 176 (70)        |
| Sponges                           | 57 (with tunicates) | 245                | 49                  | 48, all listed   | 1                        | 126 (55)                 |

OBIS Belize species against the catalog (any record count / 5+ records):

| OBIS group    | Listed in Belize | Only on the Caribbean zone | In catalog, on no Belize or zone list | Not in catalog |
| ------------- | ---------------- | -------------------------- | ------------------------------------- | -------------- |
| Mollusca      | 63 / 40          | 166 / 36                   | 42 / 0                                | 336 / 125      |
| Crustacea     | 72 / 36          | 35 / 5                     | 8 / 0                                 | 215 / 46       |
| Echinodermata | 18 / 12          | 18 / 5                     | 3 / 0                                 | 72 / 34        |
| Cnidaria      | 54 / 40          | 35 / 16                    | 5 / 0                                 | 82 / 14        |
| Porifera      | 34 / 18          | 25 / 14                    | 3 / 0                                 | 64 / 23        |

"Not in catalog" mixes out-of-scope groups and WoRMS versus iNaturalist name differences
(OBIS names follow WoRMS; matching here was by name only). The Belize "zone only" molluscs are
real but small reef snails (Leucozonia, Engina, Phrontis, Conus mus); the iconic ones (Queen
Conch, Flamingo Tongue, Crown Cone, Measled Cowrie) are already on Belize's list.

The Tree of life shows 49 of the 57 because it drops 1 vagrant and the obscure-species filter
(under 20 GBIF records, or no photo and under 1,000 records) hides the rest.

Other sources: SeaLifeBase lists 2,370 marine non-fish taxa for Belize, marked incomplete
([SeaLifeBase](https://www.sealifebase.org/country/CountryCheckList.php?c_code=084)). The Florida
Museum calls Belize's molluscs poorly explored, especially small species
([Florida Museum](https://www.floridamuseum.ufl.edu/iz/resources/mexico-central-america-snails/)).
No open published Belize marine mollusc checklist was found.

## Measured gap: worldwide

iNaturalist research-grade species worldwide per missing clade (24 calls, 2026-11-25), and how
many of them sit on the 4,393 cached place lists today (offline; "10+" means 10 or more
research-grade observations in at least one place):

| Clade                                       | iNat species worldwide | On cached place lists, not in catalog | 10+   |
| ------------------------------------------- | ---------------------- | ------------------------------------- | ----- |
| Bivalves                                    | 3,035                  | 2,978                                 | 1,362 |
| Sea hares, sap-sucking and headshield slugs | 560                    | 608                                   | 341   |
| Ceriths                                     | 469                    | 459                                   | 205   |
| Octocorals (sea fans, soft corals)          | 395                    | 342                                   | 148   |
| Chitons                                     | 378                    | 363                                   | 199   |
| Sea cucumbers                               | 312                    | 285                                   | 152   |
| Nerites                                     | 244                    | 234                                   | 77    |
| Brittle and basket stars                    | 240                    | 211                                   | 98    |
| Keyhole limpets, abalone                    | 236                    | 228                                   | 113   |
| True limpets                                | 231                    | 224                                   | 140   |
| Barnacles                                   | 210                    | 200                                   | 101   |
| Zoanthids, corallimorphs, black corals      | 110                    | 105                                   | 65    |
| Mantis shrimp                               | 104                    | 99                                    | 34    |
| Feather stars                               | 81                     | 73                                    | 29    |
| Isopods (mostly land woodlice)              | 1,389                  | 1,337                                 | 445   |
| **Total without isopods**                   | about 6,600            | 6,409                                 | 3,064 |

For comparison, the in-scope orders: Neogastropoda 2,818, Littorinimorpha 1,977, Trochida 536,
Nudibranchia 1,787 species on iNaturalist, against 31,400 catalog shells and 2,143 nudibranchs.

## Root causes

1. **Seed scope** (`src/build/seed-groups.ts`, `build-seed-marine-mollusks.ts`, and the same
   clades in `add-missing-species.ts` `GROUP_CLADES`). The largest cause by far.
2. **Tree of life ignores sea zones** (`collection/tree.ts` `in_region`), while the checklist
   page unions the selected zones. Presentation only, but it is what the maintainer saw.
3. **Thin occurrence data.** GBIF and OBIS hold few records for most invertebrates, so province
   lists built from GBIF (evidence `provinces`) are short; 6c then lists what iNaturalist has.
   This is why Belize has 57, not 200. Thresholds are not the issue: every iNaturalist species
   in scope is listed.
4. **Visibility floor.** `add-missing-species` skips invertebrates with no common name and under
   10 observations: 12 Belize Decapoda (snapping shrimps, hermit crabs) are missing for that.
5. **Name drift between WoRMS (OBIS) and iNaturalist/GBIF names**, a minor share of OBIS's
   "not in catalog".

## Options

### A. Tree of life reads the region's sea zones (app only)

In `tree.ts`, add `sea_zone_species` rows of the region's `nearby_sea_zone_ids` to `in_region`,
as the checklist page does. Belize shells 49 to several hundred (after the obscure filter).

- Cost: about half a day with tests. No data change, no republish.
- Catch: the Caribbean Sea zone covers the whole basin, so Belize would show some species only
  recorded off Venezuela or Cuba. Same as the checklist page today.
- Note: `apps/web/src/pages/explorer/TreeCircle.tsx` and `treeModel.ts` have uncommitted edits
  from another session; `tree.ts` does not.

### B. OBIS country lists for marine invertebrates (country rows)

Reuse `build-sea-zones-marine.ts` with OBIS `areaid` (country areas, type `obis`) instead of the
zone outline, the same keep rule as 6a (5+ records, or 1+ and 3 research-grade iNaturalist photos
nearby), the same basin-stray check, evidence `obis-v3`. Rows go on the country, like the FishBase
decision for marine fish.

- Belize gain (in-catalog species only): molluscs +36 at 5+ records (+208 at any), crustaceans
  +5, echinoderms +5, cnidaria +16, sponges +14.
- Cost: about 1 day to build. About 180 coastal countries x 8 groups, roughly 1,500 OBIS requests
  with paging, about 1 hour at 1 s spacing, 50 to 100 MB of cache (the zone cache is 98 MB).
  Offline and resumable after that. No iNaturalist calls.
- 6c will flag rows iNaturalist lacks as vagrant where iNaturalist covers the group (consistent
  with "iNaturalist decides"), so in well-photographed places most OBIS-only rows end up hidden.
- Small win alone, because the catalog lacks most of what OBIS lists.

### C. Widen the catalog's marine clades (the real fix)

Add the clades in the worldwide table to `GROUP_CLADES` (and the seed builders, for
consistency), then run the existing offline-first chain:

1. `add-missing-species --apply`: adds iNaturalist-observed species from the cached place lists
   (its visibility floor: common name or 10 observations). Expect about 3,000 to 4,500 species
   without isopods. Taxon details for unseen taxa: about 250 iNaturalist calls (30 ids each).
2. `add-new-species-to-checklists --apply` and `build-country-checklists`: province and country
   rows from the same caches, no network. 6c then sees them as normal.
3. `build-sea-zones-marine --offline --apply`: the OBIS zone cache already holds whole phyla, so
   the new species get sea zone rows for free.
4. 6d common names (cached per taxon; new taxa only), 6b, tiers.
5. Reference photos and gallery top-up for the new species: about 7 s each at the paced rate,
   so about 8 to 9 hours of iNaturalist time and about 1 GB of images.
6. Vectors (CLIP and BioCLIP for the new photos, a few hours), descriptions (Haiku compose for
   the new species, about $15 to $25 at the last run's rate; SeaLifeBase filler later), photo
   withheld flags, packs, seed.

- Belize gain: about 150 species iNaturalist already shows there (90 molluscs, 19 anthozoans,
  14 echinoderms, 19 crustaceans), and OBIS confirms many more at zone level.
- Cost: 1 to 2 days of work, about 1.5 days of runtime, mostly iNaturalist-bound.
- Bucket placement, no schema change (`taxon_class` is text): bivalves, chitons, nerites, ceriths,
  limpets into `marine_mollusks` ("Shells & Marine Mollusks"); sea hares, sap-sucking and
  headshield slugs into `nudibranchs` (label would read better as "Sea Slugs") or
  `marine_mollusks`; octocorals, zoanthids, corallimorphs, black corals into `corals`; sea
  cucumbers, brittle stars, feather stars into `echinodermata`; barnacles, mantis shrimp and
  marine isopods into `crustacea`.

### D. SeaLifeBase country lists (official-checklists step)

The rfishbase snapshot has SeaLifeBase (`data/slb`) with FishBase's country table shape, so the
planned `apply-official-checklists` step could take it as a second source. Sparse and lagging;
useful to confirm and un-hide, not to build lists. Only after C, since it lists mostly species
the catalog lacks today.

### Not recommended

- Listing the 21,847 unlisted GBIF-seeded snails: nobody photographs them.
- WoRMS distribution: CC BY 4.0 and clean, but per-species calls (tens of thousands) and sparse
  country detail.
- Lowering 6a's or 6c's thresholds: they are not what limits Belize.

## Licences

| Source                                 | Licence                                                                                 | Lifer | Preen                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| iNaturalist place lists, taxa, names   | API terms; observations mixed CC                                                        | yes   | never                                                              |
| OBIS checklists                        | per dataset CC0, CC BY 4.0 or CC BY-NC 4.0 (already credited in `docs/docs/credits.md`) | yes   | not as is: the checklist endpoint cannot filter by dataset licence |
| SeaLifeBase (rfishbase snapshot)       | CC BY-NC 4.0                                                                            | yes   | never                                                              |
| WoRMS                                  | CC BY 4.0                                                                               | yes   | yes                                                                |
| GBIF backbone (species rows), Wikidata | CC BY 4.0, CC0                                                                          | yes   | yes                                                                |

Species rows added by option C carry `gbif_key = -inat_taxon_id` and are iNaturalist-derived;
Preen builds its own lists from GBIF and must not take them. A Preen-clean version of the same
clades would come from the GBIF backbone plus Wikidata with the builders' visibility signal
(`requireVisibilitySignal`), which Preen already uses for names.

## Tiers

Invertebrate rows get no local tier today; the app shows the worldwide tier where there is one
and "Unrated" otherwise. New rarely photographed species would mostly show Unrated, which fits
the tier philosophy (absolute photography difficulty, no guessing from thin data). No tier change
needed.

## Timing against the held republish

The republish waits for the gallery top-up (about 2 December).

- **A:** independent of the republish; ship with the next app build.
- **B:** can ride along. Run it after the top-up, then 6b and tiers (minutes), then the packs and
  seed that are rebuilt anyway. No new species, so no vectors. Adds about 2 hours.
- **C:** cannot ride along without delaying the republish by about 3 to 5 days: it needs its own
  iNaturalist time (must not compete with the top-up), photos, vectors, descriptions, then
  tiers, packs and seed again. Best as the first item of the next republish, or delay this one.

## Recommendation

1. Do **A** now: it fixes what the maintainer saw for every coastal country at no data cost.
2. Do **C** next, for all marine groups and all countries, as the lead item of the following
   republish (or this one, if a few days' delay is fine). Leave isopods out except marine
   families; leave freshwater bivalves in only if the maintainer wants them under "Shells".
3. Skip **B** for now; revisit once C has landed, when OBIS country rows would confirm far more
   species. Then **D** for un-hiding.

## Decisions needed

1. A: should a country's Tree of life include its sea zones (basin-wide lists) by default?
2. C: go ahead with the wider clades? Which ones (the table's list without isopods is the
   proposal)?
3. C: freshwater bivalves and snails under "Shells & Marine Mollusks", or marine only?
4. C: sea hares and sap-sucking slugs under "Nudibranchs" renamed "Sea Slugs", or under shells?
5. C: this republish (about 3 to 5 days later) or the next one?
6. B later: OBIS country rows on the country, and 6c allowed to flag them vagrant?
