# Next catalog republish: checklist

## Status (checked 2026-11-23 against the Docker `lifer` database)

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
- **6b. Catalog audit.** Dry run: 0 decisions in every pass, nothing left to apply.

Still to do:

- **2, 3 and alias lists (5b).** The `places` stage needs Natural Earth
  `ne_10m_populated_places_simple.geojson` in `data/raw/natural-earth/`; it isn't there. Every region
  has no example city and no aliases yet.
- **6, v2 compose run.** 413 of 1,797 Haiku batches finished (stopped on rate limits). Finishing it
  needs the API. Reload with `final/summary_notes_v2.json` only after it finishes and is reviewed.
- **6, filler pass** for thin reptiles and fish (Reptile Database, FishBase): needs web sources and
  licence checks.
- **5b, 5c, 5d, 5f, 5h.** Not done. Aruba and Puerto Rico still have two rows each; BC still lists
  Cockatiel, Black Swan and others; _Branta leucopis_ sits beside _Branta leucopsis_; fossil ducks
  remain; 2,081 birds have no common name. 5f needs the open lists; 5h needs a rule for extinct taxa.
- **Gallery top-up** needs iNaturalist downloads.
- **7, 8, 9, 10** wait for the items above (a regions run means rerunning 6b, then tiers).

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
3. **Most populous province per country**, from the same source.
4. **Index** `regions(parent_id, home_country_id)`.
5. **Hook the web placeholders** (region search and place name inputs) to the new fields.
5b. **Countries within countries.**
   - Give constituent countries, realms, SARs, territories, overseas regions and crown dependencies a
     consistent model: each is reachable on its own and under its sovereign, with one naming rule and
     consistent downloads.
   - Fix the duplicate rows (Aruba and Puerto Rico each appear twice).
   - Add region alias lists (Britain, Holland, USA, Burma, Czech Republic, Türkiye...) for search.
   - The app side is the region search backlog item.
5c. **Stale GBIF keys.** About 1.8% of checklist species carry GBIF taxon keys that no longer match
   GBIF's current backbone (e.g. "Pipra europaea" in the UK, "Psittacus moluccanus" in Queensland).
   Re-resolve them during the name-drift work.
5d. **Escapees the exotics pass missed.** British Columbia still lists Cockatiel, Black Swan, Egyptian
   Goose, Ruddy Shelduck, Demoiselle Crane, White-rumped Munia, White-cheeked Starling and
   White-cheeked Pintail. They have 1 to 6 old records, so eBird's 30-day exotic windows never saw
   them. Check species with known captive or pet origins that have a handful of records outside their
   native and established range, across all regions, and remove them or flag them for review.
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
     example, Lesser Sand-Plover has 6 photos under iNaturalist's *Anarhynchus mongolus*, but the
     catalog still says *Charadrius mongolus*, so it reads as missing. `species.inat_taxon_id` already
     exists; join the provenance file's `inat_taxon_id` column on it.
   - **Find out why some very common species got nothing.** Savannah Sparrow (*Passerculus
     sandwichensis*) has no photos at all, which points to a gap in the collection step itself (the
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
   - **Fossil and extinct-only taxa.** The bird list includes fossil ducks with no common name (*Nettion
     ogallalae*, *Querquedula integra*, *Shiriyanetta hasegawai*, *Fuligula sepulta*, *Geochen rhuax*,
     *Miotadorna sanctibathansi* and others). Drop fossil taxa. Keep recently extinct species only if
     there's a reason to (decide the rule).
   - **Species with no common name.** 2,082 bird rows have an empty `common_name`. Fill them from
     iNaturalist or Wikipedia (via iNaturalist's `wikipedia_summary`), or drop them where they're
     fossils.
   - **Outdated scientific names.** Bring scientific names in line with current taxonomy, with the old
     names kept as synonyms for search (for example *Charadrius mongolus* to *Anarhynchus mongolus*).
     This overlaps 5c and the name-drift work.
   - **Typos.** Barnacle Goose is stored as *Branta leucopis*; the correct name is *Branta leucopsis*.
     Scan for near-miss names against GBIF's or iNaturalist's backbone and fix them.
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
6b. **Catalog audit fixes** (from `docs/plans/belize-data-audit.md`; applied to `lifer` on 2026-11-19
   and, with the new passes, on 2026-11-20).
   - Command, from the repo root: `npm run fix-catalog-audit -w data-pipeline` (dry run), then the same
     with `-- --apply`. One transaction of about a minute and a half, no downloads: zone outlines come
     from `data/raw`, eBird region lists from `data/ebird-spplist-cache`, iNaturalist names from
     `data/open-vectors/inat/taxa.csv.gz` (each pass that needs a missing file is skipped with a
     warning). `--passes=inat-ids,names,ranges,additions,unlisted-birds,flags,resident-mammals,classes,sea-basins,shared-names`
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
   - Second run (2026-11-20): 26,311 iNaturalist ids linked, *Dasyatis hastata* merged into Roughtail
     Stingray, the 10 deep-sea rows off (now reviewed range exclusions), 6 Belize freshwater fish
     added, 8,010 thin bird listings off that eBird never had there, 3,068 bat and rodent listings no
     longer flagged vagrant (2,913, then 155 more once the rule followed chains of neighbours). The ids reach the gallery top-up (it selects species with an id), so run
     `top-up-galleries` and then `backfill-photo-withheld` before the packs and seed.
7. **Re-run the rarity tiers stage.** Tiers are older than the regions run above, and the publish gate
   will notice.
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
