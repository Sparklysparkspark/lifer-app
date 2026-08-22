# Data sources — what to refresh, and how often

**This pipeline is maintainer-only.** Nothing in `packages/data-pipeline` runs on an end
user's self-hosted instance (see `Dockerfile` — the container only runs migrations + the API
at startup, never a `build-seed-*` script). Refresh these sources on your own machine, load
the result into your own database, and ship the *result* to users (DB dump / GitHub Release
bundle — not yet built, see conversation) — never point a fetch script at a live user's
instance, or every self-hosted install would be hitting GBIF/Wikidata/etc. independently and
that's exactly the kind of unnecessary upstream load this is meant to avoid.

## How refreshing actually works

Two different behaviors depending on the source:

- **Live query sources** (GBIF backbone/vernacular, Wikidata, iNaturalist, Wikipedia) —
  hit the real API fresh on every run, no local cache. Just re-running the relevant
  `build-seed-*` script gets current data.
- **Versioned static-file sources** (MDD, AVONET, COMBINE, EltonTraits, MEOW, Natural Earth,
  bird-abundance, fish-depth) — downloaded once into `data/raw/<source>/` and never
  re-fetched after that (see `raw-cache.ts`'s `fetchCached`). To actually pick up a new
  release: **delete that source's folder under `data/raw/`** first, then re-run the build.
  A genuinely new dataset version usually also ships a new download URL/DOI — check the
  source's own page (linked below) and update the URL constant in the matching
  `src/fetch/fetch-*.ts` file if so.

## Sources

| Source | Used for | Cadence (real-world) | Refresh |
|---|---|---|---|
| [GBIF Backbone Taxonomy](https://www.gbif.org/dataset/d7dddbf4-2cf0-4f39-9b2a-bb099caae36c) (`api.gbif.org`) | scientific names, taxonomy, extinct/fossil filtering, occurrence counts (rarity) | Rolling; real species additions/reclassifications trickle in — quarterly check is plenty | `fetch-gbif-backbone.ts` — live API, no cache to clear |
| [GBIF vernacular names API](https://www.gbif.org/developer/species) | bird/fish/etc. common names (Clements/IOC preferred) | Same as backbone | `fetch-gbif-vernacular.ts` — live |
| [Wikidata](https://query.wikidata.org/sparql) | IUCN status, Commons image, Wikipedia sitelink | Continuously crowd-edited | `fetch-wikidata.ts` — live |
| [iNaturalist API](https://api.inaturalist.org/v1) | reference photos, Wikipedia summary | Continuously | Already lazy, per-species, on the live API (`apps/api/src/species/lazyEnrich.ts`) — not a maintainer batch job |
| [Wikipedia](https://en.wikipedia.org/w/api.php) | descriptions, habitat/range text | Continuously | Same — lazy, per-species |
| [Mammal Diversity Database (MDD)](https://www.mammaldiversity.org/) — [Zenodo](https://zenodo.org/records/15007505) | mammal taxonomy, common names, MSW3 cross-reference | New major version roughly every 6–12 months | Check Zenodo for a newer record, update `MDD_URL`/filename in `fetch-mdd.ts`, delete `data/raw/mdd/`, re-run `npm run build-seed-mammals -w data-pipeline` |
| [AVONET](https://doi.org/10.1111/ele.13898) — [figshare](https://figshare.com/articles/dataset/AVONET_morphological_ecological_and_geographical_data_for_all_birds/16586228) | bird mass/wingspan/trophic niche/lifestyle | Static academic dataset (2022 paper) — essentially never updates | Re-run `npm run build-seed -w data-pipeline` only if a superseding dataset is published |
| [EltonTraits 1.0](https://doi.org/10.6084/m9.figshare.c.3306933.v1) | supplementary bird diet/foraging traits | Static (2014 paper) | Same as AVONET |
| [COMBINE](https://doi.org/10.6084/m9.figshare.13028255.v4) | mammal density/home range/nocturnality | Static (2021 paper) | Re-run `build-seed-mammals` only if superseded |
| [Callaghan et al. bird abundance](https://doi.org/10.5281/zenodo.4723365) | population estimates (birds) | Static (2021 paper) | Re-run `build-seed` only if superseded |
| ["Global depth range of marine fishes"](https://doi.org/10.6084/m9.figshare.20403111) | fish depth range | Static (2022 paper) | Re-run `build-seed-fish` only if superseded |
| [Marine Ecoregions of the World (MEOW)](https://www.marineregions.org/sources.php#meow) | sea zone polygons | Static reference dataset, rarely revised | Delete `data/raw/meow/`, re-run `fetch-marine-ecoregions.ts` if a revision ships |
| [Natural Earth](https://www.naturalearthdata.com/) | country/province boundaries, marine polygons | Revised occasionally (no fixed schedule); rarely matters for this app | Delete `data/raw/natural-earth/`, re-run region build if needed |

## Recommended cadence

- **Once a year, or after hearing about a specific new species/split**: re-run
  `build-seed-mammals`/`build-seed`/`build-seed-fish`/etc. against live GBIF+Wikidata (free —
  no cache to clear for those two). This is where real new-species/reclassification news
  actually shows up.
- **When MDD announces a new version** (check
  [mammaldiversity.org](https://www.mammaldiversity.org/) or its Zenodo page once a year):
  update the URL, clear the cache, rebuild mammals.
- **The trait sources (AVONET/EltonTraits/COMBINE/bird-abundance/fish-depth) almost never
  need touching** — they're tied to one specific publication each. Only revisit if you hear
  about a genuinely new dataset that supersedes one.
- **Rarity/elusiveness recompute** (`compute-elusiveness.ts`, the 258-country GBIF crawl) is
  expensive — once or twice a year is enough; citizen-science record volume doesn't shift
  fast enough to justify more.

After any refresh, review before loading — new species insert cleanly via `load-seed.ts`'s
`ON CONFLICT DO UPDATE`, but anything that would *remove* a currently-loaded species needs
the same safety check as `purge-mammal-fossils.ts`: confirm zero `captures`/`user_species`
rows reference it before deleting.
