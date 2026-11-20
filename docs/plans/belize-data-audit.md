# Belize data audit (2026-11-19)

Read-only audit of what Lifer shows for Belize: why some species have no photo or description,
whether the species list is right, and a closer look at rays and sharks. Nothing in the catalog
was changed, nothing was published and no new GBIF data was fetched.

Sources used: the `lifer` dev database (read-only queries), the published catalog seed (local copy
in `packages/data-pipeline/data/build/catalog-seed/`, same SHA-256 as the live `catalog-latest`
release, published 2026-10-08), the published photo store index (`photos-latest`, 2026-10-08), the
local Belize pack builds (2026-10-20, not published), and outside reference lists (end of this doc).

## 1. Summary

- **Why the two stingrays have no photo in the app.** The app runs on the catalog published on
  2026-10-08. In that publish, Yellow Stingray (*Urobatis jamaicensis*) had a description but no
  photo, and Round Stingray (*Urolophus halleri*) had neither. The dev database has gained both
  since (the photo most likely from a gallery top-up, which promotes a main photo when one is
  missing). Neither was marked "withheld", so the app never tries to fetch one itself. **Fix: the
  next republish.** 52 species in the Belize view have gained a photo in the dev database since
  the publish, and 7 have gained a description.
- **What is still missing in the dev database.** On the Belize land list (1,560 species) 70 have no
  main photo: 53 are "withheld" (their photos carry licences Lifer may not redistribute, so installs fetch
  one for personal viewing), 11 have an iNaturalist taxon but no open-licence photo was found, and 6 have
  no iNaturalist taxon at all. In the Caribbean Sea additions (1,876 species) 663 have no photo,
  most of them deep-sea fish that the default "hide obscure species" setting already hides.
- **The list is mostly right on land, too long at sea.** Birds, mammals, reptiles and amphibians
  match independent lists closely; the differences are mostly name versions, a few escapes, and a
  handful of single-record oddities. Fish are where it goes wrong: Belize shows its own 385 fish
  plus every species of the whole Caribbean Sea zone (1,876 more), and that zone list contains
  **about 175 species from other oceans** (Pacific, Indo-Pacific), 138 of them visible by default.
- **Root cause of the Pacific species (confirmed).** The sea zone builder lets a rarely recorded
  species stay when a "neighbouring" zone has it well recorded. The neighbour test treats zones
  whose outlines come within about 0.5 degrees as neighbours, and across the Isthmus of Panama the
  Caribbean Sea and the **Panamanian part of the North Pacific Ocean** are that close. So Pacific
  species with 1 to 5 stray Caribbean records are kept. Round Stingray is exactly this: 1 Caribbean
  record, 12 in Panama's Pacific waters, 38,593 off California.
- **Name problems.** *Narcine brasiliensis* is labelled "Lesser Electric Ray" (it is the Brazilian
  Electric Ray of the south-west Atlantic and should not be on a Caribbean list). *Urobatis sloani*
  is labelled "Round Stingray" but is an old synonym of the Yellow Stingray. *Urolophus halleri* is
  an outdated name for the Pacific *Urobatis halleri*. Bull Shark shows as "Hervey Bay Whaler Shark".
  31 common names are shared by two species within the Belize view.

## 2. How the Belize view is built

| Piece | Rows | Notes |
|---|---|---|
| Belize country list (`90e9899d...`) | 1,560 species | The union of the six district lists, plus 6 iNaturalist-only and 3 country-level additions. Country rows carry no local tier (true of every country, by design). |
| "Belize" province row (`a051ce9c...`) | 1,108 species | This is **Belize District** (code BZ-BZ), one of the six districts, not a copy of the country. The duplication is intended; only the shared name is confusing. |
| Caribbean Sea zone | 2,225 species, 1,876 not on the land list | The only sea zone linked to Belize (`nearby_sea_zone_ids`). The region view adds the whole zone list (UNION), see `REGION_VIEW_SPECIES_CTE` in `apps/api/src/regions/checklist.ts`. |
| Gulf of Mexico zone | 1,860 species, 410 not in either of the above | **Not shown for Belize** (not a nearby zone for it). Counted here only because the brief asked. |

Side finding: four of the six districts (Stann Creek, Orange Walk, Cayo, Corozal) have a full
`POLYGON((...))` string in `regions.external_codes` instead of an ISO code like `BZ-SC`. Anything
that looks districts up by code (for example `top-up-galleries --region=`) will not find them.

How photos reach an install: the catalog seed ships `reference_photo` (a remote URL) and
description; packs ship checklists only; the photo files come from the photo store
(`packages/data-pipeline/src/pipeline/photoStore.ts`). A species marked `photo_withheld` gets its
iNaturalist photo fetched in the background by the install (`apps/api/src/species/withheldPhotos.ts`)
once a pack covering it is downloaded and the setting is on. A species with no photo and no
withheld flag gets nothing on the install.

## 3. Photo and description gaps

### 3a. What the app has now (published 2026-10-08) versus the dev database

Counts of species with no main photo. "Blank by default" is what a user sees as an empty tile with
the default "hide obscure species" setting on (that setting hides most photo-less species with
under 1,000 GBIF records, and fish deeper than 60 m).

| Part of the Belize view | Species | No photo, published | Blank by default, published | No photo, dev now | Blank by default, dev now |
|---|---|---|---|---|---|
| Land list | 1,560 | 70 | 42 | 70 | 41 |
| Caribbean Sea additions | 1,876 | 706 | 37 | 663 | 26 |
| Gulf of Mexico extras (not shown for Belize) | 410 | 167 | n/a | 161 | n/a |

The published store index and the published seed agree exactly (every species with a seed photo
has its file in the store), so there is no "path missing in the pack" problem. The local packs of
2026-10-20 have `displayFile: null` for every species, which is by design (photos live in the
store), not a gap.

### 3b. By group (dev database)

| Group | On land list | No photo | No gallery photos | No description | In Caribbean additions | No photo | No description |
|---|---|---|---|---|---|---|---|
| Birds | 613 | 3 | 18 | 3 | 0 | | |
| Mammals | 115 | 5 | 13 | 10 | 0 | | |
| Marine mammals (filed as fish, see 6.6) | 6 | 0 | 0 | 0 | 20 | 0 | 0 |
| Reptiles (lizards, snakes, crocodiles) | 108 | 16 | 74 | 1 | 0 | | |
| Turtles | 14 | 0 | 8 | 0 | 0 | | |
| Amphibians | 39 | 6 | 35 | 0 | 0 | | |
| Bony fish | 367 | 7 | 14 | 77 | 1,717 | 625 | 740 |
| Sharks, rays, chimaeras | 12 | 1 | 1 | 0 | 139 | 38 | 21 |
| Crustaceans | 84 | 13 | 61 | 35 | 0 | | |
| Sponges, tunicates, other | 57 | 10 | 38 | 33 | 0 | | |
| Marine molluscs | 57 | 3 | 38 | 4 | 0 | | |
| Corals | 33 | 2 | 19 | 4 | 0 | | |
| Jellies and anemones | 21 | 0 | 11 | 3 | 0 | | |
| Echinoderms | 18 | 2 | 10 | 3 | 0 | | |
| Nudibranchs | 10 | 1 | 8 | 3 | 0 | | |
| Cephalopods | 6 | 1 | 3 | 0 | 0 | | |
| Insects, arachnids | 0 | | | | | | |

Insects and arachnids are not in the catalog at all (`catalogClasses.ts`), so their absence is by
design, not a Belize gap.

### 3c. Causes, with examples and fixes

| Cause | Land list | Caribbean additions | Examples | Fix | Covered by the running top-up? |
|---|---|---|---|---|---|
| **Published before the photo or text arrived** | 5 photos, 6 descriptions | 47 photos, 1 description | Yellow Stingray (photo), Round Stingray *U. halleri* (photo and text), *Gambusia yucatana*, *Atherinella milleri* | The republish (`refresh --stages=...,packs,gate,publish`) | Already in the dev database |
| **Withheld** (only photos whose licence Lifer cannot redistribute) | 53 | 21 | Tungara Frog, Hourglass Treefrog, Speckled Racer, Cushion Sea Star, Mahogany Goby | Installs fetch these for personal viewing. For the shipped catalog: `top-up-galleries` looks for publishable photos and promotes one to main | Yes, if iNaturalist has a publishable photo. Afterwards rerun `backfill-photo-withheld`, because the top-up promotes a main photo without clearing `photo_withheld` (`persistGalleryPromotingMainIfMissing`) |
| **iNaturalist taxon, but no open-licence photo found** | 11 | 406 | Terciopelo (*Bothrops asper*), Yucatan Whiptail, Elegant Myotis, Belize Anchovy, many deep-sea fish | `top-up-galleries` (looks at research-grade observation photos, not just the taxon photos enrichment used), then `recheck-null-photo-species` | Yes |
| **No iNaturalist taxon id** | 6 | 236 | Royal Gramma (*Gramma hemichrysos*), Whitesaddle Blenny, *Urobatis sloani* | Resolve the taxon (catalog stage of `refresh`, or merge into the accepted species), then enrich | **No**: the top-up only selects species with `inat_taxon_id` |
| **Name drift: photo link removed by the shared-taxon fix** | 5 of the 6 above | 3 | *Kyphosus incisor*, *K. lutescens*, *K. pacificus*, *Sphyraena picudilla*, *Natalus lanatus* (iNaturalist lumps each into another species; `data/review/shared-inat-taxa.tsv` unlinked them on 2026-10-20, so they lost their borrowed photo) | Decide per species: merge into the iNaturalist owner, or drop where the name is misapplied in Belize (the two Pacific *Kyphosus*, see 4) | No |
| **Never enriched** | 0 | 0 | | | |
| **No description** | 176 | 761 | Fish (77 land), crustaceans (35), sponges (33), mammals (10); most deep-sea fish | The description rewrite pipeline and its thin-source ledger (republish item 6) | No (the top-up does photos only) |

### 3d. The running gallery top-up

`/tmp/run-topup.sh` runs `npm run top-up-galleries -w data-pipeline` over the **whole catalog**
(65,230 thin species), class by class in alphabetical order, thinnest first. It has **no Belize
priority** in that wrapper. Since 2026-11-20 the `inat-ids` pass (6.10) gives 198 more Belize-view
species an iNaturalist id, so a restarted top-up can reach them. It is on attempt 7 (the last attempt reached 9,540 of 65,230 and stopped
on a native model error, then waits 30 minutes and restarts). Within the Belize view it can help
the 64 land and 427 Caribbean species that have an iNaturalist taxon but no photo, and the 351
land species with no gallery photos. It cannot help the 242 species with no iNaturalist taxon.

## 4. Is the list right? (by group)

| Group | Lifer Belize | Reference | Agreement | Main differences |
|---|---|---|---|---|
| Birds | 613 | Wikipedia (from Avibase): 624, of which 105 accidental, 4 introduced | 577 matched by name, most of the rest are name versions | 31 accidentals not on Lifer; extras below |
| Mammals | 115 land + 6 marine mammals filed as fish + 20 marine mammals via the sea zone | Wikipedia: 142 | 76 by name; most others are splits and renames (*Pteronotus parnellii* to *P. mesoamericanus*, *Lontra longicaudis* to *L. annectens*, *Tapirus* to *Tapirella*) | A few true omissions, extras below |
| Reptiles and turtles | 122 | iNaturalist research-grade species in Belize: 123 | 117; the 5 to 6 differences are all splits (*Micrurus diastema* vs *M. apiatus*, *Leptophis ahaetulla* vs *L. praestans*, *Kinosternon scorpioides* vs *K. cruentatum*) | Very good |
| Amphibians | 39 | iNaturalist: 39 | 35; differences are splits (*Agalychnis callidryas* vs *A. taylori*, *Lithobates brownorum* vs *L. macroglossa*) | Very good; *Lithobates berlandieri* (0 iNaturalist records in Belize) looks like an old name |
| Fish | 385 land + 1,876 sea zone | FishBase Belize: 676 present | 653 of FishBase's 676 are in the Lifer view (312 on land, 341 via the sea zone) | Recall is good. Precision at sea is the problem (section 4b). FishBase itself is incomplete (it lacks Yellow Stingray, which is common in Belize) |
| Corals, sponges, molluscs, crustaceans and other invertebrates | 33 to 84 per group | Not checked | | No reliable open country list found |

### 4a. Likely false positives on the land list

Each has a reason; confidence noted.

| Species | Shown as | Evidence in Lifer | Why it looks wrong | Confidence |
|---|---|---|---|---|
| *Gallinula sanvicensis* | (no name) | district lists, 2 GBIF records | Misspelling of the Hawaiian gallinule taxon (*sandvicensis*); Belize's bird is Common Gallinule | High |
| *Pycnonotus cafer* | Red-vented Bulbul | 1 iNaturalist record | South Asian bird, an escape | High |
| *Fregata minor* | Great Frigatebird | 1 iNaturalist record, not flagged vagrant | Indo-Pacific; almost certainly a misidentified Magnificent Frigatebird | High |
| *Gallus gallus*, *Anser anser*, *Meleagris gallopavo*, *Numida meleagris*, *Melopsittacus undulatus*, *Myiopsitta monachus*, *Oryctolagus cuniculus*, *Felis catus* | Junglefowl, Graylag, Wild Turkey, Guineafowl, Budgerigar, Monk Parakeet, European Rabbit, Domestic Cat | Several marked introduced; Wild Turkey and Budgerigar are not | Domestic animals or escapes (Belize's wild turkey is the Ocellated Turkey) | High |
| *Thraupis palmarum* | Palm Tanager | 1 iNaturalist record | Range reaches Honduras, not on the Belize list | Medium |
| *Stelgidopteryx ruficollis*, *Polioptila plumbea* | Southern Rough-winged Swallow, Tropical Gnatcatcher | 0 iNaturalist records | Belize birds are the northern species (*S. serripennis*, *P. albiloris*); old or misapplied names | Medium |
| *Saltator coerulescens*, *Formicarius analis* | Grayish Saltator (flagged vagrant), Black-faced Antthrush | 0 records | Old names for *Saltator grandis* and *Formicarius moniliger*, which are already on the list: duplicates | High |
| *Kyphosus lutescens*, *K. pacificus* | Revillagigedo Sea Chub, Pacific Chub | district lists | Eastern Pacific species; iNaturalist lumps both into the Atlantic Bermuda Chub | Medium |
| *Nyctinomops laticaudatus*, *Glossophaga leachii*, *Myotis pilosatibialis*, *Molossus sinaloae* | flagged **vagrant** | 0 iNaturalist records | Resident bats in the region; they are under-recorded, not vagrants | Medium |

### 4b. False positives from the Caribbean Sea zone (the big one)

- **About 175 species** in the Caribbean Sea list are recorded mainly or only in other oceans (no
  Atlantic zone has more than 5 records, and another basin has far more). **138** of them are
  visible with default settings. Most common top zones: Mexican Pacific (48), Gulf of California
  (20), Panamanian Pacific (16), Galapagos (15), Hawaii (14), Colombian Pacific (10), Coral Sea (9).
- **123** of them fit the isthmus mechanism exactly: 5 or fewer Caribbean records, more than 5 in
  the Panamanian Pacific, none above 5 in any Atlantic neighbour. Examples: Round Stingray,
  Longtail Stingray (*Hypanus longus*), King Angelfish (*Holacanthus passer*), Scissortail Chromis,
  Bluefin Trevally, Mexican Hogfish, Peruvian Anchoveta, Panamic Green Moray.
- The rest have 6 or more stray Caribbean records, so the outlier check never looks at them:
  Kuhl's Maskray (*Neotrygon kuhlii*, 8), Southern Eagle Ray (*Myliobatis tenuicaudatus*, New
  Zealand and Australia, 8), Blacktip Reef Shark (*Carcharhinus melanopterus*, 10). These are
  probably aquarium or mis-georeferenced records; I could not open the GBIF records to check.
- The zone also carries **deep-sea fish** (403 Caribbean additions start below 60 m and are hidden by
  default) and species known from very few records anywhere (266 have under 20 GBIF records, also
  hidden by default). Those are real Caribbean species, just not ones a diver or snorkeller will see.

### 4c. Likely omissions

| Group | Missing from the Belize view | Note |
|---|---|---|
| Fish (FishBase present, catalog has the species) | Tropical Gar (*Atractosteus tropicus*), *Dorosoma anale*, *Ictalurus meridionalis*, *Phallichthys fairweatheri*, *Poecilia teresae*, *Carlhubbsia stuarti*, *Thorichthys affinis*, *Profundulus guatemalensis*, *Rhamdia quelen*, *Anchovia landivarensis*, *Tomicodon clarkei*, Devil Firefish (*Pterois miles*), Atlantic Sixgill (*Hexanchus vitulus*, named in the MarAlliance Belize report) | Mostly freshwater fish, which the land list builds from GBIF land records; Lifer has Red Lionfish (*P. volitans*) |
| Birds | 31 accidentals, for example Cory's, Manx and Audubon's Shearwater, Wilson's Storm-Petrel, White-tailed Tropicbird, Black Swift, Dark-billed Cuckoo, Black-legged Kittiwake, Northern Mockingbird | Expected: they have few records. Fine to leave off or add as vagrants |
| Mammals | Northern Naked-tailed Armadillo (*Cabassous centralis*), Eastern Cottontail (*Sylvilagus floridanus*), several bats (*Saccopteryx leptura*, *Eumops* spp., *Phylloderma stenops*, *Trinycteris nicefori*, *Lichonycteris obscura*, *Hylonycteris underwoodi*), a few rodents; Sei and Blue Whale (Bryde's is present as *B. edeni*) | Medium confidence: Wikipedia's list mixes current and historic records and older names. Giant Anteater is extirpated, correctly absent |

## 5. Rays and sharks

### 5a. What Lifer shows for Belize

- **On the land list (12):** Spotted Eagle Ray, Southern Stingray, Longnose Stingray, Chupare
  Stingray, Yellow Stingray, Lesser Electric Ray (*N. bancroftii*), Nurse Shark, Whale Shark,
  Caribbean Reef Shark, Lemon Shark, Bull Shark (labelled "Hervey Bay Whaler Shark"), Shovelbill
  Shark (*Sphyrna alleni*, described in 2024 from Belize; no photo, withheld, iNaturalist-only taxon).
- **Added by the Caribbean Sea zone (139):** includes the real Belize regulars Blacktip Shark,
  Great and Scalloped Hammerhead, Bonnethead, Tiger Shark and Caribbean Sharpnose Shark (these are
  the bulk of Belize shark landings per MarAlliance, yet are only on the list through the zone),
  plus many deep-water catsharks, lanternsharks, skates and chimaeras.

FishBase's Belize table lists 32 sharks and rays; all 32 are in the Lifer view (land or zone).
FishBase's table is itself incomplete for rays (no Yellow Stingray, no electric ray), so it is a
floor, not a full list.

### 5b. Sharks and rays in the Belize view that do not belong

| Species | Lifer name | Records | Problem | Confidence |
|---|---|---|---|---|
| *Urolophus halleri* | Round Stingray | 1 Caribbean | Eastern Pacific only (California to Panama). Outdated name: current name *Urobatis halleri* | High |
| *Urobatis sloani* | Round Stingray | 1 Caribbean | Synonym of *Urobatis jamaicensis* per Catalog of Fishes (Raja sloani is the genus's type, now treated as the Yellow Stingray). Wrong common name, no photo, no text, no iNaturalist taxon | High |
| *Narcine brasiliensis* | Lesser Electric Ray | 62 Caribbean, 106 Gulf | Brazilian Electric Ray, south-west Atlantic (Brazil to Argentina). Caribbean records are old identifications from before the 1999 split | High |
| *Hypanus longus* | Longtail Stingray | 1 | Eastern Pacific | High |
| *Urotrygon cimar* | Cimar Round Ray | 2 | Eastern Pacific | High |
| *Diplobatis ommata* | Bullseye Electric Ray | 1 | Eastern Pacific | High |
| *Neotrygon kuhlii* | Kuhl's Maskray | 8 | Indo-West Pacific | High |
| *Myliobatis tenuicaudatus* | Southern Eagle Ray | 8 | New Zealand and Australia | High |
| *Sympterygia brevicaudata* | Shorttail Fanskate | 3 | South-east Pacific | High |
| *Carcharhinus melanopterus* | Blacktip Reef Shark | 10 | Indo-Pacific | High |
| *Dasyatis pastinaca*, *Myliobatis aquila*, *Rhynchobatus pristinus* | Common Stingray, Common Eagle Ray, (no name) | 7, 24, 1 | Eastern Atlantic species; western records are misapplied names | Medium |
| *Galeocerdo acanthodon* | (no name) | 1 | Fossil tiger shark (Miocene) | High |
| *Dasyatis hastata* | (no name) | 2 | Old, doubtful name with no modern use. Decided 2026-11-20: merged into Roughtail Stingray (*Bathytoshia centroura*), see 6.4 | Medium |

### 5c. The two "Lesser Electric Rays"

Both are valid species since Carvalho (1999) split them:

- *Narcine bancroftii*, **Lesser Electric Ray**: North Carolina to north-east Brazil, including the
  Gulf of Mexico and the whole Caribbean. **This is the Belize species.**
- *Narcine brasiliensis*, **Brazilian Electric Ray**: south-west Atlantic, Espirito Santo (Brazil)
  to northern Argentina. Not in Belize.

Fix: rename *N. brasiliensis* to Brazilian Electric Ray, and take it off the Caribbean Sea and Gulf
of Mexico lists.

### 5d. Round Stingray naming

- "Round Stingray" is *Urobatis halleri* (catalog row still uses the old *Urolophus halleri*),
  Pacific only. It should not be in Belize.
- *Urobatis sloani* is not a separate animal: merge it into *Urobatis jamaicensis* (Yellow
  Stingray), which is the common Belize species and is already on the land list.

### 5e. Smaller name issues on Belize sharks

"Hervey Bay Whaler Shark" for Bull Shark (*Carcharhinus leucas*), "Grayfish" for Common Thresher
(*Alopias vulpinus*), "Darkie Charlie" for Kitefin Shark (*Dalatias licha*): regional nicknames
picked by the name source over the standard English name. *Hypanus say* and *Sphyrna alleni* carry
negative `gbif_key` values (iNaturalist-only taxa), which is expected for new or re-ranked names.

## 6. Ranked fix list for the next republish

Cheapest first. Every step reuses data already on disk; none fetches new GBIF data. Ask before
running anything against `lifer`, and before publishing.

Status (2026-11-20): every item below except the republish itself (6.1) is built into
`npm run fix-catalog-audit -w data-pipeline` (republish checklist item 6b) and applied to the dev
catalog in `lifer` (6.2 to 6.7 on 2026-11-19, the rest on 2026-11-20). Nothing is published.

### 6.1 Republish (already planned)
- **Root cause:** installs run the 2026-10-08 catalog; photos and text added since never shipped.
- **Do:** the existing republish checklist (`docs/plans/next-catalog-republish.md`). Fixes the
  Yellow Stingray photo, the Round Stingray text and 50 more photos in the Belize view.
- **Status:** open (the republish itself).

### 6.2 Drop cross-ocean strays from sea zone lists (no GBIF needed)
- **Root cause:** `zoneNeighbours` (`packages/data-pipeline/src/build/zone-neighbours.ts`) calls two
  zones neighbours when their vertices fall in adjacent 0.25 degree cells, so it links the
  Caribbean Sea to the Panamanian part of the North Pacific Ocean across the isthmus (checked
  against the cached IHO and EEZ outlines: the Caribbean's neighbours include "Panamanian part of
  the North Pacific Ocean" and "North Pacific Ocean"). `decideZoneChecklist`
  (`build/sea-zone-checklist.ts`) then exempts a rare species from the outlier check because that
  "neighbour" has it well recorded.
- **Code fix:** give each zone an ocean basin (Atlantic side, including the Caribbean, Gulf of
  Mexico and Mediterranean, versus Pacific and Indian) and only count same-basin neighbours in
  `establishedNearby`. Add a test with the Caribbean and Panamanian Pacific pair.
- **Data fix:** `compute-sea-zones-offline.ts` needs `data/gbif-country-cache`, which is **not on
  disk now**. So apply the rule as a one-off pass over the existing `sea_zone_species` rows instead:
  for every zone, drop a species with 5 or fewer records, a local share of its GBIF records of 2%
  or less, and no same-basin neighbour with more than 5 records. In the Caribbean Sea this removes
  the 123 species of section 4b. Make it a stage or flag of the refresh command, not a loose script.
- **Then:** rebuild the sea zone packs and country packs (packs stage).
- **Status:** applied 2026-11-19. The `sea-basins` pass and `compute-sea-zones-offline.ts` both
  ignore a neighbour across a land bridge. Basins come from zone names and outlines; a cross-basin
  pair counts as a land bridge only when the outlines share no boundary at sea, so the Cape and Cape
  Horn stay open sea (counting them as barriers removed real species such as Smooth Hammerhead and
  Dusky Grouper) and only the Panama isthmus remains; Suez is a reviewed sea link (Lessepsian
  migrants). An edge-of-range species is dropped only if no zone of its own ocean records it well.

### 6.3 Basin check for strays with more records
- **Root cause:** species with 6 or more misplaced records skip the outlier check entirely (Kuhl's
  Maskray, Southern Eagle Ray, Blacktip Reef Shark).
- **Do:** in the same pass, drop a species from a zone when no zone in that basin has more than 5
  records while another basin has many times more (the query used for this audit found about 175
  in the Caribbean Sea, including the 123). Print the list for review before applying; keep a
  reviewed allow-list for real trans-isthmian or circumtropical cases.
- **Status:** applied 2026-11-19. A stray: its ocean has at most 10 records against 20 times as
  many in another, or at most 50 against 1,000 times as many. Zones that meet another ocean at sea or
  border a polar sea are skipped. Deep-sea species (FishBase minimum depth 200 m or more) are listed
  for review, not removed, because half the ones checked are real in both oceans. Allow-list:
  `basinAllow` in `data/reference/catalog-audit-fixes.json`. Caribbean Sea: 139 rows off (146 with
  the range exclusions).
- **Deep-sea review (2026-11-20):** all 10 rows left for review are single-ocean species, so each
  is now a range exclusion (`keepBasins`) and comes off: five eastern Pacific or Indo-Pacific fish
  in the Caribbean Sea (*Gonichthys tenuiculus*, *Hygophum atratum*, *Bathophilus filifer*,
  *Myctophum aurolaternatum*, *Nezumia stelgidolepis*; the Atlantic has its own species of each
  genus), *Talismania bifurcata* and *Galeus piperatus* off Namibia (north-east Pacific and Gulf of
  California species), *Gigantactis paxtoni* off Cape Verde (Australia and New Zealand),
  *Chascanopsetta crumenalis* off the US Atlantic coast (Hawaii and the Pacific) and *Etmopterus
  schultzi* off Pacific Panama (Gulf of Mexico and Caribbean). In each case one stray record sits
  against tens to thousands in the species' own ocean.

### 6.4 Name and synonym fixes (hand-checked)
- **Root cause:** upstream names and nicknames, and synonyms carried as separate species.
- **Do:**
  - Merge *Urobatis sloani* into *Urobatis jamaicensis* (`data/reference/species-merges.tsv`, then
    `merge-duplicate-species.ts --apply`).
  - Merge the old bird names into the current ones already listed: *Saltator coerulescens* into
    *S. grandis* and *Formicarius analis* into *F. moniliger* for Belize (check other countries
    first: *S. coerulescens* is valid in South America).
  - Common names in `data/reference/species-corrections.json`, then `apply-species-corrections.ts`:
    *Narcine brasiliensis* to Brazilian Electric Ray, *Carcharhinus leucas* to Bull Shark,
    *Alopias vulpinus* to Common Thresher, *Dalatias licha* to Kitefin Shark.
  - Rename *Urolophus halleri* to *Urobatis halleri* in the name-drift work (republish item 5h).
- **Check to add:** the gate or doctor should list common names shared by two species in one region
  view (31 in Belize; 1,381 names shared by 3,611 species catalog-wide, many legitimate, so report,
  do not fail).
- **Status:** applied 2026-11-19: the Urobatis sloani merge, both renames, the four shark and ray
  names, and the two old bird names off 10 lists in Belize, Mexico, Costa Rica and Honduras where the new
  species is listed and the old name has no records of its own. Correction to 4a: *Gallinula
  sanvicensis* is the catalog's Common Gallinule row (eBird comgal1, 687 lists) under a misspelt
  name, so it is renamed to *Gallinula galeata*, not removed. The shared-name check is a report in
  the command (`data/review/shared-common-names.tsv`; Belize 27 after the fixes), not in the gate.
- **Dasyatis hastata (2026-11-20):** merged into Roughtail Stingray (*Bathytoshia centroura*), old
  name kept as a synonym. Evidence on disk: its 33 GBIF records sit off the US Atlantic coast up to
  Massachusetts, off Senegal and in the Gulf of Guinea, in the Bahamas, Trinidad, the Caribbean and
  the Gulf of Mexico, which is Roughtail Stingray's range on both sides of the Atlantic (Southern
  Stingray, the other candidate, does not reach West Africa or New England); its Lifer listings are
  Florida and Massachusetts. iNaturalist keeps the name active but uncurated, with no observations
  at all in the local dump. It was described from New York waters in 1842 and has no modern use.

### 6.5 Range exclusions for basin-misapplied names
- **Root cause:** some names were applied to the wrong ocean for decades, so their records are
  numerous (*Narcine brasiliensis* has 62 Caribbean records).
- **Do:** a small reviewed reference file (species plus zones to leave off) applied by the sea zone
  stage, starting with *Narcine brasiliensis* (Caribbean Sea, Gulf of Mexico), *Dasyatis
  pastinaca* and *Myliobatis aquila* (western Atlantic zones).
- **Status:** applied 2026-11-19 (`rangeExclusions`, applied by the `ranges` pass after the
  regions stage, not by the sea zone stage), plus *Rhynchobatus pristinus*, the two Pacific
  *Kyphosus* (kept to Pacific-coast lists only) and the two Indo-Pacific reef sharks.

### 6.6 Marine mammals filed as fish
- **Root cause:** republish item 8b. 137 marine mammals in the catalog have `taxon_class =
  'actinopterygii'` (99 Artiodactyla, which are whales and dolphins, 34 Carnivora, 4 Sirenia). In
  Belize, Bottlenose Dolphin, Atlantic Spotted Dolphin, Spinner Dolphin, Rough-toothed Dolphin,
  Sperm Whale and West Indian Manatee sit in the fish group, and 20 more come in via the zone.
- **Do:** the item 8b audit and fix; then the fish-only depth rule stops applying to them.
- **Status:** applied 2026-11-19 (`classes` pass, 137 species).

### 6.7 Fossils and junk names
- *Galeocerdo acanthodon* (fossil shark), *Gallinula sanvicensis* (misspelt Hawaiian gallinule).
  Part of republish item 5h (fossil and extinct-only taxa, typos).
- **Status:** applied 2026-11-19 (fossil off every list; gallinule renamed, see 6.4).

### 6.8 Escapes and domestic animals on the Belize land list
- **Root cause:** republish item 5d. Single iNaturalist records and domestic animals pass the
  checks.
- **Do:** add Red-vented Bulbul, Budgerigar, Monk Parakeet, Helmeted Guineafowl, Red Junglefowl,
  Graylag Goose, European Rabbit and Domestic Cat to the captive-origin handling
  (`data/reference/captive-origin-species.json`) for regions outside their range; mark Wild Turkey
  as domestic in Belize. Drop Great Frigatebird and Palm Tanager (single unsupported records) under
  the item 5f cross-check.
- **Status:** done 2026-11-20. Wild Turkey and Budgerigar are marked introduced in Belize (manual
  overrides, 2026-11-19). Red-vented Bulbul, Monk Parakeet, Red Junglefowl, Graylag Goose, Helmeted
  Guineafowl and Wild Turkey joined `captive-origin-species.json`, so the regions stage's escape
  rule (`remove-escapes.ts`) judges them like mammals from the next province build on. The
  single-record birds are handled by a general rule rather than a list: the `unlisted-birds` pass
  drops a bird listing with 5 or fewer records (GBIF, which includes eBird, or iNaturalist photos,
  whichever is more) when the region's cached eBird list lacks the species, but only where that
  eBird list is near complete (it already has 95% of the region's well-recorded birds, at least
  20 of them). eBird's region lists include every species ever reported there, vagrants and
  escapes included, so real vagrants and established exotics stay (Budgerigar, Helmeted Guineafowl,
  Mallard and Red-billed Tropicbird stay on the Belize list). Thinly birded places, where eBird
  misses real residents, are never judged, nor are codes no eBird list carries (possible taxonomy
  drift) or listings in `known-feral-populations.json` and `reintroduced-natives.json`. Off the
  Belize country list: Red-vented Bulbul, Great Frigatebird, Palm Tanager, Piping Plover, Graylag
  Goose, Red Junglefowl, Monk Parakeet, Northern Bobwhite (Belize's is Black-throated Bobwhite) and
  Blue-throated Goldentail; 15 more thin listings come off single districts. Catalog-wide: 8,010
  listings off. The iNaturalist dump confirms the Belize picture: Red Junglefowl, Graylag Goose and
  Monk Parakeet photos there are farm or pet birds, the one Red-vented Bulbul is dated 2000, and
  Great Frigatebird, Palm Tanager and Piping Plover have no observation inside any district.
  European Rabbit (2 photos) and Domestic Cat (21) stay flagged introduced: they are mammals, and
  the escape rule keeps a farm animal where 20 records show a feral population.

### 6.9 Vagrant flag on bats
- **Root cause:** sparse records read as vagrancy. Four resident Belize bats are flagged vagrant.
- **Do:** do not flag bats (and probably small rodents) as vagrant from record counts alone; use a
  manual override (`region_species_manual_overrides`) for these four now.
- **Status:** done. The four Belize overrides applied 2026-11-19. General rule (2026-11-20, the
  `resident-mammals` pass): a native bat or rodent flagged vagrant (not introduced, no manual
  override) loses the flag when the catalog lists it as resident in a region within 300 km (the
  escape rule's neighbour distance), measured edge to edge on simplified outlines, or is linked to
  one by a chain of such listings (as the escape rule treats a population). Distance, not
  country, so a bat resident in Florida says nothing about Arizona. A real vagrant far from any
  resident population keeps its flag. Belize: 11 listings (Pygmy Fruit-eating Bat, Black Mastiff
  Bat, Black-winged Little Yellow Bat, Northern Yellow-shouldered Bat, Big-eared Climbing Rat in
  three districts, Desmarest's Spiny Pocket Mouse, Coues's Rice Rat, Hispid and Toltec Cotton Rats);
  catalog-wide 3,068. Shrews, moles and opossums are just as under-recorded and could join the rule
  later.

### 6.10 Photo gaps the top-up cannot reach
- **Root cause:** 242 species in the Belize view (6 on land, 236 at sea) have no iNaturalist taxon
  id, and 5 lost their photo when the shared-taxon fix unlinked them.
- **Do:** resolve their taxon ids in the catalog stage (or merge or drop them per 6.4); then
  `enrich-all-species --taxa=...` and `top-up-galleries`. After the top-up, run
  `backfill-photo-withheld` so species that gained a publishable main photo lose the withheld flag.
- **Status:** done for the ids (2026-11-20, the `inat-ids` pass). The local iNaturalist taxa dump
  (`data/open-vectors/inat/taxa.csv.gz`) resolves a species whose exact name is one active
  iNaturalist species that no other catalog species holds, the same rule the pipeline's name
  fallback uses; species the shared-taxon review unlinked stay unlinked. Catalog-wide 26,311
  species gained an id, 198 of them in the Belize view. Still without an id in the Belize view: 75,
  whose names iNaturalist has retired (they need a merge into the current name), shares with
  another species, or lacks. The top-up can now reach the new ids; it runs separately, followed by
  `backfill-photo-withheld`.

### 6.11 Missing freshwater fish
- **Root cause:** freshwater fish depend on GBIF land records; some Belize species have none inside
  the boundary in the last download.
- **Do (no new GBIF):** cross-check against FishBase's Belize list as an open regional list (as
  approved for item 5f) and add the missing species in section 4c with a "list" evidence source.
- **Status:** done 2026-11-20 (the `additions` pass, `additions` in the fixes file, country row with
  evidence `list`). Added where FishBase lists the fish for Belize and Lifer's own data backs it:
  Tropical Gar (listed in Peten and Quintana Roo, research-grade iNaturalist photos on the Rio
  Hondo border river), *Thorichthys affinis* (Peten, Quintana Roo, a photo on the Mopan at the
  border), Picotee Livebearer (Peten, Quintana Roo), Mexican River Gizzard Shad (Peten), Barred
  Livebearer (Izabal, next to Toledo) and Mountain Molly (*Poecilia teresae*, described from the Maya
  Mountains). Not added: *Ictalurus meridionalis* and *Profundulus guatemalensis* (Lifer lists them
  only far from Belize), *Rhamdia quelen* (the broad old name for the catfish already listed as
  *R. guatemalensis* and *R. laticauda*), *Anchovia landivarensis* (2 records anywhere, no iNaturalist
  taxon), Devil Firefish (western Atlantic lionfish are Red Lionfish, already listed), and the marine
  *Tomicodon clarkei* and Atlantic Sixgill (not freshwater; the sixgill is not in the catalog, so it
  needs the catalog stage). Every iNaturalist research-grade fish inside Belize already maps to a
  species in the view.

### 6.12 District codes
- Replace the polygon strings in `external_codes` for Stann Creek, Orange Walk, Cayo and Corozal
  with their ISO codes (BZ-SC, BZ-OW, BZ-CY, BZ-CZL), and consider showing "Belize District" for
  the BZ-BZ row so it is not mistaken for a duplicate of the country. Check other countries for the
  same polygon-in-codes pattern.
- **Status:** done 2026-11-20, differently. The polygon is deliberate: 1,893 provinces worldwide
  without a GADM id keep their outline in `external_codes` because it is the geometry the regions
  stage sends to GBIF (`gbifRegionParam` in `buildRegionSpecies.ts`); swapping in `BZ-SC` would make
  the next province build match nothing. Their ISO code is already in `ebird_region_code` (all four
  Belize districts have it), so `top-up-galleries --region=` now matches that too (`--region=BZ-SC`
  works). The BZ-BZ row keeps the name "Belize": that is its ISO and eBird name, and the app shows
  it under the country.

## 7. What I could not verify

- The user's own install (embedded Postgres on port 60488) was not touched, so "what the app shows"
  is inferred from the published seed and photo store, which the install loads. If the user had
  "hide obscure species" off or no pack downloaded, they would see more blanks than the default
  counts here.
- When exactly Yellow Stingray gained its photo in the dev database (no timestamp is stored). The
  photo came after the 2026-10-20 local pack build.
- Individual GBIF records behind the stray Caribbean records (no GBIF access by rule), so whether
  they are aquarium, specimen or coordinate errors is unknown. The basin judgement rests on known
  ranges and on where the other records are.
- Birds: Avibase blocked the request (Cloudflare), so Wikipedia's list (which cites Avibase, May
  2023, 621 species) stood in for it. eBird was not queried.
- Mammals: Wikipedia's Belize list uses older names and mixes historic records; IUCN was not
  queried. Mammal omissions are medium confidence.
- Reptiles and amphibians were compared with iNaturalist research-grade species counts, which
  reflect what people photograph, not a formal checklist.
- No independent open country list was found for corals, sponges, molluscs or crustaceans.
- No full published Belize shark and ray checklist was found; the MarAlliance country report gives
  the main fishery species only.

## 8. Sources

- FishBase, Belize country checklist (676 species present):
  https://www.fishbase.se/Country/CountryChecklist.php?c_code=084&cpresence=present&vhabitat=all2
- FishBase, *Narcine bancroftii*: https://fishbase.se/summary/SpeciesSummary.php?id=53905
- Fishes of Texas, *Narcine bancroftii* (Carvalho 1999 split): https://fishesoftexas.org/taxa/narcine-bancroftii
- Shark-References, *Narcine brasiliensis*: https://www.shark-references.com/species/view/Narcine-brasiliensis
- Catalog of Fishes (California Academy of Sciences), Urobatis entries:
  https://researcharchive.calacademy.org/research/ichthyology/catalog/fishcatget.asp?genid=822
- MarAlliance, Global Status of Sharks and Rays: Belize (2024):
  https://maralliance.org/wp-content/uploads/2025/09/2024-024-GSRR_En_Belize.pdf
- Wikipedia, List of birds of Belize (from Avibase): https://en.wikipedia.org/wiki/List_of_birds_of_Belize
- Wikipedia, List of mammals of Belize: https://en.wikipedia.org/wiki/List_of_mammals_of_Belize
- iNaturalist API, research-grade species counts for Belize (place 6953), reptiles and amphibians:
  https://api.inaturalist.org/v1/observations/species_counts?place_id=6953&taxon_id=26036&quality_grade=research
