# Add a list from iNaturalist ("spiders of Canada")

Status: research and plan, 2026-11-25. No code written. Measurements below come from 23 read-only requests to api.inaturalist.org on 2026-11-25 (responses kept in the session scratchpad only). The API never refused a request; the one 403 came from www.inaturalist.org's Cloudflare browser check on the "API recommended practices" HTML page, so that page could not be re-read and its numbers below are from the maintainer's brief.

## Short answer

- Make "Add a list" a first-class flow: one box where someone types "spiders of Canada", Lifer turns it into two chips (a taxon and a place) using iNaturalist's own autocomplete, shows a live count and examples, and adds the whole list as a background job. No LLM, no CSV.
- It is cheap for iNaturalist **only if each list is fetched as a list**. `observations/species_counts` returns 500 species a page with name, common name, rank, iconic group, establishment means and default photo. Spiders of Canada is 2 requests; insects of Canada is 31.
- The existing one-at-a-time path must **not** be reused for lists. Today each added species costs about 5 iNaturalist calls plus about 14 seasonality calls for a Canadian addition, so spiders of Canada (795 species) would be roughly 15,000 requests, over the 10,000 a day budget.
- A list becomes a saved object (taxon + place + options) with its own group in the Collection, Remove list and Update list. Its species stay personal: `is_other_taxa` rows and checklist additions that the catalog export, packs and publish gate already exclude.
- Three gaps to close along the way: suggestions ignore hand-added species when a region is picked, the phone never sees them, and the Collection grid is not virtualised for thousands of species. Separately, Lifer's Preen-facing API returns Other Taxa species today (decision 5).

## Measured: what iNaturalist gives us

### Sizes for the example lists

All with `quality_grade=research&verifiable=true` (Research Grade, wild only).

| Query                             | iNat taxon            | iNat place            | Species                                                          | Pages of 500 | Notes                                                                                        |
| --------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| Pinus of BC ("pine trees of BC")  | 47561 genus Pinus     | 7085 British Columbia | 10                                                               | 1            | 4 are introduced (Scots, mountain, black, Japanese white pine), 3 of them with 1 observation |
| Spiders of Canada                 | 47118 order Araneae   | 6712 Canada           | 795                                                              | 2            | Maintainer guessed about 1,500; Research Grade halves it                                     |
| Spiders within 50 km of Vancouver | 47118                 | lat/lng/radius        | 148                                                              | 1            | `lat=&lng=&radius=` works, so "near me" needs no place                                       |
| Plants of BC                      | 47126 kingdom Plantae | 7085                  | 4,455 leaf taxa; 4,423 at species rank; 2,677 with `native=true` | 9            | "native only" removes 40 percent                                                             |
| Insects of Canada                 | 47158 class Insecta   | 6712                  | 15,415                                                           | 31           | Paging past 10,000 works (page 21 at 500 a page answered normally)                           |

Spiders of Canada, first page: 278 of 500 have a common name (56 percent); establishment means native 416, introduced 56, unknown 28; observation counts run from 23,269 (Cross Orbweaver) to 3, median about 20.

### Endpoints and how each phrase resolves

| Need               | Endpoint                                                                                                            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taxon from words   | `GET /v1/taxa/autocomplete?q=`                                                                                      | "spiders" gives order Araneae first; "pine trees" gives genus Pinus; "butterflies" Papilionoidea; "dragonflies" Anisoptera; "bees" Anthophila first but **Domestic Cattle second** (matched term "Bees"). "mushrooms" gives kingdom Fungi (too broad), "trees" gives phylum Tracheophyta (all vascular plants, wrong), "wildflowers" gives nothing. Growth forms are not clades, so starter chips need curated taxa.                                                                                                            |
| Place from words   | `GET /v1/places/autocomplete?q=`                                                                                    | "British Columbia" gives 7085 (admin_level 10) first, then parks; "Canada" gives 6712 (admin_level 0) first, then "Cañada" towns. Prefer results with an `admin_level` and match Lifer's own `regions.inat_place_id` (migration 088, shipped in the catalog seed's `regions` table).                                                                                                                                                                                                                                            |
| The list           | `GET /v1/observations/species_counts?taxon_id=&place_id=&quality_grade=research&verifiable=true&per_page=500&page=` | 500 a page maximum; `total_results` on a `per_page=1` call is a one-request preview count. Also takes `native=true`, `introduced=true`, `hrank`/`lrank`, `lat/lng/radius`. Sorted by count, most observed first.                                                                                                                                                                                                                                                                                                                |
| Smaller payload    | `GET /v2/observations/species_counts?...&fields=count,taxon.id,taxon.name,...`                                      | 500 species: v1 is about 700 KB raw, about 34 KB gzipped; v2 with fields is 210 KB raw, **24 KB gzipped**. Insects of Canada is about 0.75 MB on the wire.                                                                                                                                                                                                                                                                                                                                                                      |
| Fields per species | same                                                                                                                | `id`, `name`, `rank`, `rank_level`, `preferred_common_name`, `iconic_taxon_name`, `ancestor_ids`, `parent_id`, `observations_count` (global), `count` (in this place), `establishment_means` for the place, `default_photo` (`square_url`, `medium_url`, `license_code`, `attribution`), `is_active`, `current_synonymous_taxon_ids`, `extinct`, `wikipedia_url`. Not present: a usable conservation status (null) and Wikipedia summary; those come from `/v1/taxa/{ids}` (up to 30 ids a call) or lazily on the species page. |
| Place checklists   | `/v1/taxa?place_id=`                                                                                                | **Ignored**: it returned all 126 Pinus worldwide. Listed taxa and check lists are not in API v1; they live on the Rails site behind the same Cloudflare check. Observation-based counts are the only usable source, which is also what the catalog's Research Grade step uses (`packages/data-pipeline/src/regions/inatChecklist.ts`).                                                                                                                                                                                          |
| Rate limits        | headers                                                                                                             | No rate-limit headers; `Cache-Control: public, max-age=120` to `300`. The house pacer (`packages/core/src/lib/http.ts`, 1 request a second per host, shared 429 hold) is the right guard.                                                                                                                                                                                                                                                                                                                                       |

### Default photo licences (spiders of Canada, first 500)

| Licence                    | Count |
| -------------------------- | ----- |
| CC BY-NC                   | 255   |
| None (all rights reserved) | 108   |
| CC BY                      | 56    |
| CC BY-NC-SA                | 22    |
| CC BY-NC-ND                | 19    |
| CC BY-SA                   | 18    |
| CC0                        | 17    |
| Public Domain Mark         | 5     |

Open for vectors (`OPEN_VECTOR_LICENSES`: CC0, PD, CC BY) is 78 (16 percent). Publishable under `licensePolicy.ts` (everything but none) is 392 (78 percent).

### Polite use, terms and licences

- Budget from the brief: about 60 requests a minute, 10,000 a day; the maintainer's IP was refused for a night recently. Lifer already sends a descriptive User-Agent (`USER_AGENT` in `http.ts`) and paces iNaturalist to 1 a second. A list costs `ceil(n/500)` requests plus a few batched lookups, so even insects of Canada stays under 60 requests.
- Media: photos come from the `inaturalist-open-data` S3 bucket (open licences) or iNaturalist's static host. The recommended-practices page also asks for restraint on media volume; it could not be re-read today (Cloudflare 403). Treat bulk photo downloads as the expensive part, pace them through the same client, and make them lazy for big lists.
- No API key is needed for reads. Calls go out from the Lifer API process: on the desktop that is the user's own computer and IP, on a server it is the server. No browser or phone calls iNaturalist directly, so one pacer covers everyone and the iNaturalist terms apply to one well-behaved client per install. The request carries only a taxon id, a place id (or a rounded point for "near me") and Lifer's User-Agent: no user, photo or account data.
- Names and lists are facts; photos keep their own CC licence and attribution, which Lifer already stores (`reference_license`, credit). Personal viewing uses the default photo whatever its licence, as iNaturalist shows it (existing rule in `inatClient.ts`). Nothing from a list is ever published (see Isolation).

## How Lifer stores hand-added species today

| Piece              | Today                                                                                                                                                                                                                                             | Source                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Species row        | `species` with `is_other_taxa = true`, `inat_taxon_id`, `inat_iconic_taxon`, `taxon_class` = lowercased iconic name, GBIF key from a GBIF match or `-taxon_id`                                                                                    | `apps/api/src/species/otherTaxaSpecies.ts`                                                                              |
| On a checklist     | `region_species_user_added (user_id, region_id, species_id)`, per user, never `region_species`. Adding to Canada shows on every province unless `inat_region_taxon_data` has a NULL row for that province (migration 144 `user_added_from_above`) | `apps/api/src/regions/checklistAdditions.ts`                                                                            |
| Per species cost   | `/v1/taxa/{id}`, a GBIF match, then `enrichSpecies`: name search, taxon record, gallery photos (6), image downloads, vectors; then `syncInatDistribution`: one histogram call for the region, its parents and up to 60 subdivisions               | `otherTaxaSpecies.ts`, `packages/core/src/species/enrich.ts`, `apps/api/src/species/inatDistribution.ts`                |
| Collection groups  | Grouped by iNat iconic taxon ("Insects", "Arachnids") via `otherTaxaGroupLabel`; tree is `taxon_class > order > family > genus`                                                                                                                   | `apps/web/src/lib/speciesGroups.ts:133`, `packages/shared/src/taxonLabels.ts:62`, `apps/api/src/collection/tree.ts:190` |
| Tiers              | None; the card shows no tier pill and falls back to IUCN status. "Not enough data" is the catalog's `thin_data` reason, not used here. Tier scripts skip `is_other_taxa`                                                                          | migration 089, `SpeciesCard.tsx:207`, `compute-local-tiers.ts`                                                          |
| Opt-in             | `users.any_taxa_search_enabled`, default on since migration 154; Settings > Species & Import                                                                                                                                                      | `SpeciesImportSettings.tsx:85`                                                                                          |
| Bulk               | Paste names into `AddOtherTaxaModal` ("Import a list"), job `other-taxa-bulk` (one per server, not per user)                                                                                                                                      | `otherTaxa.ts:348`                                                                                                      |
| CSVs               | eBird CSV (seen marks), target-list CSV (targets only, up to 20,000 names). Neither adds Other Taxa; the "CSV for plants and insects" users meet is really the paste flow                                                                         | `imports/routes.ts`, `collection/targetLists.ts`                                                                        |
| Remove             | Per species, or per country and iconic group from Downloaded regions; photographed species are kept                                                                                                                                               | `otherTaxa.ts:282`                                                                                                      |
| Restore            | `collection-state.json` saves `otherTaxa` as id and names, restored one live call at a time                                                                                                                                                       | `apps/api/src/lib/collectionState.ts:544`                                                                               |
| Identification     | With a region picked, candidates come from `region_species` only, so hand-added species are **never suggested** there; with no region, from `user_species`                                                                                        | `packages/core/src/species/suggest.ts:435`, `userIndex.ts:121`                                                          |
| Vectors            | Computed on the machine running the API right after enrichment (`persistEnrichment`), for CLIP L/14 (768 dims) and BioCLIP 2 when downloaded; `real[]`, brute-force cosine                                                                        | `persistReference.ts:154`                                                                                               |
| Merges             | `speciesMerges.ts` moves checklist additions for catalog merges; iNat taxon swaps of Other Taxa are never re-checked                                                                                                                              | `speciesMerges.ts:41`                                                                                                   |
| Sensitive          | From IUCN VU/EN/CR or the eBird list; nothing iNat-specific                                                                                                                                                                                       | `settings/metadataSettings.ts:133`                                                                                      |
| Phone              | Checklist sync reads `region_species` with `NOT s.is_other_taxa`; nothing syncs additions                                                                                                                                                         | `apps/api/src/sync/phone.ts:234`                                                                                        |
| Desktop and server | Sync covers captures and species marks; checklist additions are not in it                                                                                                                                                                         | `docs/plans/desktop-server-sync.md`                                                                                     |
| Isolation          | Excluded from the catalog seed (`catalogSeedExport.ts:49`), packs, open data, and `gate.ts:155` fails a publish that leaks one                                                                                                                    | as listed                                                                                                               |

## The design

### One box: "Add a list"

Where: the Collection's existing Add menu gets **Add a list from iNaturalist** beside "Add a species"; the command palette gets it too; InvertebrateHint on the import review offers "Add all spiders of British Columbia" when the row's group and region are known. It opens the shared Modal at `md` (rule M10) with:

1. **One search field**, placeholder from the current region (rule W10): "What do you want to add? e.g. spiders of British Columbia".
2. **Parsing, no LLM.** Split on the last `of`, `in`, `near`, `around` or `from`. Left side goes to taxa autocomplete, right side to Lifer's own region search first (offline, instant, already knows "BC"), then iNaturalist places autocomplete. "near me" or "near here" becomes a point and radius (default 50 km) from the current region's centre, or the device location where the platform gives it. With no place words, the place is the region the Collection is showing (rule D1). Common plurals are stripped before autocomplete only when the plain query returns nothing.
3. **Two chips: taxon and place.** Each chip shows the pick ("Spiders, order Araneae", "Canada") and opens a picker listing the other autocomplete results with rank and a thumbnail, so "Bees" can be corrected away from Domestic Cattle. Lifer prefers results above species rank for the taxon chip and results with an `admin_level` (or a Lifer region) for the place chip.
4. **Live preview.** One `per_page=1` call gives the count; the first 6 species (one more call, cached) give examples: "795 species, e.g. Cross Orbweaver, Zebra Jumping Spider, Goldenrod Crab Spider". Under it, one line of options: **Native only** (shown when the place has establishment data), and later **Include rarely seen** (species with fewer than N records).
5. **Size line.** Under 1,000: nothing extra. 1,000 to 5,000: "Large list. Photos fill in over about 25 minutes." Over 5,000: the add button is disabled (rule A4 still keeps it visible) and narrowing chips appear: "Narrow to: Beetles 4,1xx, Butterflies and moths 3,9xx, Flies ..." from the taxon's children (one `per_page=1` count each, top 8 by `observations_count`).
6. **One button:** "Add 795 species to Canada". The modal closes at once (rule F2); a background job runs with progress where the list lives and a toast on finish with **Undo** (rule F7).

Starter chips under the field (one tap fills both chips, place from the current region): Butterflies (Papilionoidea 47224), Moths and butterflies (Lepidoptera 47157), Dragonflies and damselflies (Odonata 47792), Bees (Anthophila 630955), Spiders (Araneae 47118), Mushrooms and other fungi (Agaricomycetes 50814), Conifers (Pinophyta) and Flowering plants (Magnoliopsida plus Liliopsida, shown as "Wildflowers and other flowering plants"). "Trees" is deliberately not a chip: no clade means tree, and a chip that adds grasses would be a disappointing feature. Curated ids live in one shared file with tests that assert each still resolves.

The paste flow stays as the advanced path, renamed **Import a list from a file or text** under the same Add menu, for people with their own checklist.

### Where a list shows up

- **Collection.** Each list is a group with its own header: "Spiders of Canada, 795" with a menu (Update list, Hide group, Remove list). A species in two lists goes into the smaller list's group, so counts never double. Hide uses the existing group collapse and is remembered (rule N3).
- **Settings > Species & Import > Your lists** (replaces the country and iconic-group rows of "Downloaded regions" for list-added species): name, place, count, photo space, last updated, Update and Remove.
- **Import review and species picker.** List species are ordinary species on that region's checklist, so the picker finds them and the review matches names against them with no change. Suggestions need the fix in WP-5.
- **Species page.** Like any Other Taxa species: photo, IUCN status if known, seasonality fetched on first open for that place (one call), and "On your list Spiders of Canada".

### Removing and undoing

- **Remove list** takes off every species the list alone put there; species you photographed, marked, targeted or added by hand stay (the existing `removeOtherTaxaForUser` rule). Toast: "Removed Spiders of Canada. 12 photographed species stay." with Undo, which re-adds from the stored member list without calling iNaturalist.
- **Undo after adding** is the same as Remove list.

## Data flow and architecture

```
Web, desktop or server UI
  -> Lifer API  POST /species-lists/preview  (taxon id, place id or point, options)
       -> iNaturalist via httpFetch: species_counts per_page=1 and per_page=6, cached 7 days
  -> Lifer API  POST /species-lists          (same body, name)
       -> job queue "species-lists" (one list at a time per install, others "Waiting")
            1. Fetch every page (v2 with fields, gzip), cached 7 days, all or nothing
            2. Roll infraspecific taxa up to their species; drop hybrids and leaves above species
            3. Match existing rows: inat_taxon_id, then exact scientific name; reuse catalog rows
            4. Insert new species rows in batches (synthetic gbif_key -taxon_id, no per-species call)
            5. Family and order names: /v1/taxa/{ids} for the distinct ancestor ids, 30 a call
            6. Write list members and checklist additions in one transaction per 500
            7. Presence per province: species_counts for the same taxon per child place
            8. Photos and vectors: one default photo per species, then vectors (WP-5)
```

- **Requests per list:** pages + about 3 ancestor calls + child-place counts. Spiders of Canada about 30 (13 provinces and territories, most one page); insects of Canada about 31 + 3 + 13 x up to 15 pages. All paced at 1 a second through the shared client, so a 429 holds every caller.
- **Never per species at add time.** No `resolveOrCreateOtherTaxaSpecies`, no GBIF match, no `syncInatDistribution`. Seasonality, the description and the 6-photo gallery stay lazy on the species page (existing behaviour of `enrichSpecies` when a page opens).
- **Province presence for nearly free.** Step 7 writes `inat_region_taxon_data` rows with `weekly_frequency = NULL` for species absent from a province, which is exactly what `user_added_from_above` already reads to keep "Spiders of Canada" off British Columbia's view for species never recorded there. Without it, every Canadian spider shows in every province.
- **Caching:** the existing `inat_response_cache` table (URL keyed, `maxAgeMs`) with a 7 day age for list pages and previews. About 210 KB of text a page, so insects of Canada is about 6.5 MB of cache; old entries are pruned with the table's existing cleanup.
- **Update list:** refetches pages (ignoring the cache), adds new species, marks species no longer returned as "not seen recently" rather than removing them (removing silently would fight the user), and checks ids missing from the new result with `/v1/taxa/{ids}` for `is_active` and `current_synonymous_taxon_ids` to follow taxon swaps.
- **Offline:** the preview says "You're offline. Adding a list needs a connection." with the field still usable for picking from Lifer's own regions. A list added while the connection drops stays as "Waiting for a connection" and the job resumes (rule S9, offline-first: installed lists keep showing). Page fetches are all or nothing so a half list is never saved as whole.
- **Multi-user server:** the job is a queue keyed by list, not the single shared `createJob` slot the paste import uses, so two people don't refuse each other.

### Storage

New tables (one migration, spec'd so pre-approved under the house rule):

```
species_lists        id, user_id, name, inat_taxon_id, taxon_name, taxon_rank,
                     place_kind ('place' | 'point'), inat_place_id, lat, lng, radius_km,
                     region_id (the Lifer region it is added to), native_only,
                     species_count, status ('waiting' | 'adding' | 'ready' | 'failed'),
                     created_at, refreshed_at, suggestions_enabled, updated_at
species_list_members list_id, species_id, inat_count, establishment_means, last_seen_at
                     PRIMARY KEY (list_id, species_id)
region_species_user_added  + via_list boolean NOT NULL DEFAULT false
```

- A hand addition sets `via_list = false` and wins; removing a list deletes only `via_list` rows that no other list for that region still holds.
- Cost: a member row plus an addition row is under 100 bytes; a species row about 1 KB with names; photos about 55 KB each (one medium iNat image, about 500 px, stored as the display and 400 px thumb WebP pair); vectors 3 KB per model. Spiders of Canada: about 1 MB of rows, 45 MB of photos, 5 MB of vectors. Insects of Canada would be about 15 MB of rows and 850 MB of photos, which is why big lists fetch photos lazily (WP-5).

### Isolation from packs, republish and Preen

- List species are `is_other_taxa` rows or catalog rows reused as checklist additions. Both are already excluded from the catalog seed, packs, open data, and the publish gate fails on a leak. **Nothing writes `region_species`**, so `evidence_source` is untouched and no new value such as `inat_user_list` or a `listed_by` column is needed: the isolation is structural, not a flag someone has to remember. WP-1 adds one test asserting a list never creates a `region_species` row and one asserting the seed export of a database with lists equals one without.
- Preen: list additions create no `user_species` row until the user marks or photographs a species, so the Preen-facing `/api/userdata/v1/species` only ever sees the user's own species. But that endpoint (`apps/api/src/userdata/routes.ts:80`) and `imports/v1/species-lookup` (`imports/folderRoutes.ts:115`) do not filter `is_other_taxa` today. See decision 5.

### Tiers: none

Recommendation: no tier for list species; keep the IUCN fallback the card already uses, and say "Not enough data" in the tier details for honesty (rule S5).

Why: the house rule is that a tier is absolute photography difficulty. iNaturalist Research Grade counts measure how often people photograph and identify something, which for insects and plants is dominated by size, colour and how identifiable it is from a photo: a common but drab fly has few RG records because nobody can confirm it, not because it is hard to find. The catalog's tiers normalise records against observing effort per group in each region (migration 115, `compute-local-tiers.ts`); a list has no effort baseline, so any tier from its counts would be rank-based in disguise. The count is still stored per member (`inat_count`), so "Most observed on iNaturalist" can be a sort option, which is an honest fact rather than a judgement.

## Size limits and edge cases

| Case                                           | Handling                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Over 5,000 species                             | Add disabled with narrowing chips; the maintainer can raise the cap later once WP-6 lands. 5,000 matches the P3 fixture budget in `ux-rules.md`.                                                                                                                                                                                                                                            |
| 1,000 to 5,000                                 | Allowed with the size line; Collection group starts collapsed with its count and a search-first hint ("Search 4,423 plants").                                                                                                                                                                                                                                                               |
| Duplicates with the catalog                    | Match by `inat_taxon_id` on catalog rows first, then exact scientific name; reuse the catalog row as a checklist addition. 228 iNat ids are shared by more than one catalog species (`shared-inat-taxa-report.md`): skip those ambiguous matches and use the Other Taxa row instead. The default catalog has no Insecta or Arachnida, so overlaps are rare (some molluscs and crustaceans). |
| Already added by hand                          | Found by `inat_taxon_id`; the addition stays hand-made (`via_list = false`).                                                                                                                                                                                                                                                                                                                |
| Two lists overlap                              | One species row, two member rows; grouped under the smaller list.                                                                                                                                                                                                                                                                                                                           |
| Subspecies, varieties, hybrids                 | Roll infraspecific taxa up to their species via `ancestor_ids`; drop `hybrid` and leaves above species rank (genus-only records). Plants of BC goes from 4,455 to about 4,423.                                                                                                                                                                                                              |
| Cultivars and garden plants                    | Research Grade already excludes captive and cultivated observations; "Native only" covers escapes (4 of BC's 10 pines are introduced).                                                                                                                                                                                                                                                      |
| Introduced or invasive                         | Store `establishment_means` per member and feed the Collection's existing Introduced filter for list species (WP-4).                                                                                                                                                                                                                                                                        |
| Taxonomy changes                               | Store the iNat taxon id; Update list follows swaps through `current_synonymous_taxon_ids`, moving photos and marks with the existing merge mechanics. Names refresh on update.                                                                                                                                                                                                              |
| No common name (44 percent of spiders)         | Show the scientific name as the title, as Other Taxa do today.                                                                                                                                                                                                                                                                                                                              |
| Sensitive species                              | Same IUCN rule as today once status is known (lazy per species page or the batched `/v1/taxa` call). iNaturalist obscures coordinates, not membership, so a list reveals nothing new.                                                                                                                                                                                                       |
| Place Lifer has no region for ("Stanley Park") | Attach to the smallest Lifer region containing the place's centre, and name the list after the real place.                                                                                                                                                                                                                                                                                  |
| Lists from a point ("near me")                 | Stored as a point and radius, rounded to 0.1 degree before it leaves the machine.                                                                                                                                                                                                                                                                                                           |

## Identification

- **Fix first:** `suggest.ts:435` reads candidates from `region_species` only. Add the user's checklist additions (with `user_added_from_above`) for lists with suggestions on, or no list species is ever suggested however good its vector.
- **Photos:** one default photo per species, through the shared paced client. Open licences are preferred where the gallery call is made later; for the single reference photo the existing personal-use rule applies (any licence, credit kept), since none of it is published. Vectors computed from a non-open photo stay local like every personal vector today.
- **Time on the user's machine:** download at the shared 1 a second pace, about 13 minutes for 795 spiders; one reference embedding per model is a fraction of the 1.2 to 1.6 seconds per photo measured for user photos with crops (`docs/plans/assets/matching-quality`), so vectors keep up with downloads. Spiders of Canada is ready in about 15 minutes; plants of BC about 75 minutes. Runs as the background job, cancellable, resumes after a restart.
- **Per-list switch:** suggestions on by default for lists up to 2,000 species and off above (thousands of look-alike insects with one photo each crowd out good matches and slow brute-force cosine). The switch lives on the list's menu. Lists with suggestions off fetch photos lazily when a card scrolls into view.

## Scope test

- Fits Lifer's goal: yes, it turns the "everything else" half of a photographer's archive into a checklist without a spreadsheet.
- Does iNaturalist do it better? iNaturalist shows these lists, but cannot tell you which of them you have photographed in your own archive. Lifer's value is the overlap with the user's photos, so this passes.
- Not a disappointing feature: the honest version drops "Trees", caps size, and shows only Research Grade species.

## Phased delivery

Models follow the house split: Opus 5.5 builds and reviews data, migrations, jobs, sync and engine work; Sonnet 5.5 builds well-specified UI and copy.

### Phase 1, MVP: chips, preview, add in the background, remove

#### WP-1 Lists schema and isolation tests

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Scope:** in: migration for `species_lists`, `species_list_members`, `region_species_user_added.via_list`; the collection-version trigger on both tables. Out: phone and desktop-server sync.
- **Files:** `packages/data-pipeline/migrations/1xx_species_lists.sql`, `apps/api/src/regions/checklistAdditions.ts` (hand adds set `via_list = false`).
- **Size:** S. **Migration:** yes.
- **Tests:** seed export unchanged with lists present; no `region_species` rows written; `gate.ts` still passes.
- **Risks:** `via_list` default on existing rows must be false.

#### WP-2 iNaturalist list client and job

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Scope:** in: preview (count and 6 examples), full fetch with v2 fields and gzip, all-or-nothing paging, infraspecific roll-up, catalog matching, batched inserts with synthetic GBIF keys, ancestor names in batches of 30, province presence rows, job queue per install with progress, cancel and resume. Out: photos and vectors (WP-5), update (WP-4).
- **Files:** `apps/api/src/species/speciesLists.ts` (new), `apps/api/src/species/speciesListsInat.ts` (new), `apps/api/src/lib/job.ts` (a queue variant if the single slot can't take it), `packages/core/src/lib/http.ts` (no change expected).
- **API:** `POST /species-lists/preview`, `POST /species-lists`, `GET /species-lists`, `GET /species-lists/status`, `DELETE /species-lists/:id` (with Undo data in the reply), regenerated `openapi.gen.json` and `schema.gen.ts`.
- **Size:** L.
- **Tests:** recorded fixtures for spiders of Canada (2 pages), Pinus of BC, a page with a subspecies and a hybrid; a mid-fetch failure leaves nothing; a second user's list waits, not 409; request count assertion (spiders of Canada at most 35 iNaturalist calls).
- **Risks:** v2 `fields` syntax changes; fall back to v1 with the same parser.

#### WP-3 Add a list modal and Collection groups

- **Model:** Sonnet 5.5. **Review:** Opus 5.5 (it writes user data).
- **Scope:** in: the modal (field, parser, taxon and place chips with pickers, preview, size line, narrowing chips, starter chips), entry points (Collection Add menu, command palette, InvertebrateHint), list groups in the Collection with Hide and Remove, toast with Undo, Your lists in Settings, rename "Import a list" to "Import a list from a file or text". Out: per-list suggestions switch.
- **Files:** `apps/web/src/components/AddSpeciesListModal.tsx` (new), `apps/web/src/lib/listPhrase.ts` (parser, new), `apps/web/src/lib/starterLists.ts` (curated ids, new), `apps/web/src/lib/speciesGroups.ts`, `apps/web/src/components/GroupedSpeciesGrid.tsx`, `apps/web/src/components/importReview/InvertebrateHint.tsx`, `apps/web/src/pages/settings/SpeciesImportSettings.tsx`, `apps/web/src/locales/en.json`, `apps/web/src/i18n/en.context.json`, `docs/docs/guides/collection-and-checklists.md`.
- **Size:** L.
- **Tests:** parser unit tests ("pine trees of BC", "spiders in Canada", "butterflies near me", "moths", "bees of ontario"); starter ids still resolve (fixture); modal closes on add; Undo restores. HIG screenshot review per house rule, light and dark, 390 and 2560 px, with a 5,000-species list.
- **Risks:** a chip picker that feels like a form; keep it to two chips and one button.

### Phase 2: make lists feel native

#### WP-4 Update list, taxon swaps, introduced flag, offline queue

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Scope:** Update list (manual and every 90 days in the background when online), swap handling via `current_synonymous_taxon_ids` and the merge mechanics, `establishment_means` into the Introduced filter, "Waiting for a connection" status, `collection-state.json` stores list definitions so a restore refetches a list in a few calls instead of one call per species.
- **Files:** `speciesLists.ts`, `apps/api/src/lib/collectionState.ts`, collection query introduced columns.
- **Size:** M. **Migration:** no.
- **Tests:** swap fixture moves a photo to the new taxon; restore of a 795-species list makes at most 35 calls.

#### WP-5 Photos, vectors and suggestions per list

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Scope:** one reference photo per species in the job (lists up to 2,000) or lazily on card view (above), vectors through `persistReference.ts`, `suggestions_enabled` per list, suggestion candidates include checklist additions for enabled lists.
- **Files:** `packages/core/src/species/suggest.ts`, `packages/core/src/species/persistReference.ts`, `speciesLists.ts`, list menu in the web app.
- **Size:** M. **Migration:** no (column from WP-1).
- **Tests:** a list species with a vector is suggested for a matching photo with a region picked; a disabled list's species are not; brute-force timing with 5,000 extra candidates stays within budget.
- **Risks:** suggestion quality drops with thousands of single-photo candidates; that is why the switch exists and defaults off above 2,000.

#### WP-6 Collection holds thousands

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Scope:** virtualise `GroupedSpeciesGrid` (no virtualisation exists today), collapsed big groups, search-first inside a group. Benefits every big region, not only lists.
- **Size:** M to L.
- **Tests:** P3 fixture (5,000 species) sort, group and scroll within budget.

### Phase 3: everywhere

#### WP-7 Phone and desktop-server sync

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Scope:** sync list definitions and members through `/sync` (lists are small; the server or desktop refetches nothing), and include checklist additions and Other Taxa species in the phone checklist (`sync/phone.ts:234` excludes them today). The phone shows lists read-only at first; adding from the phone asks its Lifer server, never iNaturalist directly.
- **Size:** L. **Migration:** `updated_at` and tombstones on the list tables, following `desktop-server-sync.md`.

#### WP-8 Suggested lists

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Scope:** after an import review with several unmatched insects or plants in one region, offer the matching starter list once ("Add Butterflies of Ontario? 165 species"), hideable.
- **Size:** S.

## Decisions for the maintainer

1. **Size cap.** Recommend 5,000 species per list for 1.0, with narrowing chips above it, raised after WP-6 proves the grid. Alternative: no cap, with a warning.
2. **Native only by default?** Recommend off by default but shown, since photographers do photograph introduced species (most of BC's Scots pines and Canada's Cross Orbweavers), and their Introduced tag makes them visible.
3. **Tiers.** Recommend none (IUCN fallback plus "Not enough data"), with "Most observed on iNaturalist" as a sort. Alternative: a coarse tier from counts, which this plan argues breaks the absolute-difficulty rule.
4. **Suggestions for big lists.** Recommend on up to 2,000 species and off above, switchable per list. Alternative: always on, accepting slower and noisier suggestions for insect lists.
5. **Preen boundary.** Lists never create `user_species` rows, so nothing reaches Preen until the user marks or photographs a species. But `/api/userdata/v1/species` and `/api/imports/v1/species-lookup` already return Other Taxa species (scientific names, and the lookup may carry iNaturalist common names). Recommend filtering `is_other_taxa` out of both Preen-facing endpoints, or returning only the scientific name for them, before 1.0, so no iNaturalist-derived name or photo ever crosses to the commercial side. This is independent of the list feature and worth a small fix now.

## Decisions (2026-11-26)

1. Size: the 5,000 species cap per request stays, but nothing is left behind. A request larger than the cap is added in resumable batches in the background over time (the list keeps a cursor, shows "1,000 of 15,415 added", and finishes on its own or on Continue), and the whole list syncs to other devices as it fills. Narrowing chips (for example Beetles) stay as the fast path.
2. Native only: the user's control. A switch in the Add a list dialog, on the preview ("Native species only"), remembered per list.
3. Tiers: none for list species.
4. Identification: every added species that has reference photos gets its image vectors computed in the app, in the background and in batches, from its gallery (reference) images, so Lifer can suggest it like any other species. No per-list size limit; it runs at low priority and can be paused.
5. Preen: Lifer makes the list definitions known (taxon and place ids, names) so Preen can build its own commercial-free lists from sources it may use. Preen never receives iNaturalist-derived species data. The two Lifer endpoints that return hand-added species get a filter fix now.
