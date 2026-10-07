---
title: Data sources and credits
description: The open datasets, photos and models Lifer is built on, and how to credit them.
---

# Data sources and credits

Lifer stands on the work of scientists, naturalists and photographers who share their data openly. This page credits the sources behind the species catalog, checklists, maps and species matching, and the license each comes under.

The maintainer's reference, with where each source is used in the code, is [DATA_SOURCES.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/packages/data-pipeline/DATA_SOURCES.md). Bundled software is listed in [THIRD_PARTY_NOTICES.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/THIRD_PARTY_NOTICES.md).

## Species names and taxonomy

- **[GBIF](https://www.gbif.org/)** (Global Biodiversity Information Facility): the GBIF Backbone Taxonomy and common names. CC0. GBIF Secretariat, GBIF Backbone Taxonomy, [doi:10.15468/39omei](https://doi.org/10.15468/39omei).
- **[Catalogue of Life](https://www.catalogueoflife.org/)**: current names and synonyms. CC BY 4.0.
- **[eBird/Clements Checklist of Birds of the World](https://www.birds.cornell.edu/clementschecklist/)**, Cornell Lab of Ornithology: bird names and species codes.
- **[Mammal Diversity Database](https://www.mammaldiversity.org/)**: mammal taxonomy and common names. CC BY 4.0. [doi:10.5281/zenodo.15007505](https://doi.org/10.5281/zenodo.15007505).
- **[iNaturalist](https://www.inaturalist.org/)**: taxon changes, and species you add from iNaturalist.

## Checklists and rarity

- **[GBIF](https://www.gbif.org/)** occurrence records, from the thousands of institutions and projects that publish through it. Each record keeps the license its publisher chose (CC0, CC BY or CC BY-NC).
- **[iNaturalist](https://www.inaturalist.org/)** research-grade observations, place checklists and establishment status, from its community of observers and identifiers.
- **[eBird](https://ebird.org/)**, Cornell Lab of Ornithology: bird checklists by region.
- **[FishBase](https://www.fishbase.se/)**: used to check which fish are vagrants in a country. Froese, R. and D. Pauly (eds.), FishBase.
- **[IUCN Red List of Threatened Species](https://www.iucnredlist.org/)**: conservation status. IUCN 2026. The IUCN Red List of Threatened Species. Version 2026-1. Accessed through [GBIF.org](https://doi.org/10.15468/0qnb58), CC BY 4.0. Lifer ships only each species' Red List category; see iucnredlist.org for the full assessments. Some statuses come from Wikidata (CC0).
- **[Wikipedia pageviews](https://pageviews.wmcloud.org/)**: how well known each species is, one input to rarity tiers.

## Species traits

- **AVONET**: Tobias, J.A. et al. (2022), Ecology Letters 25: 581-597, [doi:10.1111/ele.13898](https://doi.org/10.1111/ele.13898). CC BY 4.0.
- **EltonTraits 1.0**: Wilman, H. et al. (2014), Ecology 95: 2027. CC BY 4.0.
- **COMBINE**: Soria, C.D. et al. (2021), Ecology 102: e03344. CC BY 4.0.
- **Global bird abundance estimates**: Callaghan, C.T. et al. (2021), PNAS 118: e2023170118, [doi:10.5281/zenodo.4723365](https://doi.org/10.5281/zenodo.4723365). CC BY 4.0.
- **Global depth range of marine fishes** (2023), Ecology and Evolution, [doi:10.6084/m9.figshare.20403111](https://doi.org/10.6084/m9.figshare.20403111). CC BY 4.0.

## Descriptions and photos

- **[Wikipedia](https://www.wikipedia.org/)**: species descriptions, habitat and range. CC BY-SA 4.0. Each species page links its description to the Wikipedia article it came from.
- **[Wikidata](https://www.wikidata.org/)**: links between species, photos and articles. CC0.
- **Reference photos** come from **[iNaturalist](https://www.inaturalist.org/)** and **[Wikimedia Commons](https://commons.wikimedia.org/)**. Every photo belongs to its photographer, under the license they chose. The photographer's credit is shown with each photo in Lifer. Offline packs only include photos whose license allows sharing them: CC0, public domain, and every Creative Commons license (including the no-derivatives ones: Lifer only resizes photos). The NC ones may only be shared non-commercially, as Lifer does. For species whose photos can't be shared that way, your own Lifer downloads one from iNaturalist for your personal viewing, as opening it on iNaturalist would, with its credit and license; it's never redistributed. See [Photos packs can't include](./settings.md#withheld-photos).

## Maps and regions

- **[Natural Earth](https://www.naturalearthdata.com/)**: country and province boundaries. Public domain.
- **IHO Sea Areas**: the sea zones used for fish and marine packs. Flanders Marine Institute (2018). IHO Sea Areas, version 3. Available online at [https://www.marineregions.org/](https://www.marineregions.org/), [doi:10.14284/323](https://doi.org/10.14284/323). CC BY 4.0. Lifer simplifies each area's outline and leaves out the oceans; see [Marine Regions](https://www.marineregions.org/) for the current version.
- **[WoRMS](https://www.marinespecies.org/)**: which fish and marine mammals live in the sea, in brackish water or only in fresh water, used to keep sea zone checklists to sea species. WoRMS Editorial Board (2026). World Register of Marine Species. Available from [https://www.marinespecies.org](https://www.marinespecies.org), [doi:10.14284/170](https://doi.org/10.14284/170). CC BY 4.0.
- **The intersect of the Exclusive Economic Zones and IHO sea areas**: each country's part of an ocean, the sea zones for coasts on open ocean. Flanders Marine Institute (2024). The intersect of the Exclusive Economic Zones and IHO sea areas, version 5. Available online at [https://www.marineregions.org/](https://www.marineregions.org/), [doi:10.14284/699](https://doi.org/10.14284/699). CC BY 4.0. Lifer uses only the oceans' national parts, with simplified outlines.
- **The offline map** is a [Protomaps](https://protomaps.com/) basemap built from [OpenStreetMap](https://www.openstreetmap.org/copyright) data. © OpenStreetMap contributors, available under the Open Database License.

## Species matching models

- **[BioCLIP 2](https://huggingface.co/imageomics/bioclip-2)**, by the Imageomics Institute: species identification. MIT license. Gu, J. et al. (2025), BioCLIP 2: Emergent Properties from Scaling Hierarchical Contrastive Learning, [doi:10.57967/hf/5765](https://doi.org/10.57967/hf/5765).
- **[CLIP ViT-L/14](https://github.com/openai/CLIP)**, by OpenAI, in the ONNX conversion by [Xenova](https://huggingface.co/Xenova/clip-vit-large-patch14): Gallery search and duplicate detection. MIT license. Radford, A. et al. (2021), Learning Transferable Visual Models From Natural Language Supervision.
- **[YOLOv8n](https://github.com/ultralytics/ultralytics)**, by Ultralytics: finding the animal in a photo. AGPL-3.0, the same license as Lifer.

## Thank you

To everyone who has uploaded an observation, identified someone else's photo, curated a checklist or published a dataset: Lifer wouldn't exist without you. If you spot a missing or wrong credit, please [open an issue](https://github.com/Sparklysparkspark/lifer-app/issues).
