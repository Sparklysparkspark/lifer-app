# Shared iNaturalist taxa: diagnosis and dry run

Dry run of `packages/data-pipeline/src/scripts/fix-shared-inat-taxa.ts` against the master
database (`lifer-app-postgres-1`, read only), 2026-10-19. Nothing was applied or published.
Every per-species decision is in `packages/data-pipeline/data/review/shared-inat-taxa.tsv`.

## The problem

228 iNaturalist taxon ids are each on 2 or more catalog species (479 species in all,
`is_other_taxa` excluded). The count was 222 when first found; catalog runs since added more.

| Group | Taxa shared | Species involved |
|---|---|---|
| Fish | 137 | 289 |
| Birds | 49 | 102 |
| Mammals | 21 | 46 |
| Reptiles | 14 | 28 |
| Amphibians, invertebrates | 7 | 14 |

In 170 of the groups, two or more members have the same main photo.

## Root cause

Two separate paths, both caused by name lookups that accept iNaturalist's lumps:

1. **The id.** `resolveRemovalRescues` in `src/regions/inatChecklist.ts` (province and country
   checklist builds) keeps a thinly-evidenced species if its name resolves to a taxon iNaturalist
   has in the place. It resolves with `is_active=any` and `matched_term`, so "Passerella
   unalaschcensis" resolves to Fox Sparrow (9156). It then wrote that id onto the species with no
   check that another species already held it. The same unchecked write is in the name backfill
   in `matchedSpeciesIdsForRegion`, in `compute-provinces-inat.ts`, and in the respelling links of
   `add-missing-species.ts`. Only `reconcile-species-names.ts` and `find-species-splits.ts`
   refused duplicates.
2. **The photos and text.** Enrichment (`packages/core/src/species/enrich.ts`) never reads
   `inat_taxon_id`. It searches by name (`fetchINaturalistTaxon`), and when there is no exact name
   it takes the taxon a committed iNaturalist taxon change lists the name as input for. A lumped
   name gets the lumped taxon, so its default photo, gallery and Wikipedia summary. Installs run
   the same code when a species page opens.

A third gap kept the bird cases from being caught. The catalog stage already writes birds that
eBird counts as a form of another catalog species to a review file. But `ebirdFormsByBinomial`
skipped bracketed groups such as "Passerella iliaca [unalaschcensis Group]", so it never flagged
Fox Sparrow's groups or the Hepatic Tanager groups.

## Classification

Each species in a group is either the **owner** (it keeps the taxon) or falls into one of the
categories below. The authority is eBird for birds and Catalogue of Life (COL, which GBIF
downloads use) for everything else.

The owner is chosen in this order:

1. the only member the authority accepts as a species;
2. otherwise the member named as iNaturalist names the taxon;
3. otherwise the member with that name as a synonym;
4. otherwise the most recorded member.

| Category | What it means | Action | Birds | Fish | Mammals | Reptiles, amphibians | Invertebrates | Total |
|---|---|---|---|---|---|---|---|---|
| (a) merge | The catalog splits it, but the authority counts it as a group of the owner | Merge into owner | 14 | 0 | 0 | 0 | 0 | 14 |
| (a) keep | Only iNaturalist lumps it; the authority accepts it as its own species | Keep, drop iNat link and borrowed media | 0 | 130 | 18 | 8 | 2 | 158 |
| (b) | iNaturalist has an active taxon under exactly its name | Move to that taxon | 3 | 8 | 6 | 4 | 3 | 24 |
| (c) | Synonym, respelling or genus move of the owner | Merge into owner | 33 | 11 | 0 | 4 | 0 | 48 |
| review | No clear verdict | Drop link only, list for review | 3 | 3 | 1 | 0 | 0 | 7 |

By group: 10 groups are bird groups merged by eBird, 48 hold a synonym, 23 have a wrong match
(one group has two), 140 have a species iNaturalist lumps that the authority keeps apart, and
7 need review.

Spot checks against the live iNaturalist API agree with the classification. For example,
Trichogaster lalius (taxon 114374) and Micropterus floridanus (355459) are inactive on
iNaturalist and lumped into T. fasciata and M. salmoides. COL still accepts both.

### Examples

**(a) merge, birds** (all 14):
- Passerella megarhyncha, P. schistacea and P. unalaschcensis into Passerella iliaca
- Piranga hepatica and P. lutea into Piranga flava
- Tachybaptus tricolor into T. ruficollis
- Pyrocephalus obscurus into P. rubinus
- Campethera cailliautii into C. maculosa
- Celeus grammicus into C. undatus
- Acrocephalus baeticatus into A. scirpaceus
- Ortygospiza fuscocrissa and O. gabonensis into O. atricollis
- Horornis vulcanius into H. flavolivaceus
- Camaroptera brevicaudata into C. brachyura

**(a) keep, non-birds:**
- Tachyoryctes daemon, ibeanus, ruandae and ruddi (iNaturalist lumps all of them into T. splendens)
- Kyphosus pacificus, lutescens and sectatrix
- Salvelinus umbla
- Kobus loderi
- Hypostomus, Astyanax and Aspidoras species (for example Aspidoras taurus, Astyanax altiparanae, Hypostomus nudiventris)

**(b) wrong match:**
- Formicarius moniliger to 1286941
- Bradypterus centralis to 1287028
- Chloropsis cochinchinensis to 12011
- Scotoecus albigula to 1431043
- Heteromys goldmani to 1639174
- Trachylepis albopunctata to 1545853

**(c) synonym or variant:**
- Milvus aegyptius into M. migrans
- Muscicapa tyrrhenica into M. striata
- Torgos tracheliotus into T. tracheliotos
- Pristis microdon into P. pristis
- Ephalophis greyi into E. greyae
- Flammeo marianus into Neoniphon marianus

**Review** (all 7):
- Arachnothera hypogrammicum, Turdinus crassus, Megapomatorhinus erythrogenys (birds where neither name is an eBird species)
- Nosferatu pratinus (COL: Herichthys pratinus)
- Eothenomys eleusis (COL: E. melanogaster)
- Colomesus tocantinensis (COL: Sphoeroides tocantinensis)
- Rasbora taeniata (COL doesn't know it)

## What the draft fix does

Nothing runs unless asked: the planner previews by default, and refresh applies it only with
`--fix-shared-inat-taxa`.

- **No more shared ids.** The four unchecked writers now skip an id another catalog species holds.
  A checklist rescue counts only if the species can take the taxon. If another species already
  holds it, the candidate is a duplicate and is not rescued.
- **No more borrowed media.** Enrichment, in the pipeline and on installs, ignores a found taxon
  that another catalog species holds.
- **Gate.** A new `shared_inat_taxon` gate check fails publishing while any taxon is shared.
- **eBird groups.** The form finder now reads bracketed eBird groups, so the existing review file
  flags cases like Fox Sparrow's groups.
- **The fixer, `fix-shared-inat-taxa.ts`.**
  - Plans every group as above.
  - Caches its lookups in `data/build/shared-inat-taxa-lookups.json`, so a rerun makes no network
    calls for names it has seen.
  - With `--apply`, under the reference-data lock:
    - moves (b) species to their own taxon;
    - unlinks the (a) keep and review species;
    - clears the photos, gallery rows, reference vectors and text they share with the owner, and
      resets `enriched_at` so enrichment looks again;
    - appends the (a) and (c) merges to `data/reference/species-merges.tsv`.
  - The catalog stage's existing merge step applies those rows with `applySpeciesMerges`, the same
    code installs run. Checklist rows and user records move to the owner, the old scientific name
    becomes a synonym, and the old common name an alias. "Sooty Fox-Sparrow" and "Slate-Colored Fox
    Sparrow" still find Fox Sparrow.

**Non-birds.** Merges follow COL, which is what GBIF downloads (and so checklist evidence) use.
If COL counts the name as the owner, it is merged. If COL accepts it as its own species, it stays
a separate species, because GBIF records still arrive under its name. It loses only the
iNaturalist link and borrowed media, since iNaturalist has no taxon for it. Merging those would
throw away species COL and GBIF keep. Keeping the link shows wrong photos and lets iNaturalist
confirm one species on behalf of the other.

## Before and after (dry run)

| | Count |
|---|---|
| Species merged away | 62 (14 bird groups, 48 synonyms) |
| Species gaining their own iNaturalist match | 24 |
| Species losing an iNaturalist link with none of their own | 165 (158 keep, 7 review) |
| Species losing borrowed photos | 147 |
| Species losing borrowed text | 72 |
| iNaturalist taxa shared afterwards | 0 |

Checklist species counts (whole list; birds in brackets):

| Region | Before | After | Change |
|---|---|---|---|
| Canada | 2,544 (779) | 2,542 (777) | Slate-colored and Sooty Fox Sparrow into Fox Sparrow |
| British Columbia | 1,626 (545) | 1,624 (543) | the same two |
| Costa Rica | 3,250 (968) | 3,247 (966) | Piranga hepatica and P. lutea into Hepatic Tanager; Synodus marchenae into S. lacertinus |
| Belize (country) | 1,558 (609) | 1,555 (607) | Piranga hepatica into Hepatic Tanager; Pyrocephalus obscurus into Vermilion Flycatcher; Flammeo marianus into Neoniphon marianus |

Unlinked species stay on their lists: 7 in Canada (for example Salvelinus umbla), 12 in Costa Rica,
5 in Belize.

**Fox Sparrow (9156).**
- Passerella iliaca keeps the taxon, as the only eBird species of the four.
- P. megarhyncha, P. schistacea and P. unalaschcensis merge into it: eBird counts them as Fox
  Sparrow's Thick-billed, Slate-colored and Sooty groups.
- British Columbia shows one Fox Sparrow card instead of three.

**Piranga (9924).**
- Piranga flava (Hepatic Tanager, eBird `heptan`) keeps the taxon.
- P. hepatica (also named Hepatic Tanager in the catalog) and P. lutea (Tooth-billed Tanager)
  merge into it, as eBird's Northern and Highland groups.

## Applying it

Review `data/review/shared-inat-taxa.tsv` first, then run from the repo root. Don't run it yet:
it publishes.

```
npm run refresh -w data-pipeline -- --stages=catalog,enrich,vectors,packs,gate,publish --fix-shared-inat-taxa --publish
```

What each stage does here:

- **catalog** applies the fix and the merges.
- **enrich** refetches media for the species it cleared.
- **vectors** embeds those photos.
- **packs**, **gate** and **publish** rebuild and ship the packs and the catalog seed.

The catalog stage also reruns its other steps (name reconciliation, missing species, IUCN).

## Open points

- **Installs keep borrowed gallery photos.** Installs replace the main photo from the seed but only
  ever add gallery rows, so unlinked species keep their borrowed gallery there. Removing them needs
  a gallery replace rule in `apps/api/src/species/catalogSeedUpdate.ts`, which this draft doesn't
  touch.
- **Unlinked species lose iNaturalist confirmation.** The 165 unlinked species are no longer
  confirmed by iNaturalist checklists. On the next regions rebuild they stay only on GBIF
  evidence, so some thin ones may drop off lists.
- **eBird taxonomy version.** The eBird taxonomy CSV in `data/reference` decides the bird calls.
  An older CSV would treat recent eBird splits as groups.
- **Uncategorised bird merges.** The 33 bird synonym merges ("not an eBird species") are the least
  checked category. Worth a skim in the review file.
- **Owner choice.** For COL-accepted spellings (greyi or greyae), the spelling COL accepts survives,
  even when iNaturalist uses the other one.
