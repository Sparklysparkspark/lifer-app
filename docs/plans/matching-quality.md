# Species matching quality by taxon class

Measured 2026-11-12 on the dev catalog (57,117 species with identification vectors) and on 306 of the
maintainer's labelled Belize field photos. Raw reports: `docs/plans/assets/matching-quality/*.json`.

## How it's measured

`npm run benchmark-matching -w data-pipeline` (one resumable command; caches in `data/matching-benchmark`):

- Samples up to 300 species per taxon class (seeded), and one gallery photo of each.
- Runs the photo through the import path: detector, subject crop and whole frame, the
  identification model (BioCLIP 2), then the production ranking
  (`rankCandidates` in `packages/core/src/species/suggest.ts`).
- Leaves the photo and near copies of it (cosine 0.95 or more) out of its own species' references.
- Two views: against every catalog species ("global"), and within the Belize checklist with the true
  species added ("regional"). The regional view is optimistic for species outside Belize, since they
  compete with about 1,500 mostly bird species.
- Options for diagnosis: `--vectors=whole|centre|crop|unsure` (`unsure`: the frame only when the
  detector is unsure, the rule before 2026-11-14), `--model=clip`, `--ensemble`,
  `--portraits-only`, `--references`, `--small` (each photo shrunk into a canvas 4x its size, over a
  blurred copy of itself, so the animal fills about 6% of the frame).

Catalog photos are mostly well framed portraits, so they understate how hard field photos are. The
Belize replay (real RAW previews, labels from sidecars and folders) is the check on real photos.

## Results (top-1 / top-5, %)

Current matching (bundled YOLOv8n detector), and the alternatives tried:

| Class | Global | Regional | Whole frame only (global) | Small subject (global, 100 per class) |
|---|---|---|---|---|
| Fish | 36.3 / 57.7 | 76.3 / 91.7 | 37 / 63.3 | 23 / 45 |
| Amphibians | 43 / 69.3 | 92.3 / 96.3 | 42 / 70 | 33 / 51 |
| Birds | 68 / 87.3 | 93.3 / 97.3 | 67.3 / 88.3 | 71 / 86 |
| Cephalopods | 28.7 / 53.2 | 83 / 96.8 | 29.8 / 59.6 | 25.5 / 44.7 |
| Corals | 50.9 / 76.3 | 85.1 / 99.1 | 57 / 82.5 | 22 / 47 |
| Crustaceans | 41 / 66.3 | 90.7 / 96 | 42.7 / 72.3 | 24 / 42 |
| Echinoderms | 56.2 / 77.1 | 87.6 / 97.4 | 60.8 / 79.7 | 31 / 53 |
| Jellies and anemones | 53 / 77.9 | 84.6 / 94.6 | 57.7 / 79.9 | 32 / 55 |
| Mammals | 36 / 61.3 | 79 / 92 | 39 / 63.7 | 26 / 56 |
| Marine mollusks | 48.7 / 71 | 86.7 / 94.7 | 53.3 / 77 | 40 / 64 |
| Nudibranchs | 65.4 / 86.6 | 93.6 / 95.3 | 64.8 / 89.6 | 48 / 68 |
| Sponges, tunicates, other | 43.7 / 65 | 77.3 / 90 | 46.7 / 70.7 | 17 / 34 |
| Lizards and snakes | 51.3 / 79.3 | 93.3 / 98 | 51.7 / 78.7 | 33 / 55 |
| Turtles | 51.9 / 77.9 | 85.6 / 97.1 | 53.8 / 79.8 | 42 / 69 |
| **All** | **48.4 / 71.9** | **86.7 / 95** | **50.1 / 75.3** | **33.4 / 55** |

Insects and other land invertebrates aren't in any pack, so they aren't measured.

Real photos (306 labelled Belize photos, regional ranking with bursts pooled): **top-1 278 (90.8%),
top-5 294**, 226 confident picks of which 2 were wrong.

## Why reptiles (and fish, amphibians, invertebrates) were weak

| Cause | Finding | Action |
|---|---|---|
| Fewer reference photos | Not equal data. Vectors per species: lizards and snakes median 1 (mean 1.7, 86% of species have 1 to 3), amphibians median 1 (mean 1.6), fish median 2 (mean 2.9), birds median 3 (mean 3.5). | The main lever. More gallery photos for herps, fish and marine invertebrates at the next catalog republish. |
| Look-alike species | 48.7% of reptile photos miss top-1 globally: 23.7 points right genus but wrong species, 14 wrong genus in the right family, 10.3 wrong family, 0.7 wrong class. Fish, amphibians and crustaceans look the same. | Genus or family fallback (below). |
| Wrong crop | The bundled detector finds the subject in only 56% of reptile photos. On catalog photos that costs little: whole frame alone scores 51.7 / 78.7 vs 51.3 / 79.3. On real photos a tiny camouflaged subject is missed and the frame decides (the Green Iguana reads as a parrot). | No detector change helped (next section). |
| Reference photos that aren't the animal | Rare: 0.2% for lizards and snakes, 0.4% amphibians, 2.1% fish, 4.4% mammals. | No change; nothing to gain. |
| Model | CLIP alone: 8.8% top-1 overall, 6% for lizards and snakes. Best blend (BioCLIP 0.8, CLIP 0.2): 47.6 / 72.7 vs 46.8 / 72.2, within noise. | BioCLIP stays alone. |
| Bias toward birds | Under 1.5% of non-bird photos get a bird as top pick, whole frame or crop. | None needed. |

## Animal detector (MegaDetector v6): not adopted

Tried as a replacement for the bundled detector (finds any kind of animal, Apache-2.0 RT-DETR "c"):

| | Bundled detector | MegaDetector v6 |
|---|---|---|
| Catalog, global top-1 / top-5 | 48.4 / 71.9 | 44.3 / 68.7 |
| Catalog, small subject | 33.4 / 55 | 24.5 / 46.1 |
| Real Belize photos, top-1 / top-5 | 278 / 294 | 278 / 299 |
| Real Belize photos, confident wrong | 2 of 226 | 3 of 226 |

Its tighter crops match the whole-frame reference vectors worse, even for small subjects, and real
photos come out level. The code that reads it stays (`readAnimalDetector` in `inferenceWorker.ts`,
`detectorModel.ts`, `python/export_detector_model.py`) so a future checkpoint can be tried by placing
`megadetector-v6c-v1.onnx` in the models folder; installs don't download it and nothing is published.

## Genus or family fallback

When the top species isn't confident, the closest candidates vote by genus, else family (softmax over
the top 10 scores, temperature 0.01, 70% share, at least two members). The top suggestion then carries
`probably: { rank, name, taxonClass }` (additive API field; the UI shows "Probably a Lithobates" style
labels). Measured right: 90% of the time it's offered on catalog photos (offered on about 60% of
photos globally), 84% on the real Belize photos (57 of 68).

## Photos with no animal

A nearest neighbour always returns some species, so a river came back as a manatee and a bus as a
primate. Changes in `apps/api/src/species/wildlifeCheck.ts`:

- More things that aren't wildlife for CLIP to compare with: buses, trucks, boats, abandoned vehicles,
  houses, ruins, signs. Sea, beach, rocks, clouds, roofs and mangrove river prompts were tried and
  dropped: they flagged reef animals (corals, starfish) the detector can't see.
- `animalEvidence`: the detector found an animal, or the photo reads as one. A photo that reads mostly
  as water, a landscape or a vehicle needs the detector's word; plants don't count (a bird deep in
  foliage often escapes the detector).
- `unsureWithoutAnimal` (import path): with no animal evidence, or a "not wildlife" or "maybe" flag,
  the top suggestion is never confident and offers no genus. Species are still listed.

Calibration (`npx tsx apps/api/scripts/calibrate-subject-check.ts`), on 3,312 catalog animal photos
(bundled detector readings) and the 306 real Belize photos:

| Photos | Flagged not wildlife | Asked "maybe" | Confidence removed |
|---|---|---|---|
| Birds, mammals, reptiles, turtles, amphibians, fish | 0% | 0% | 0 to 1% |
| Corals / echinoderms / sponges and tunicates | 7% / 5.9% / 6.7% | 0.9% / 1.3% / 0% | 0.9% / 2.6% / 2.7% |
| Real Belize photos | 0.3% | 0% | 0.3% |
| Belize landscape (6F9A0085) | flagged "a landscape" | | |

The flag columns are identical to the check before these changes (the marine flags were already
there); only the confidence cap is new. No labelled non-animal photos were available beyond the one
landscape (the false-positive list was all animals), so buses and rivers are covered by unit tests only.

## The five problem photos (final code)

| Photo | Result |
|---|---|
| 6F9A6348 Green Iguana | Still wrong: White-Fronted Parrot, not confident, "probably Amazona". No detector finds the iguana. |
| 6F9A7447 Least Sandpiper (blurred) | Right, confident. |
| 6F9A9283 Prothonotary Warbler | Still wrong: Tropical Parula, confident. The detector misses the small bird. |
| 6F9A9684 Sungrebe | Right, confident. |
| 6F9A0085 landscape | Flagged "a landscape"; the manatee guess is no longer confident. |

## Limits and next steps

- More reference photos per species for herps, fish and marine invertebrates is the biggest win.
- The 1620 px RAW preview limits small subjects; a larger preview would help the detector.
- Two Veined Frog froglets are read as insects and lose their suggestions. Keeping them when a
  reptile or frog ranks high was tried and dropped: neither frog had Veined Frog in its top five, and a
  real grasshopper would have kept lizard suggestions.
- Video suggestions don't run the no-animal check.

## Gallery coverage and per-class accuracy

Measured 2026-11-14, after the gallery top-up pilot (`next-catalog-republish.md` item 5g). The question:
why did mammals barely gain, and what keeps each group below birds?

### Setup

- Every Belize checklist species (1,550) got its most-voted research-grade iNaturalist photos, using the
  top-up's rule (publishable licences, one photo per observation, portrait check). Pools held up to 14
  photos (10 for birds). Vectors came from the same models as the catalog.
- Held-out photos: 1,274 scored, one per species, CC0 or CC BY, each from an observer with no photo in
  the pool, so no held-out photo is a reference. Taken at random, not by votes, so they are harder than
  the pilot's.
- Scored with the app's formula (checked against `rankCandidates`: 45 of 45 agree). World-wide = all
  57,117 species. Regional = the Belize checklist with its vagrant and tier factors, as the app ranks.
- **Fair** means every Belize species gets the same top-up, not only the one being tested. The pilot
  topped up only the test species, so each gained extra photos to match against while its rivals
  didn't. Scoring keeps a species' best match, so that alone lifts its rank.
- Scratch only: no catalog writes; the images and vectors were deleted afterwards.

### Results (top-1 / top-5, %)

| Group | n | World-wide before | World-wide top-up to 6, fair | Regional before | Regional top-up to 6, fair | Regional top-up to 6, unfair |
|---|---|---|---|---|---|---|
| Birds | 601 | 77 / 93 | 79 / 94 | 88 / 96 | 90 / 97 | 90 / 97 |
| Marine mollusks | 41 | 59 / 90 | 76 / 90 | 93 / 98 | 90 / 98 | 93 / 98 |
| Lizards, snakes | 76 | 47 / 71 | 61 / 80 | 78 / 96 | 80 / 97 | 88 / 97 |
| Fish | 284 | 52 / 76 | 55 / 77 | 75 / 93 | 75 / 94 | 78 / 94 |
| Crustaceans | 56 | 43 / 66 | 50 / 77 | 71 / 89 | 70 / 95 | 75 / 95 |
| Sponges, tunicates | 35 | 37 / 63 | 51 / 86 | 63 / 91 | 71 / 89 | 80 / 91 |
| Corals | 27 | 30 / 74 | 44 / 74 | 56 / 78 | 56 / 81 | 67 / 85 |
| Mammals | 78 | 42 / 73 | 47 / 77 | 71 / 90 | 69 / 91 | 72 / 91 |
| Mammals: bats | 35 | 31 / 57 | 34 / 63 | 49 / 83 | 46 / 83 | 51 / 83 |
| Mammals: other than bats and rodents | 33 | 52 / 88 | 58 / 91 | 88 / 94 | 88 / 97 | 88 / 97 |
| **All** | 1,274 | 61 / 83 | 66 / 86 | 80 / 94 | 82 / 95 | 84 / 95 |

Amphibians (24), echinoderms (13), jellies (17), turtles (12), cephalopods (5) and nudibranchs (5) are
too few in Belize to rank; they are in the raw tables only.

**How much of the pilot's gain is real.** On the 822 species the pilot rule would top up (under 5
photos):
- World-wide: 56.4 to 65.5 unfair, 64.6 fair.
- Regional: 78.3 to 84.2 unfair, 81.5 fair.

So about half the regional gain was the extra-matches effect. Applied to the pilot, regional
62.6 to 74.1 becomes roughly 62.6 to 68.

The world-wide figure stays an upper bound. Here 69 to 77% of misses go to species outside Belize,
which weren't topped up. Of the pilot's 39.5 to 54, at most about 13 points survive, likely fewer once
every species gets photos.

### Why mammals didn't improve

- **They're mostly bats.** Belize mammals are 60 bats and 19 rodents of 113. Without bats, mammals
  match like birds (regional 88 / 97). Bats sit at 46 to 49 whatever is added.
- **They already had photos.** Mammals had a median of 5 vectors before (reptiles 1), so the pilot
  added about 3 per species against 5 for reptiles.
- **In the pilot, rivals got photos too.** 84 of 113 Belize mammals were topped up, so mammal queries
  never had the extra-match edge that birds (100 of 609 topped up) and reptiles had. Fair, mammals
  are flat or slightly down (regional 71 to 69).
- **Twenty misses reviewed (17 bats).** 8 were a tiny bat roosting on a wall, cave ceiling or crevice,
  2 a bat in a gloved hand. 7 were good close-ups of a near-identical relative (two spear-nosed bats;
  broad-nosed vs fruit-eating bats; ghost-faced vs long-tongued; cougar vs jaguar at night). 3 showed no
  animal (a footprint, an empty road, foliage).
- **Reference photos have the same problems.** They include bats in gloves, infrared camera-trap
  frames and an old photo with a person in it. Two misses were recent splits (Mexican vs Nine-banded
  Armadillo, Pallas's vs Northern Black Mastiff Bat), where the species look alike anyway.
- **Not the cause:** the detector found the subject in 73% of mammal photos (birds 78%, reptiles 46%),
  and cropping had no special cost for mammals.

### Levers tried (world-wide / regional top-1, all classes, fair)

| Lever | World-wide | Regional | Notes |
|---|---|---|---|
| Top-up to 6 (pilot rule) | 61 to 66 | 80 to 82 | Most of the real gain; sponges +8 and lizards +2 regional |
| Top-up to 10 | 68 | 81 | +2 world-wide over 6, nothing regionally |
| All 14 (birds 10) | 70 | 82 | As above |
| Diverse picks (by look, or by observer and month) | 68 | 81 to 82 | Same as most-voted; not worth a code option |
| Name weight 0.3 / 0.5 / 0.6 / 0.8 (now 0.7) | 65 / 68 / 69 / 67 | 78 / 81 / 82 / 81 | 0.7 is about right for every class |
| Always add the whole frame to the crop | 70 | 83 | +1 to 2 everywhere, fish and birds most |
| BioCLIP 0.8 + CLIP 0.2 | 68 | 82 | Mammals +5 world-wide (n 78, noise), fish and reptiles flat or worse |

What limits each group, regionally: fish, crustaceans, corals and sponges lose 11 to 15 points to
wrong-family picks (look-alike reef life) and gain most from the whole frame. Lizards and snakes lose to
wrong-genus picks (12%). Bats lose to tiny roosting bats and look-alike genera.

### Recommendations, ranked

1. Run the top-up at the pilot's target of 6 as planned (5 to 6 days, about 15 GB). Expect about +2
   regional and up to +5 world-wide, not the pilot's +11 / +14.
2. Always score the whole frame alongside the crop (+1 to 2 for all classes). It is an app ranking
   change, so it needs the maintainer's go-ahead.
3. Don't promise species-level answers for bats. Lean on the genus or family fallback, and keep bats
   out of confident picks. This needs no new data.
4. Skip a target of 10 (about +4 days, +10 GB, +2 world-wide only), diverse picks, a CLIP blend and any
   change to the name weight.

### What shipped (2026-11-14)

- **Whole frame always scored.** Suggestions rank from the subject crop and the whole photo; each
  species keeps its better match (the benchmark's `--vectors=both` rule, now its default). The crop
  still finds small subjects. Both vectors come from one worker job, and desktop clients always
  send the identification model's whole-photo vector. Catalog benchmark, 100 photos per class:
  world-wide 47.3 / 72.7 to 49.6 / 75.4, regional 86.8 / 95.5 to 89.7 / 97.4; no class lost
  top-1. Regional confident picks stay 99.2% right.
- **Bats are never a confident pick.** A top pick in order Chiroptera is marked not confident, so the
  import screen lists the candidates and offers "Probably a <genus or family>" when the vote allows.
  Species are still listed.
