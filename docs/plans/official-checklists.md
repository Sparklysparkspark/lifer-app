# Official country checklists (pilot: fish, Japan and Colombia)

Status: pilot done 2026-11-25, read-only. Nothing applied to any database. Maintainer decision
(2026-11-25): use authoritative species lists for a country where they exist, fish first, because
iNaturalist covers fish thinly.

## Short answer

- **Japan's fish gap is mostly a viewing artefact, not missing data.** The Japan country pack has
  2,515 fish, but Japan's view also reads its 6 sea zone packs: 5,242 distinct fish in all.
  FishBase confirms 4,229 species for Japan (native, endemic or introduced); 3,546 (84%) are
  already listed in the country or one of its sea zones. FishBase would add 701 catalog species
  (179 of them unphotographed deep-sea fish) and 25 species the catalog lacks.
- **The bigger win is un-hiding.** 624 Japan and 415 Colombia fish that FishBase confirms are
  flagged vagrant today (hidden by default), mostly because iNaturalist lacks them.
- **FishBase is not enough for Colombia's freshwater fish.** FishBase lists 916 confirmed
  freshwater species for Colombia; the national checklist (DoNascimiento et al., CC BY 4.0, on
  GBIF, updated April 2026) had 1,494 already in 2017. Of the 1,048 Colombia fish we list that
  FishBase does not, FishBase itself places 941 in a neighbouring country: those are FishBase
  gaps, not our errors.
- **Recommendation:** build one `apply-official-checklists` step with FishBase for marine and
  brackish fish everywhere, plus national lists where they beat FishBase (Colombia's freshwater
  list first). Use it to confirm and un-hide, and to add catalog species; leave new catalog rows
  and removals for later, as review lists.

## Data source

**FishBase via the rfishbase snapshot** (chosen). FishBase's own MySQL tables exported as parquet by
Carl Boettiger for rOpenSci's `rfishbase`, on Hugging Face (`cboettig/fishbase`, versions v19.04 to
v25.04; licence field `cc-by-nc-4.0`). Five files cover every country: `country` (species x country
with `Status`: native, endemic, introduced, questionable, stray, misidentification, error, not
established, extirpated; and `CurrentPresence`), `countref` (country codes, FishBase's own counts),
`species` (Fresh, Brack, Saltwater, DemersPelag, depth range), `synonyms`, `families` (class). About
25 MB, five requests per snapshot, no scraping of fishbase.se. Same repository has SeaLifeBase
(`data/slb`) for marine invertebrates later.

- Alternatives checked: scraping fishbase.se country pages (thousands of requests, same data, less
  polite); OBIS (already used for 6a, but occurrence based with no country status); WoRMS
  distribution (CC BY 4.0, sparse for fish, marine regions rather than countries); Eschmeyer's
  Catalog of Fishes (authoritative names, no open licence or bulk export).
- Japan national list: Motomura's annotated checklists (Kagoshima University Museum) are PDFs with
  no stated open licence; FishBase marks Japan complete for both freshwater and marine, so FishBase
  is the practical source there.
- Colombia freshwater: "Lista de especies de peces de agua dulce de Colombia", Asociación Colombiana
  de Ictiólogos, GBIF checklist dataset `7e3a2242-46d6-4b90-b80c-42c5d27ed93b`, CC BY 4.0, modified
  2026-04-15. A checklist dataset, not occurrence data, so the no-new-GBIF rule is not touched, but
  the maintainer should confirm that reading.

### Licence and attribution

- FishBase: CC BY-NC 4.0. Fine for Lifer (free, non-commercial). Required citation: "Froese, R. and
  D. Pauly. Editors. 2025. FishBase. World Wide Web electronic publication. www.fishbase.org,
  version (04/2025)." For a single record FishBase asks to cite that record's main reference; for a
  derived country list the database citation is the norm. Credit the snapshot too ("data via the
  rfishbase snapshot, C. Boettiger").
- Never ship FishBase-derived lists in Preen (paid): keep its dependencies commercially clean.
- Colombia checklist: CC BY 4.0, cite the dataset and DoNascimiento et al.
- Where credits live: `packages/data-pipeline/DATA_SOURCES.md` and the app's data sources credits,
  next to the existing FishBase credit for descriptions.

### Command (built in the pilot)

```
cd packages/data-pipeline
npx tsx src/scripts/fetch-official-checklists.ts                  # Japan and Colombia
npx tsx src/scripts/fetch-official-checklists.ts --countries=392,170,76 --version=v25.04
npx tsx src/scripts/fetch-official-checklists.ts --compare        # plus the read-only report
```

Downloads each parquet file once (paced 3 s, 6 retries with backoff, written whole then renamed,
so it resumes), then extracts one `checklist-<code>.tsv` per FishBase country code (ISO numeric).
`--compare` reads the catalog in a `READ ONLY` transaction and writes `compare-<code>.tsv` and
`.json` next to them. Cache: `data/official-checklists-cache/fishbase-v25.04/`, 25 MB, git-ignored.
Logic tests: `fetch-official-checklists.test.ts`.

## Pilot results

Matching: exact scientific name, then synonyms both ways (the catalog's `species_synonyms`, which
holds 6b's merges, and FishBase's synonyms), then a unique near spelling within fish. A synonym or
near spelling that FishBase accepts as its own species is never taken. No near-spelling match was
needed: synonyms caught everything matchable.

| | Japan | Colombia |
|---|---|---|
| FishBase species (any status) | 4,384 | 2,211 |
| Confirmed (native / endemic / introduced) | 4,229 (4,138 / 48 / 43) | 2,168 (2,047 / 84 / 37) |
| Possible (questionable / stray) | 97 | 22 |
| Says not there (misidentification, error, not established, extirpated) | 58 | 21 |
| Confirmed by habitat: freshwater / marine (incl. brackish) / both | 199 / 3,812 / 218 | 916 / 1,180 / 72 |
| Confirmed matched: exact / synonym / not in catalog | 4,039 / 165 / 25 | 2,073 / 82 / 13 |
| Confirmed already listed: country / country but vagrant / sea zone only | 1,604 / 624 / 1,318 | 953 / 415 / 558 |
| Confirmed in catalog, would be added | 658 (49 fresh, 29 both, 580 marine) | 229 (115 fresh, 3 both, 111 marine) |
| of which unseen deep-sea | 171 | 20 |
| of which with a catalog reference photo | 344 | 117 |
| Possible in catalog, would be added | 43 | 3 |
| Not in catalog (confirmed or possible) | 25, none with an open iNaturalist photo, 10 deep-sea | 13, none with an open photo |
| Our country rows | 2,515 | 2,428 |
| Our country rows FishBase lacks (listed + vagrant) | 270 (131 + 139) | 1,048 (572 + 476) |
| Our country rows FishBase says are not there | 12 | 7 |
| Published 2026-10-08 pack species / not on FishBase's list | 2,800 / 365 | 2,814 / 1,304 |

"Unseen deep-sea": marine only, FishBase habitat bathydemersal or bathypelagic, and no open (CC0, CC
BY) research-grade iNaturalist photo anywhere (from `data/open-vectors/candidates.parquet`). It is a
lower bound for "seen": a species with only CC BY-NC photos counts as unseen.

**Our rows FishBase lacks.** Japan's 270: 154 FishBase places in a neighbour (Korea, China, Taiwan,
Russia, the Philippines), 73 elsewhere only, 20 in no country, 23 unknown to FishBase (recent
descriptions or splits such as _Neotrygon yakkoei_, _Gnathopogon ishikawae_). Colombia's 1,048: 941
in a neighbour (Venezuela, Ecuador, Peru, Brazil, Panama, Costa Rica), 63 elsewhere only (several
recently described Colombian endemics, e.g. _Trichomycterus guacamayoensis_), 35 in no country, 9
unknown to FishBase. So absence from FishBase is not evidence against a listing.

**FishBase says not there** (review list, no automatic removal yet). Japan: _Acanthocepola indica_,
_Etrumeus sadina_ (listed); _Bodianus diana_, _Chlorurus sordidus_, _Epinephelus chlorostigma_,
_Heteropriacanthus cruentatus_, _Lepadichthys frenatus_, _Malthopsis lutea_, _Neotrygon kuhlii_,
_Neozoarces pulcher_, _Ophiocara porocephala_, _Parapercis hexophtalma_ (vagrant). Colombia:
_Hydrolycus scomberoides_, _Myloplus schomburgkii_ (listed); _Cyphocharax nigripinnis_, _Farlowella
curtirostra_, _Geophagus surinamensis_, _Salmo trutta_ (not established), _Sphyrna tiburo_
(vagrant). Most are old-name or look-alike confusions FishBase records explicitly.

**Last night's restore (evidence `published-2026-10-08`).** Rows with that evidence in each country
and its provinces and groups today: Japan 520 rows, 518 species; Colombia 895 rows and species.
FishBase confirms Japan 417, possible 7, not there 5, absent 89; Colombia 410, possible 6, not there
5, absent 474. Absent mostly means FishBase's lag (above), not a bad restore. The confirmed ones are
all flagged vagrant today and would be un-hidden.

### Pack size

Country fish packs today, compressed: Japan 2.94 MB for 2,515 species (about 1.17 KB each),
Colombia 1.98 MB for 2,428 (about 0.82 KB). Photos are not in packs: the photo store is per species
(about 52 KB per species with a photo), and every catalog species is already in it, so adding rows
for catalog species costs no photo bytes.

| | Rows added | Pack growth | Without the unseen deep-sea tail |
|---|---|---|---|
| Japan (confirmed + possible) | 701 | about +0.82 MB (+28%) | 522 rows, about +0.61 MB (+21%) |
| Colombia (confirmed + possible) | 232 | about +0.19 MB (+10%) | 211 rows, about +0.17 MB (+9%) |

The hidden tail still ships (hidden is a view filter), so leaving it out of the default view does
not shrink packs; leaving it out of the data does. The 38 species the catalog lacks have no open
photo, so they would ship photo-less, adding to the 18,328 listed species already without one.
Un-hiding the 624 and 415 confirmed vagrants costs nothing in size.

## Proposed pipeline step: `apply-official-checklists`

One parameterised, resumable command (`--source=fishbase,colombia-freshwater`, `--countries=`,
dry run by default, `--apply`), offline once the cache is filled. Every decision to
`data/review/official-checklists-changes.tsv`.

**Where it runs:** in the regions stage after `apply-inat-membership` and its follow-ups (escapes,
eBird exotics, `apply-introduced-flags`), before the sea zones and before 6b, tiers (7), vectors and
packs. Then 6c can't flag what it just confirmed, and 6b and the tiers see the final list.

What it does, per country, for fish (status group from FishBase, or the national list where one is
configured for that habitat):

1. **Confirmed, already listed but vagrant:** clear the vagrant flag (hand-checked overrides still
   win). Introduced: set the introduced flag.
2. **Confirmed, in the catalog, not listed in the country or its sea zones:** add a country row,
   evidence `fishbase-v25.04` (or the national list's id). Marine fish go on the country row too:
   FishBase's country lists cover the country's waters without saying which sea, so a sea zone
   can't be chosen honestly. (Decision for the maintainer: country row, or the country's own
   "<country> part of ..." zone.)
3. **Unseen deep-sea tail:** add it like 2 but hidden by default (below).
4. **Possible (questionable, stray):** add flagged vagrant (hidden by default), like any thin record.
5. **FishBase says not there, and we list it:** review list only in the first run; later, flag
   vagrant.
6. **Not in the catalog:** review list only (38 in the pilot); new species rows wait for a separate
   decision (no photos available).
7. **Absent from FishBase:** nothing. Absence is not evidence (see the Colombia numbers).

**Interactions:**

- **6c (iNaturalist membership):** must leave rows with an official-list evidence alone, like
  hand-checked overrides, or a standalone 6c rerun re-flags them. Official lists win over
  iNaturalist absence for fish only (iNaturalist stays the source of truth where it covers the
  group).
- **6b (audit):** its range exclusions and sea-basin strays still apply; a reviewed range exclusion
  beats FishBase. Merges first, so the catalog names match.
- **Tiers:** no new tier. A row with no photos or records already comes out `local_tier` NULL with
  `tier_reason` `no_data` or `thin_data`, which the app shows as "Not enough data". The tiers'
  removal rules (`removeUnconfirmed`, `removeNeverPhotographedHere`) cover mammals and herps only,
  so fish rows survive. To check when building: a country row with no province rows keeps its row
  when the country is rated from its provinces' inputs.
- **Packs:** no format change. Rows ship with `isVagrant` and `tierReason` as now.
- **Restore (`restore-published-rows`):** its rows that FishBase confirms get un-hidden by step 1.

### Hidden-by-default "listed, not yet seen"

Least invasive version, no migration: rows from step 3 get `is_vagrant = true` (the existing
hidden-by-default filter) and `tier_reason = 'listed_unseen'`. Two small changes:

- Tiers stage: keep `listed_unseen` on those rows (today it writes `vagrant` for every vagrant
  row).
- App: where the card shows "Vagrant here", show "Listed, not yet photographed" for
  `tierReason === 'listed_unseen'` (one i18n string; the filter that reveals vagrants reveals these
  too). Packs already carry `tierReason`.

A separate column would be cleaner if the filter ever needs to tell them apart; not needed now.

## Other groups

| Group | Source | Licence | Country status | Fit |
|---|---|---|---|---|
| Birds | eBird | already used | yes | done |
| Mammals | Mammal Diversity Database v2.5 (Zenodo, 2026-07-28) | CC BY 4.0 | country distribution per species, no native/introduced detail | good; 1 to 2 days |
| Mammals | IUCN Red List | non-commercial, no redistribution without permission | yes | not usable for packs |
| Reptiles | The Reptile Database | 2014 dump CC BY 4.0 (stale); current data no open licence | country text field | ask the maintainers (Uetz) for a current dump; stale otherwise |
| Amphibians | AmphibiaWeb | CC BY-NC; bulk download needs permission | ISO country codes per species | ask permission first |
| Amphibians | Amphibian Species of the World | no open licence | yes | no |
| Marine invertebrates | SeaLifeBase (same snapshot) | CC BY-NC 4.0 | same table shape as FishBase | cheap follow-on, sparse |
| Fish, national | Colombia freshwater checklist (GBIF dataset) | CC BY 4.0 | yes | 1 day; look for others like it (Brazil, Peru, Mexico) on GBIF |

Mammals, reptiles and amphibians are well covered by iNaturalist already, so they gain less than
fish; the tiers' removal rules for them would also need to respect official-list rows.

## Effort

- FishBase step for every country (script, 6c guard, tiers keeping `listed_unseen`, app label,
  tests): about 2 to 3 days. Runtime: minutes, offline.
- Colombia freshwater list as a second source: about 1 day (read the GBIF checklist once, cache it).
- Review lists (not there, not in catalog): an hour per country to read.

## Risks

- FishBase lags taxonomy and new descriptions (Colombia), and its names follow Eschmeyer, not
  iNaturalist. Synonym matching handled the pilot (0 near-spelling matches needed), but expect a few
  hundred unmatched names worldwide.
- FishBase country lists include the whole economic zone: lots of deep-water fish nobody will
  photograph. Hence the hidden tail.
- Marine rows on the country instead of a sea zone duplicate some zone listings; harmless in the
  merged view, a decision either way.
- CC BY-NC must stay out of anything commercial (Preen).
- Un-hiding about 1,000 fish per country pair changes the default view a lot; worth a look at a few
  countries before the republish.

## Recommendation

Go ahead with FishBase as the first official source for fish, for un-hiding and for adding catalog
species, in this republish if the maintainer wants it (offline, minutes), otherwise right after.
Add the Colombia freshwater checklist next and look for similar national lists. Keep new species
rows and removals as review lists for now. Do mammals (MDD) after fish; ask the Reptile Database and
AmphibiaWeb for permission before building those.
