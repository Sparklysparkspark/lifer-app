# Smart tags: general keywords, captions and alt text

Status: decisions made 2026-11-25 (below), build starting. Written 2026-11-25. Section "Measured" holds a small read-only experiment
run the same day on catalog reference vectors.

**Reviewer model:** Opus 5.5 reviews engine, models and accuracy, data and storage, and anything that writes files;
Sonnet 5.5 reviews docs, wording, simple UI and tests.

> **Calibration:** effort figures are conventional engineering time. Lifer's coding pace is far faster. Labelling
> photos, maintainer reviews and the eyeball checks do not compress.

## Decisions (made by the maintainer, 2026-11-25)

1. **Scope for 1.0: the broad vocabulary** (about 300 terms: things, events, activities, people detail, as well
   as the stored signals and wildlife-context terms). Every term still ships only if it passes the benchmark (the
   90 percent bar, held-out sessions), so the list that ships may be shorter than the list proposed.
2. **Keyword tree: under the facet** (`Habitat|Wetland`), not under one root.
3. **Writing into files: its own switch**, **Write smart tags into photo files**, off by default.
4. **Cloud models: none in Lifer's core, and no API key field in Settings either.** A `tags.suggest` plugin scope
   after 1.0 (ST-10) is the only route, and it is not part of 1.0.
5. **Local captioning model: left out for now** (ST-9 is cut). Alt text and captions are built from templates.

6. **Spelling follows region.** A UK, Canada, Australia or other UK-spelling region sees and writes `Colour`,
   `Behaviour`, `Grey tones`; a US (or unknown) region gets `Color`, `Behavior`, `Gray tones`. The term id and the
   canonical US path are the identity (decisions, rejections and sync use the id); display and written paths use the
   active spelling. Search synonyms always hold both spellings. File writing (ST-6) writes the path in the spelling
   active at the time and recognises either on read (`findSmartTagByPath`), so changing region never duplicates a
   tag. CLIP prompts stay US. The validator enforces that variants differ only by spelling.

## Why, and the scope test

The maintainer: "we have other smart features". What Lifer already knows about every photo, at search time only:

| Signal                                  | Stored where                                                     | Used today by                       |
| --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| CLIP L/14 vector, whole photo           | `capture_embeddings`                                             | Species suggestions, "looks like"   |
| Scene class shares (ADE20K, 150 labels) | scene model output (`sceneSummary.ts`)                           | Scene words: water, snow, sand...   |
| Colour shares                           | same pass                                                        | Colour words                        |
| Sun position from GPS and time          | computed (`gallery/sun.ts`)                                      | golden hour, sunset, night          |
| Style prompts                           | `STYLE_PROMPTS` in `packages/shared/src/searchTerms.ts`          | b&w, high key, bokeh, backlit...    |
| Shot type: action and framing           | `packages/shared/src/shotTypes.ts`, `stats/shotKinds.ts`         | Shot type filter, Stats             |
| Animal count                            | detector                                                         | `3 birds`, Number of animals filter |
| People present                          | YOLO person class plus CLIP prompts (`species/wildlifeCheck.ts`) | `birds without people`              |
| Species and taxonomy                    | captures                                                         | Everything                          |

None of it is visible on the photo, browsable as a list, or leaves Lifer inside the file. Smart tags make it so.
That is the whole case: browsable, reviewable words, keywords other apps can read, and alt text for accessibility.

Scope test:

- **Fits Lifer's goal?** Yes for wildlife-aware words (habitat, light, action, In hand, Captive) that make an archive
  findable and tell the story of a sighting. No for generic things and events (cars, food, weddings): Preen, Excire
  and Lightroom's own search own those.
- **Third party better?** Generic AI keywording: Excire, Peakto, an n8n plus LLM pipeline. None know the species, the
  sun position at the GPS point, or the shot type. Lifer can be more accurate on its own subject and nothing else.
- **No disappointing features.** Search already finds `heron in fog` without tags. Smart tags must not make search
  worse: search keeps reading the live signals, and tags only add.

## (a) What to tag

| Facet       | Terms (draft)                                                                                                                 | Source                                                                   | Ship rule                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Habitat     | Wetland, Open water, Coast, Beach, Forest, Grassland, Desert, Mountains, Snow and ice, Garden or town, Underwater, Coral reef | Scene shares first (5%+ of frame), CLIP to confirm; one or two per photo | Per term 90% on held-out                 |
| Time of day | Sunrise, Morning, Midday, Afternoon, Sunset, Night                                                                            | Sun position when GPS and time exist; nothing otherwise                  | Computed, no bar needed                  |
| Light       | Golden hour, Blue hour, Backlit, Silhouette, Overcast                                                                         | Sun position for the first two; CLIP (`STYLE_PROMPTS`) for the rest      | 90%                                      |
| Season      | Spring, Summer, Autumn, Winter                                                                                                | Date and latitude; none between the tropics                              | Computed                                 |
| Weather     | Snow falling, Rain, Fog                                                                                                       | CLIP plus scene shares                                                   | 90%; snow measured 0/8, likely cut       |
| Action      | Flying, Behaviour, At rest                                                                                                    | Existing shot type, unchanged                                            | Already shipped as a filter              |
| Behaviour   | Flying, Perched only (Preen: 99%/84% and 97%/38% on the animal crop)                                                          | Animal crop vector, re-measured on Lifer photos                          | 90%, else cut                            |
| Framing     | Close, Environmental                                                                                                          | Existing shot type                                                       | Already shipped                          |
| Group       | Pair, Group, Flock or herd                                                                                                    | Detector count (2, 3 to 9, 10+); exact counts stay a filter              | Detector precision                       |
| Context     | In hand, Captive, Specimen, Night flash, Camera trap                                                                          | CLIP pick-one with a "none" option                                       | 90%; In hand 8/8 and Specimen 7/8 so far |
| People      | People in photo (presence only)                                                                                               | Existing person check                                                    | 95%                                      |
| Colour      | Dominant colours (1 to 2)                                                                                                     | Stored colour shares                                                     | Computed                                 |
| Style       | Black and white, High key, Low key, Bokeh, Motion blur, Minimalist                                                            | Pixel check for b&w; CLIP for the rest                                   | 90%                                      |
| Subject     | Bird, Mammal, Reptile, Amphibian, Fish, Insect, Plant, Fungus, Landscape                                                      | CLIP pick-one; **only on photos with no species**                        | 90% (measured 89 to 97%)                 |

Not tagged: people counts, age, expression or identity; human activities and events; things (cars, food); mood; place
names (Lifer already has Places and writes IPTC location); behaviour beyond Flying and Perched; anything the species
system says better (no "Bird" on a photo identified as a heron).

## (b) Engines

| Engine                                                         | Verdict                       | Why                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored signals (scene, sun, date, colour, detector, shot type) | **Build first**               | Free, offline, already computed, mostly deterministic. Many facets need no model at all.                                                                                                                                |
| Local CLIP vocabulary scoring                                  | **Build, gated**              | Uses stored vectors; 40 terms score in 0.02 ms a photo, so 100,000 photos take about 2 s. Raw zero-shot is weak on scenes (Preen: 58% mixed), so every term needs a fitted threshold, a "none" option or a signal gate. |
| User-supplied cloud vision model                               | **Not in core; plugin later** | Conflicts with the privacy page ("your photos never leave it"), needs a key (setup), fails offline. A `tags.suggest` plugin scope keeps it the user's choice and the user's code.                                       |
| Local captioning model (VLM)                                   | **Later, only if needed**     | Big download, seconds per photo, invents details. Template alt text covers the accessibility need first.                                                                                                                |

### Cloud, if decision 4 goes the other way

Rules the n8n workflow already follows and Lifer would keep: opt-in per library, never default, a clear statement of
what is sent (one 480 px JPEG preview per photo, no GPS, no file name), batches of up to 200 with a daily cap, the
same controlled vocabulary with usage descriptions sent as the instruction, output validated against the vocabulary,
results land as suggestions in the review queue, never straight into files.

Rough cost with GPT-5 mini (list prices as last known, $0.25 per million input tokens and $2 per million output;
check before quoting): a 480 px image is about 250 input tokens, the vocabulary with descriptions about 6,000 tokens
(cached after the first call), output about 250 tokens with a caption and alt text. About **$0.70 to $1.80 per 1,000
photos**, so $70 to $180 for a 100,000-photo library. Cheap; the obstacles are privacy and setup, not money.

### Local captioning candidates (decision 5)

All unmeasured here (no download was made, to avoid competing with the gallery top-up). Speeds are estimates for a
recent Apple silicon CPU and must be measured in ST-0.

| Model                                        | Licence (weights) | Size                   | Speed estimate     | Runtime fit                                                                                                      |
| -------------------------------------------- | ----------------- | ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Florence-2 base (Microsoft)                  | MIT               | 0.23B, about 300 MB q8 | 0.5 to 2 s a photo | transformers.js, which Lifer already ships. Fixed tasks (caption, detailed caption), cannot follow a vocabulary. |
| SmolVLM 256M or 500M Instruct (Hugging Face) | Apache-2.0        | 250 to 550 MB q8       | 1 to 4 s a photo   | transformers.js. Follows an instruction, so it can be given the vocabulary.                                      |
| moondream2 (2025 releases)                   | Apache-2.0        | 1.9B, about 1 GB int4  | 3 to 10 s a photo  | Needs its own runtime; best captions of the three.                                                               |

Excluded: Moondream 3 (BUSL), Gemma 3 and PaliGemma (Gemma terms), LLaVA (Llama licence, non-commercial data),
Qwen2.5-VL 3B (Qwen research licence), BLIP-2 with OPT (OPT licence). Training data of the three candidates is mixed
web and generated data; the weight licences are compatible with AGPL non-commercial use.

Shipping: a **Captions** row in Settings > Offline data, not downloaded by default, like the optional animal detector.
Never told to name animals: the species slot always comes from Lifer. Runs as a background job, one photo at a time,
paused while importing.

## (c) Captions and alt text

- **Alt text, from a template, no model.** `{species} {action} {habitat}, {time}` filled from the species and
  accepted (or computed) tags: "Great Blue Heron standing in a wetland, sunrise." A slot left empty drops out, as the
  caption templates already do. Computed on the fly, so nothing to store until the user edits it.
- **In the app:** every photo `<img alt>` uses it (today it is the species name or nothing). Cheap and real
  accessibility work.
- **Captions:** Lifer already writes `dc:description` from a template with write rules (Fill if empty, Replace what
  Lifer wrote, Add, Don't write). Add tokens `{habitat}`, `{action}`, `{light}`, `{timeofday}`, `{season}`,
  `{smarttags}` and `{alttext}` to that system. No second caption feature.
- **Editing:** an Alt text field in the viewer's Info panel. An edited value is stored on the capture
  (`alt_text`, `alt_text_edited`) and wins over the template from then on.
- **Files:** `Iptc4xmpCore:AltTextAccessibility` (lang-alt, x-default), written only when decision 3's switch is on,
  with the same ownership record as captions so text typed in another app is never replaced.
- **Sync:** the two new capture columns ride the existing captures sync (updated_at, newest edit wins). Template alt
  text is not synced; each side computes it.
- **When:** alt text on demand (render time); captions on the existing triggers (import, species or place change,
  Apply to all).

## (d) Search

- Accepted smart tags are photo tags, so `a tag you added` search, Filters > Tag and the Tags page work unchanged.
- Each vocabulary term carries synonyms (Wetland: marsh, swamp, bog, fen), added to the shared search terms so
  `marsh` finds accepted Wetland tags. English only, like the rest of search (one label per id, so translation is a
  later label swap).
- Search keeps reading the live signals for photos without accepted tags. Unreviewed suggestions are not searched:
  they are the same signals with a threshold, and search already ranks those.
- Later and optional: when a typed word is a vocabulary term, use that term's fitted threshold instead of the
  generic "looks like" cut-off. Only if it measurably helps.

## (e) Review UX

- **Smart tags strip** in the viewer's Info panel under Tags: suggested chips (outlined) and accepted chips (filled).
  Click accepts, a small x rejects ("Not this photo"), a menu offers "Never suggest Wetland". Each chip shows its
  facet on hover ("Habitat"). Keyboard: the shared keymap, no new shortcuts without a Preen match.
- **Review smart tags**, a page reached from the Tags page and from the job's finish toast, organised **by tag, not by
  photo** (design for extremes: 100,000 photos times 3 suggestions is not reviewable one photo at a time). One row
  per term: "Wetland, 4,212 photos". Open a term: a photo grid of its suggestions, strongest first, everything
  selected; deselect the wrong ones, then **Accept 4,180**. Select, Shift-click and drag as in the Gallery.
- **Accept all for a facet** for computed facets (Time of day, Season) that need no review, one click per facet.
- **Undo:** every accept or reject batch is one undo step, with Undo on the toast. Navigation always wins; work is
  applied as it is clicked.
- **Marker:** a photo whose suggestions have been reviewed shows "Smart tags reviewed" in Info; in files, the
  keyword `Lifer:Smart tags` (beside the existing `Lifer:Cover`) lets other apps filter, like the n8n "ai-tagged".
- **Background job:** the suggestion pass runs after vectors and scene shares exist, in the progress tray, never
  blocking. A vocabulary or calibration bump reruns it from stored data (seconds), never the image models.
- **Vocabulary settings** (Settings > Smart tags): facet switches, hidden terms with restore, rename a label (id kept),
  and **Add a tag** with a name, a usage description ("Wetland: marsh, swamp or reed bed fills much of the frame, not a
  puddle") and example phrases. The description is shown in the strip's hover, and its phrases become the CLIP prompts.
  A user-added term has no fitted threshold, so it suggests only strong matches and says "Not measured".

## (f) Where tags are written

- **DB first.** Suggestions live in a derived, rebuildable table
  `capture_smart_suggestions (capture_id, term_id, score, vocab_version)`, not synced (each side recomputes).
  Decisions live on captures: accepted labels join `captures.tags`; rejected term ids in
  `captures.smart_tags_rejected text[]`. Both ride the existing sync.
- **Files only with the switch on** (decision 3), and only where tags already go: managed files, plus linked-folder
  sidecars only when "Also write keywords next to linked files" is on. Suggestions are never written.
- **Backup before the first write:** before Lifer first writes smart tags into a file, it stores that file's prior
  `dc:subject`, `lr:hierarchicalSubject`, `dc:description` and alt text in `capture_metadata_backups`.
  **Restore keywords as they were** (per photo or selection) writes them back. A DB copy instead of `.bak` files keeps
  folders clean and scales to 100,000 photos; sidecars Lifer did not make are never touched anyway.
- **Validator** at write time and on every accept: label from the vocabulary or a user-added term; 1 to 64
  characters; no `|`, commas, control characters or leading and trailing spaces; never equal to a catalog common or
  scientific name or code (a build test, so "Swift", "Kite" or "Seal" can never be a tag); no duplicates within a
  photo; parents added once. A bad tag is dropped and logged, never written.
- **Ownership:** Lifer records which keywords it wrote (as it does for `Lifer Tags|`), so a later write or a reject
  removes only its own.

## (g) Benchmark plan

- **Set A, supplied by the maintainer:** about 1,000 of their photos from at least 30 separate sessions, chosen to
  cover the facets: wetlands, forest, coast, snow, night, underwater, in-hand herping, zoo and aquarium, landscapes
  with no animal, phone shots. Copied to a scratch folder outside the library and the app database. Labelled in a
  small labelling page: each photo shows the vocabulary with suggestions pre-ticked, the labeller fixes ticks and
  notes misses.
- **Set B, catalog reference vectors** (as in "Measured"): one photo per species, labels from species metadata, for
  Subject and Context terms. Read-only SELECTs on the Docker `lifer` catalog DB. Fitted values from Set B are
  iNaturalist-derived and stay in Lifer; they never go to Preen.
- **Splits by whole session** (Set A, by scene groups and day) or **whole species** (Set B), never by frame, so bursts
  never sit on both sides. Fit on one half, report on the other.
- **Fit target 95%, ship bar 90%.** The experiment lost about 4 points from fit to held-out at a 90% fit target.
- **Bars:** each shipped term at least 90% precision on held-out with at least 50 predicted positives (fewer means
  "not measured", not shipped); People in photo 95%; alt text sentences fully correct on 90% of 200 judged photos;
  at least one useful tag on 70% of photos.
- **Shipped only if they pass:** every CLIP term, every Context term, Weather, Behaviour (Flying, Perched), Light
  terms not computed from the sun. Computed facets (Time of day, Season, Colour, b&w) ship on unit tests.
- **Eyeball check:** a contact sheet of a whole trip judged by the maintainer before any UI work.

## (h) Vocabulary

- **Original, small, nature-first.** About 70 terms in v1 (the table in (a)), each with a stable id, an English label,
  a facet path, a usage description, synonyms and 1 to 3 prompt phrases. Data, not code:
  `packages/shared/src/smartTags/vocab.json`.
- **From Preen's vocabulary** (the maintainer's own work, allowed): take the Place|Nature terms, Light, Weather and
  Style as a starting list and their prompt-ensemble idea, re-written in Lifer's stack. Drop Urban places, Things,
  Activity, Event, People detail and Mood. Re-prompt for wildlife ("a wildlife photo of {} habitat") and merge with
  Lifer's own `STYLE_PROMPTS` and scene words so one list feeds both tags and search.
- **Hierarchy:** facet roots are containers, never written flat. A leaf writes itself and its non-root parents to
  `dc:subject` and the full path to `lr:hierarchicalSubject`, Lightroom style: `Habitat|Wetland`, `Light|Golden hour`.
- **Species stay separate.** `Species|Class|Family|Name` is unchanged and remains the only home of animal names.
  Subject terms (Bird, Mammal) appear only on photos with no species, and are removed when a species is confirmed.
- **Localisation:** English only, like search. Ids make a later translation a label swap; CLIP prompts stay English.

## Measured (2026-11-25, read-only)

Scratch script in the session scratchpad; no app code, no catalog writes, no network.

- **Data:** 1,856 catalog reference gallery vectors (CLIP L/14, `clip-vit-l14-v2`, already stored), one photo per
  species, 18 labelled groups from taxonomy (bird, fish, mammal, frog, salamander, snake, lizard, turtle, crustacean,
  sea snail, sea slug, jellyfish, anemone, starfish, urchin, coral, cephalopod, sponge). The local catalog has no
  plant or insect galleries, so Flower and Insect could not be labelled.
- **Terms:** 40 (18 labelled subjects, 22 unlabelled context and scene terms), 159 prompts (3 templates each,
  synonyms averaged), Lifer's own int8 text encoder.
- **Cost:** text encoder loads in 0.24 s, all 159 prompts embed in 0.39 s, scoring is 0.022 ms a photo for 40 terms.

| Method (subject terms only)                        | Set                    | Precision     | Recall |
| -------------------------------------------------- | ---------------------- | ------------- | ------ |
| Raw top-1 of all 40 terms                          | 198 photos             | 87.7%         | 79.3%  |
| z of 2 above each term's mean (Preen prototype)    | 198 photos             | 94.7%         | 54.5%  |
| Pick-one with a "none" option, winner at least 50% | 198 photos             | 90.2%         | 83.8%  |
| Pick-one with "none", 50%                          | 889 held-out species   | 89.3%         | 84.1%  |
| Pick-one with "none", 90%                          | 889 held-out species   | 97.4%         | 66.4%  |
| Per-term threshold fitted to 90% on the other half | fit 967 / held-out 889 | 90.8% / 86.9% | 53.2%  |

- Two terms never reached 90% at any threshold (sea snail, sponge); the weakest that did were anemone 7/12 and coral
  8/12. Errors are look-alikes: salamander and lizard, anemone, urchin and coral.
- **Context terms, eyeballed** (8 photos each, spread across the hits at z 2): In hand 8/8, Specimen 7/8,
  Drawing 7/8, Night about 6/8, Dead about 4/8, Flowers 3/8 (anemones and corals read as flowers), Snow 0/8 (white
  rock), Flying 0/8 on the whole frame (bats hanging, wings spread). Eight photos is a hint, not a measurement.
- **Reading:** subject-level words on centred reference photos are CLIP's easy case and reach the bar with a
  "none" option and a strict cut. Scene and weather words do not come for free (Flowers, Snow), which is why scene
  shares and the sun come first. Flying needs the crop, as Preen found. Reference photos are not the user's photos:
  Set A decides.

## Phases

| #     | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Model                     | Effort | Depends on       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------ | ---------------- |
| ST-0  | **Built 2026-11-25** (`npm run label-smart-tags` and `npm run calibrate-smart-tags -w data-pipeline`, see `packages/data-pipeline/SCRIPTS.md`; catalog bootstrap: Bird, Mammal, Reptile, Amphibian, Marine invertebrate pass). Labelling page and Set A import (scratch, outside the library); calibration tool fitting per-term thresholds by session halves; benchmark report                                                                                    | opus                      | M      | Decision 1       |
| ST-1  | **Built 2026-11-25** (279 terms, `packages/shared/src/smartTags/`, validator tests in `packages/core/src/smartTags/`; all CLIP terms start unvalidated and off). Vocabulary v1 as data with ids, paths, descriptions, synonyms and prompts; species-name collision test; validator with tests                                                                                                                                                                      | sonnet build, opus review | S      | ST-0             |
| ST-2  | **Built 2026-11-25** (engine `packages/core/src/smartTags/suggest.ts`, pass and `GET /api/smart-tags/status` in `apps/api/src/smartTags/`, migration 207; computed facets on, CLIP terms only where the calibration validates them; suggestions stored only). Suggestion pass: computed facets (sun, season, colour, detector, shot type, people), scene shares, CLIP pick-one and thresholds; derived table; background job; version bump reruns from stored data | opus                      | M      | ST-1             |
| ST-3  | **Built 2026-11-25** (migration 208, `apps/api/src/smartTags/decisions.ts` and `routes.ts`; accepted tags at the US facet path with a `smart_tags_accepted` marker, kept out of files until the ST-6 switch; removing one rejects it; hidden terms sync as a set; undo tokens last an hour; the pass is a silent job). Decisions storage (`captures.tags`, `smart_tags_rejected`), hidden terms, accept and reject routes with batch undo; sync of the new column  | opus                      | S      | ST-2             |
| ST-4  | Smart tags strip in the viewer; Review smart tags page by term; Settings > Smart tags; HIG screenshot review against `ux-rules.md`                                                                                                                                                                                                                                                                                                                                 | sonnet build, opus review | M      | ST-3             |
| ST-5  | Search synonyms for vocabulary terms in the shared search terms                                                                                                                                                                                                                                                                                                                                                                                                    | sonnet                    | S      | ST-3             |
| ST-6  | File writing behind the switch: facet tree, `Lifer:Smart tags` marker, ownership, `capture_metadata_backups` and Restore; Lightroom and Bridge round trip                                                                                                                                                                                                                                                                                                          | opus                      | M      | ST-3             |
| ST-7  | Template alt text in every `<img alt>`; Alt text field and columns; new caption tokens; `AltTextAccessibility` write                                                                                                                                                                                                                                                                                                                                               | sonnet build, opus review | S      | ST-3, ST-6       |
| ST-8  | Docs: a Smart tags guide, the metadata and other-apps pages, privacy page line                                                                                                                                                                                                                                                                                                                                                                                     | sonnet                    | S      | ST-4, ST-7       |
| ST-9  | Optional, decision 5: measure Florence-2 base and SmolVLM on Set A; ship a Captions pack only on a clear gain                                                                                                                                                                                                                                                                                                                                                      | opus                      | M      | ST-7             |
| ST-10 | Optional, decision 4, after 1.0: `tags.suggest` plugin scope feeding the review queue; example plugin                                                                                                                                                                                                                                                                                                                                                              | opus                      | M      | Plugin host L-06 |

Cut first if time is short: ST-9, ST-10, ST-5, user-added terms in ST-4. The smallest useful release is ST-1 to ST-4
with computed facets only (no CLIP terms): Time of day, Season, Colour, Group, People, Action, Framing, reviewed by
tag, kept in Lifer.

## Risks

- **Wrong keywords in files are sticky.** Writing is off by default, suggestions are never written, Lifer removes only
  its own, and Restore brings back what was there.
- **Calibration drift** across cameras and habitats. Fit at 95%, split by session, a per-term floor, the hide list.
- **Review fatigue at scale.** Review by term with everything preselected; computed facets accept per facet.
- **Duplicating search.** Tags only add; search keeps reading live signals, so no photo becomes harder to find.
- **Data boundary.** Thresholds fitted on catalog reference photos are iNaturalist-derived and stay in Lifer. Preen
  ideas and original vocabulary come in re-written; no Preen code, face or eye models.
- **Privacy.** People presence only, one switch to turn it off; no cloud in core.
- **Dormant terms (decided 2026-11-25).** Behaviour (Flying, Perched) needs animal-crop vectors, which are not stored:
  cut from 1.0 unless crop vectors are stored. Subject terms only fire on photos with no species, which Lifer's
  photos never are today; they stay dormant for Set A and the gate is unchanged.
