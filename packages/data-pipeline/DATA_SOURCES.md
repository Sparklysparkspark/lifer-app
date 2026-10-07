# Data sources

Every outside dataset and model Lifer uses, what it's used for, its license, and the credit it
asks for. The user-facing version of this list is the
[Data sources and credits](https://sparklysparkspark.github.io/lifer-app/credits) docs page;
bundled software is in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

Keep this file in step with the code: when you add, drop or upgrade a source, update its row
here, on the credits page, and in the matching `src/fetch/*.ts` header comment.

## How the data reaches installs

This pipeline is maintainer-only. Installs never run it, and never call these sources in bulk.
A maintainer runs `npm run refresh -w data-pipeline` (see [SCRIPTS.md](./SCRIPTS.md)), which
builds everything into a local database and publishes the result as GitHub releases:

- `catalog-latest`: the catalog seed (species, names, traits, regions, sea zones, reference
  vectors). Also bundled in the Docker image and the desktop app.
- `packs-latest`: region checklists.
- `photos-latest`: the reference photo store.
- `map-latest`: the offline basemap.
- `models`: the model files.

At runtime, an install talks to only two outside services on its own: iNaturalist, for details
of species it doesn't have yet and for species you add from iNaturalist, and Hugging Face, for
model files that aren't mirrored on the `models` release.

## Taxonomy and names

| Source | Used for | Where | License | Credit |
|---|---|---|---|---|
| [GBIF Backbone Taxonomy](https://www.gbif.org/dataset/d7dddbf4-2cf0-4f39-9b2a-bb099caae36c) and GBIF vernacular names | Scientific names, taxonomy, fossil filtering, common names | `src/fetch/fetch-gbif-backbone.ts`, `fetch-gbif-vernacular.ts` | CC0 1.0 | Cite the backbone: GBIF Secretariat, GBIF Backbone Taxonomy, [doi:10.15468/39omei](https://doi.org/10.15468/39omei) |
| [Catalogue of Life](https://www.catalogueoflife.org/), through ChecklistBank | Current names and synonyms | `src/scripts/reconcile-species-names.ts` | CC BY 4.0 | Cite the Catalogue of Life release used |
| [eBird/Clements Checklist of Birds of the World](https://www.birds.cornell.edu/clementschecklist/) | eBird species codes, ABA codes, birds the catalog lacks | Committed as `data/reference/ebird-taxonomy.csv` (from the eBird API's taxonomy endpoint); used by `backfill-aba-codes.ts`, `add-missing-species.ts`, `reconcile-species-names.ts` | eBird API Terms of Use | Cornell Lab of Ornithology, the eBird/Clements Checklist of Birds of the World |
| [Mammal Diversity Database](https://www.mammaldiversity.org/) v2.0 | Mammal taxonomy and common names | `src/fetch/fetch-mdd.ts` | CC BY 4.0 | Mammal Diversity Database (2025), [doi:10.5281/zenodo.15007505](https://doi.org/10.5281/zenodo.15007505) |
| [iNaturalist](https://www.inaturalist.org/) API | Taxon ids, name changes and splits, place checklists, photo counts, establishment status | `packages/data-pipeline/src/scripts/*`, `src/scripts/find-species-splits.ts`, `add-missing-species.ts` | [iNaturalist Terms of Use](https://www.inaturalist.org/pages/terms) | iNaturalist, [inaturalist.org](https://www.inaturalist.org) |

## Occurrences, checklists and rarity

| Source | Used for | Where | License | Credit |
|---|---|---|---|---|
| [GBIF](https://www.gbif.org/) occurrence downloads | Province and country checklists, occurrence counts behind rarity tiers | `packages/data-pipeline/src/scripts/compute-provinces-bulk.ts`, `src/build/compute-elusiveness.ts`, `src/scripts/fetch-occurrence-stats.ts` | Records are CC0, CC BY or CC BY-NC, set by each publishing dataset | GBIF asks that each download be cited by its DOI: "GBIF.org (date) GBIF Occurrence Download https://doi.org/..." The pipeline doesn't record those DOIs yet. |
| [eBird](https://ebird.org/) API (species lists) | Bird lists per region, checking vagrant flags | `compute-provinces-bulk.ts`, `report-vagrant-ebird.ts` (needs `EBIRD_API_KEY`) | eBird API Terms of Use | eBird, Cornell Lab of Ornithology |
| iNaturalist research-grade observations | Lists for provinces GBIF doesn't cover, photo counts | `compute-provinces-inat.ts`, `refresh-inat-counts.ts` | iNaturalist Terms of Use | iNaturalist |
| [IUCN Red List](https://www.iucnredlist.org/), through GBIF and Wikidata | Conservation status | `src/pipeline/iucnRedList.ts`, `src/scripts/backfill-iucn-status.ts`, `src/fetch/fetch-wikidata.ts` | CC BY 4.0 (GBIF copy); [IUCN Red List Terms of Use](https://www.iucnredlist.org/terms/terms-of-use) (categories unrestricted) | IUCN, The IUCN Red List of Threatened Species |
| [FishBase](https://www.fishbase.se/) country table (source.coop mirror) | Checking vagrant flags on fish. Only the resulting flags ship, not FishBase data. | `packages/data-pipeline/src/scripts/verify-vagrant-fishbase.ts` | CC BY-NC 4.0 | Froese, R. and D. Pauly (eds.), FishBase, www.fishbase.org |
| [Wikipedia pageviews](https://wikimedia.org/api/rest_v1/) | How well known a species is, a correction for photo-based tiers | `src/scripts/fetch-wiki-pageviews.ts` | CC0 | Wikimedia Foundation |

## Traits

These are static datasets from one paper each. They're downloaded once into `data/raw/<source>/`
and reused (`src/raw-cache.ts`). To pick up a new version, update the URL in the fetch script and
delete that folder.

| Source | Used for | Where | License | Credit |
|---|---|---|---|---|
| [AVONET](https://doi.org/10.1111/ele.13898) | Bird mass, wingspan, trophic niche, lifestyle, range size | `src/fetch/fetch-avonet.ts` | CC BY 4.0 | Tobias, J.A. et al. (2022) AVONET: morphological, ecological and geographical data for all birds. Ecology Letters 25: 581-597 |
| [EltonTraits 1.0](https://doi.org/10.6084/m9.figshare.c.3306933.v1) | Bird diet, foraging stratum, nocturnality | `src/fetch/fetch-elton-traits.ts` | CC BY 4.0 | Wilman, H. et al. (2014) EltonTraits 1.0. Ecology 95: 2027 |
| [COMBINE](https://doi.org/10.6084/m9.figshare.13028255.v4) | Mammal density, home range, nocturnality | `src/fetch/fetch-combine.ts` | CC BY 4.0 (figshare) | Soria, C.D. et al. (2021) COMBINE: a coalesced mammal database of intrinsic and extrinsic traits. Ecology 102: e03344 |
| [Global bird abundance](https://doi.org/10.5281/zenodo.4723365) | Bird population estimates | `src/fetch/fetch-bird-abundance.ts` | CC BY 4.0 | Callaghan, C.T. et al. (2021) Global abundance estimates for 9,700 bird species. PNAS 118: e2023170118 |
| [Global depth range of marine fishes](https://doi.org/10.6084/m9.figshare.20403111) | Fish depth range | `src/fetch/fetch-fish-depth.ts` | CC BY 4.0 | The global depth range of marine fishes and their genetic coverage for environmental DNA metabarcoding (2023), Ecology and Evolution |

## Places and maps

| Source | Used for | Where | License | Credit |
|---|---|---|---|---|
| [Natural Earth](https://www.naturalearthdata.com/) | Country and province boundaries | `src/fetch/fetch-region-boundary.ts` | Public domain | None required. "Made with Natural Earth" is appreciated. |
| [IHO Sea Areas, version 3](https://www.marineregions.org/) (Marine Regions, [doi:10.14284/323](https://doi.org/10.14284/323)) | Sea zone outlines for fish and marine packs, and which regions border them | `src/fetch/fetch-iho-sea-areas.ts`, `src/build/build-sea-zones.ts`; shipped in the catalog seed's `sea_zones` table (and the zone ids in `regions.nearby_sea_zone_ids`) | CC BY 4.0. Changed: each area cut to its largest polygon's outline and simplified to 80 points; the oceans left out (see the next row). | Flanders Marine Institute (2018). IHO Sea Areas, version 3. Available online at https://www.marineregions.org/ https://doi.org/10.14284/323. Marine Regions asks that users be pointed to marineregions.org for current versions. |
| [The intersect of the Exclusive Economic Zones and IHO sea areas, version 5](https://www.marineregions.org/) (Marine Regions, [doi:10.14284/699](https://doi.org/10.14284/699)) | Sea zones for coasts on open ocean: each country's or territory's part of an ocean | `src/fetch/fetch-eez-iho.ts`, `src/build/build-sea-zones.ts`; shipped like the IHO zones | CC BY 4.0. Changed: only the oceans' national parts, without high seas and joint regime areas; each cut to its largest polygon's outline and simplified to 80 points. | Flanders Marine Institute (2024). The intersect of the Exclusive Economic Zones and IHO sea areas, version 5. Available online at https://www.marineregions.org/ https://doi.org/10.14284/699 |
| [Protomaps](https://protomaps.com/) basemap, built from [OpenStreetMap](https://www.openstreetmap.org/copyright) | The offline world map (`world-z8.pmtiles` on `map-latest`) | `apps/web/src/lib/pmtiles.ts`, `MAP_DOWNLOAD_URL` in `packages/core/src/config.ts` | Map data ODbL 1.0; Protomaps styles BSD-3-Clause | "© OpenStreetMap contributors", and Protomaps |

The geometry of GADM is deliberately not used: its license is non-commercial. Its codes appear
only as GBIF query keys.

## Descriptions and reference photos

| Source | Used for | Where | License | Credit |
|---|---|---|---|---|
| [Wikipedia](https://en.wikipedia.org/) | Species descriptions, habitat and range text, gallery candidates | `src/scripts/backfill-descriptions.ts`, `src/fetch/wikipediaArticles.ts`, `fetch-wikipedia-summary.ts`, `fetch-wikipedia-media.ts`, `packages/core/src/species/lazyEnrich.ts` | CC BY-SA 4.0 | The species page links each description to its Wikipedia article |
| [WoRMS](https://www.marinespecies.org/) (World Register of Marine Species) | Habitats (marine, brackish, freshwater, land) of fish and marine mammals, for sea zone checklists | `src/pipeline/wormsEnvironment.ts`, `src/scripts/fetch-worms-environment.ts` | CC BY 4.0 | WoRMS Editorial Board, World Register of Marine Species |
| [Wikidata](https://www.wikidata.org/) | IUCN status, Commons image, Wikipedia links (by taxon name, or by GBIF id for descriptions) | `src/fetch/fetch-wikidata.ts`, `src/fetch/wikipediaArticles.ts` | CC0 1.0 | None required |
| [iNaturalist](https://www.inaturalist.org/) photos | Reference photos and galleries | `src/fetch/fetch-reference-photos.ts`, `packages/core/src/species/lazyEnrich.ts` | Each photo's own license, chosen by its photographer | Each photo's attribution, shown with it in the app |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Fallback reference photos | `src/fetch/fetch-commons-photo.ts` | Each file's own license | The file's author, shown with it in the app |

The enrich stage stores a species' iNaturalist photos whatever their license, recording the
license (or `all-rights-reserved` when there is none): on someone's own install that's personal
viewing. What the project **publishes** is limited by `isPublishableLicense` in
`packages/core/src/species/licensePolicy.ts` to CC0, public domain, CC BY, CC BY-SA, CC BY-ND,
CC BY-NC, CC BY-NC-SA and CC BY-NC-ND. NC photos are shared because Lifer is free and
non-commercial and keeps every photo's credit. No-derivatives photos are shared too: Lifer only
resizes them and converts them to WebP, which CC 4.0 counts as a technical modification rather
than an adaptation, and framing a photo in a card happens at display time, not in the file. All
rights reserved (or no license) and GFDL photos are never published. Enrichment ends by
applying that to the database (`src/pipeline/photoLicensePolicy.ts`), and the photo store, pack
and seed builds refuse to run while anything else is left. `LIFER_ALLOW_NONCOMMERCIAL_PHOTOS=1`
only widens the pipeline's own fetchers for local development.

Descriptions follow one rule wherever they're written
(`packages/core/src/species/descriptionText.ts`): from the article's lead and its Description
(or Identification, Appearance) section, keep identification and notable behaviour or ecology;
drop taxonomy, etymology, alternative names, range lines that are mostly place names and
conservation-status lines (the map, checklists and IUCN badge cover those). Whole sentences only,
up to 800 characters, never cut mid-sentence; the "(Wikipedia)" link after the text is the "read
more". A stub with nothing but its taxonomy line keeps that line. When the sentence naming the
species is dropped, a following "It ..." gets the species' name instead. Text taken straight from
Wikipedia is credited "Wikipedia contributors (CC BY-SA)"; the on-view iNaturalist path's
"Wikipedia contributors (CC BY-SA), via iNaturalist".

## Models

| Model | Used for | Where | License | Credit |
|---|---|---|---|---|
| [BioCLIP 2](https://huggingface.co/imageomics/bioclip-2) (Imageomics) | Species identification. Exported to ONNX as `bioclip-2-v1` on the `models` release. | `python/export_id_model.py`, `python/compute_id_model_vectors.py`, `ID_MODEL_URL` in `packages/core/src/config.ts` | MIT | Gu, J. et al. (2025) BioCLIP 2: Emergent Properties from Scaling Hierarchical Contrastive Learning, [doi:10.57967/hf/5765](https://doi.org/10.57967/hf/5765) |
| [CLIP ViT-L/14](https://github.com/openai/CLIP) (OpenAI), ONNX conversion by [Xenova](https://huggingface.co/Xenova/clip-vit-large-patch14) | Gallery search, duplicate detection, fallback suggestions. The int8 copy is `clip-vit-l14-v2` on the `models` release; the full-precision and text models come from Hugging Face. | `python/export_clip_model.py`, `EMBEDDING_MODEL_URL` in `packages/core/src/config.ts`, `packages/core/src/species/textEmbedding.ts` | MIT | Radford, A. et al. (2021) Learning Transferable Visual Models From Natural Language Supervision |
| [YOLOv8n](https://github.com/ultralytics/ultralytics) (Ultralytics) | Finding the animal in a photo before identification | Committed as `packages/core/src/species/models/yolov8n.onnx`; used by `packages/core/src/species/inference.ts` | AGPL-3.0 | Jocher, G., Chaurasia, A. and Qiu, J. (2023) Ultralytics YOLOv8 |

## Refresh cadence

`npm run refresh -w data-pipeline` is meant for about once a quarter, or whenever taxonomy
changes should reach installs. It queries the live sources (GBIF, Catalogue of Life,
iNaturalist, eBird, Wikipedia) for what has changed; GBIF occurrence downloads are reused unless
you pass `--refresh-occurrences`, and iNaturalist place lists are reused while younger than
`LIFER_INAT_CACHE_MAX_AGE_DAYS` (90 by default).

The static sources change rarely:

- **Mammal Diversity Database:** a new version roughly yearly. Check its Zenodo page, update
  `MDD_URL` in `fetch-mdd.ts`, delete `data/raw/mdd/`, and rebuild mammals
  (`npm run build-seed-mammals -w data-pipeline`).
- **eBird/Clements taxonomy:** a new version each year. Replace
  `data/reference/ebird-taxonomy.csv` from the eBird API's taxonomy endpoint, then run a refresh.
- **Traits, the Marine Regions layers and Natural Earth:** tied to one publication or release
  each. Only revisit when a new version supersedes one. For a new IHO Sea Areas or EEZ x IHO
  version, update the WFS URL in `fetch-iho-sea-areas.ts` or `fetch-eez-iho.ts` if the layer
  moves, delete `data/raw/iho-sea-areas/` or `data/raw/eez-iho/`, and follow "Replacing the sea
  zones" in [SCRIPTS.md](./SCRIPTS.md).

A rebuild that would remove a species needs the same check as a merge: make sure no user data
points at it. `load-seed.ts` inserts and updates species with `ON CONFLICT DO UPDATE` and never
deletes them.
