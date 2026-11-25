# Refined feel: tree of life, cards, relief map and keywords

Status: plan only, researched 2026-11-24. Nothing here is built. Prompted by a side-by-side with Specio, a competing wildlife photo app (offline species ID that writes Lightroom keywords and IPTC). Its marketing domain did not resolve during research, so its features here come from the maintainer's description and the developer's posts on the BCG forum ("Beta testers wanted for offline species ID in Lightroom").

Read `ux-rules.md` before any package. The rules named most often below: C1 and C10 (shared components, one card shell), S4 (no blank images), S7 (extremes), L5 (weight matches importance), T3 (contrast over photos), T5 (no AI-template look), A2 (offer only what exists), D5 (suggest, user confirms), F2 (never block), U1 (counts agree).

## Summary

- **Lifer is further along than it looks.** The tree already has search, breadcrumbs, a detail pane with a progress ring and rarest finds, keyboard control, windowing and CSV export. The map already has offline shaded relief and 3D terrain while tilted. Metadata writing already covers keywords, a Lightroom-style hierarchy, title, caption with variables and a live preview, place, GPS, rating and credits, and only replaces what it wrote. The gap is mostly feel, not features.
- **Tree of life:** fix blank previews with a server-picked reference image per group (small API change), open on your own branches, draw connector lines and richer group rows, add a "focus on this group" view, then a Circle (sunburst) view.
- **Cards:** a photo-filled card variant of MediaCard (name over a scrim, photo count top-right, italic Latin name, one chip), and class headers with a big "22 of 480" number. Needs a per-species photo count from the API.
- **Map:** a stronger "relief" style (multidirectional hillshade plus elevation tint) from the relief file we already ship, optional sharper online relief from Mapterhorn under the existing Automatic detail switch, and a Stats "atlas" with glass stat panels and a timeline.
- **Keywords:** grow the caption template into Title, Headline, Description and extra Keywords templates with per-field write rules, a database record of what Lifer last wrote (safer than in-file markers), hierarchy detail options, and a Lightroom keyword-list import as a thesaurus. Common names in other languages wait for the next catalog republish.

## 1. Tree of life

### What exists

| Piece | Where | Notes |
| --- | --- | --- |
| Page | `apps/web/src/pages/TaxaExplorer.tsx` (route `/explore`, back to Stats) | One windowed list of 64 px rows, chevron, 56 px thumb, name, mini bar, "12 of 40". Search jumps through matches ("3 of 9"), Expand one level, Collapse all, Random species, Export CSV. |
| Model | `apps/web/src/pages/explorer/treeModel.ts` (+ `.test.ts`) | Pure: index, visible rows, ancestors, search, collected leaves, rarest first. Photographed children sort first. |
| Detail pane | `apps/web/src/pages/explorer/ExplorerDetail.tsx` | Breadcrumbs, progress ring, photo mosaic, rarest finds, species page link. Sheet on a phone. |
| API | `apps/api/src/collection/tree.ts` (`buildTree`), test `tree.integration.test.ts` | class > order > family > genus > species. Node: `collected`, `total`, `photos`, `photoId` (your best photo), and for species only `referenceUrl`, `tier`, `commonName`. |
| Group names | `apps/web/src/lib/speciesGroups.ts` | Class labels for all built-in classes. Birding names for bird families (`BIRD_FAMILY_GROUPS`, "Thrushes"). No common names for other orders, families or genera. |

### Why groups show blank previews

`buildTree` only sets `referenceUrl` on species leaves, and `photoId` only once something under the node is photographed. An unphotographed order, family or genus has neither, so the row draws an empty `bg-surface-muted` square (breaks S4).

### What is feasible with the data we have

| Idea | Feasible? | How |
| --- | --- | --- |
| Never-blank previews | Yes, small | In `buildTree`, give every group with nothing photographed the reference thumb of a representative species: the most common one (lowest tier) that has a reference thumb, so the picture is iconic. Shown greyed (`cover-uncollected`) like species. Photographed groups keep your best photo. |
| Open on your own branches | Yes | When there is no remembered expansion, open every class and order with something photographed, capped at about 150 rows, so the first screen shows your life list, not 16 closed rows. |
| Better jump-to | Yes | Search shows a short results list under the field (name, rank label, path "Aves > Passeriformes"), not the "3 of 9" cycling. Enter picks, arrows move (M4). |
| Focus on a group | Yes | "Focus" in the detail pane re-roots the list at that group; a sticky breadcrumb above the list ("All > Birds > Owls") steps back out. Remembered with the expansion. |
| Connector lines (cascade) | Yes | Each row draws its own guide segments from per-depth "has a later sibling" flags computed in `treeModel`, so windowing still works. |
| Richer group rows | Yes | Rank label (Class, Order, Family, Genus) as a small overline, the friendly name where we have one ("Owls", "Birds") with the Latin name under it in italics, "N species inside", photo count, the mini bar. Rows for groups grow to about 80 px (the window layout already takes per-row heights). |
| Circle view | Yes, medium | A sunburst of class > order > family (species inside family on click), arc size by catalogue species, fill by your share photographed. Click to zoom into a group, synced with the detail pane. Tiny arcs merge into "N more" below a minimum angle so 10,000 species stay readable. Plain SVG (recharts is installed but its sunburst is hard to theme and label; check before choosing). |
| Simple / Extended shape | Partly | "Extended" = show the genus level; "Simple" hides genus (most genera hold one species, so it is mostly noise). One View option. |
| Expand all | Skip | 15,000 rows of a full catalogue help nobody. Keep "Expand one level" and add "Show my branches". |
| Quick actions per node | Yes | On hover and in the detail pane: Open species (species), Show in Collection (filters Collection to this group, needs a family/order filter param), Random species (exists). |
| Common names for every order and family | Not now | Only birds and classes have them. iNaturalist has English names for most families; add in the next catalog republish rather than fetch at runtime (offline first). Until then the Latin name shows, which is honest. |
| Stats per node | Yes | First photographed, latest, photo count, most photographed species. `first_photographed` is already in the query; add `lastPhotographed` and keep the rest client side. |

## 2. Collection cards and class headers

### What exists

- `apps/web/src/components/MediaCard.tsx` is the one card shell (C10): media box on top, title and lines under it, one badge, footer, overlay actions top right, select tick.
- `apps/web/src/components/SpeciesCard.tsx` (currently being edited by another session; coordinate before touching) renders species on it: crop-aware cover or reference photo, seen and target marks top left as white circles with text glyphs (a T6 smell), drive label bottom left, name, second name scaled to fit, at most one badge.
- `GET /collection` items carry no per-species photo count (`apps/api/src/collection/collectionItem.ts`, `routes.ts`), so the Specio-style count needs an API field.
- Group headings in `apps/web/src/components/GroupedSpeciesGrid.tsx` are text: chevron, label, "(24)". Taxon choice lives as pills in the Filters popover (`pages/collection/CollectionToolbar.tsx`).

### Proposal

**Photo card (a MediaCard variant, not a fork).** Add `layout="overlay"` to MediaCard: the media fills the card, title and lines sit on a bottom scrim inside the media box, `actions` stay top right, and a new `count` slot draws a top-right overlay pill (shared IconButton `tone="overlay"` look). SpeciesCard passes:

- common name bold (the user's naming preference still decides which name leads, U4),
- the other name in italics when it is the scientific one,
- photo count top right ("14"), hidden for unphotographed species,
- its one badge as a small translucent chip on the photo,
- seen and target marks moved to house icons (T6).

Unphotographed species keep the greyed reference photo. At the smallest card size the scrim text would be unreadable, so that size keeps names off (the existing "hide names" path) or falls back to the classic layout. Contrast is checked over a white and a black photo (T3). The same layout serves trip and album cards later, which already use MediaCard.

**Class headers.** When Collection is grouped by animal group, the header becomes a band: friendly name ("Birds"), a big number "212 of 480" in a new display style, the mini bar, and one small thumbnail strip of your best photos in that group. Other groupings (rarity, family) keep the plain heading. The band must hold up with 50 groups and with one (S7, L5).

**Category cards.** A row of cards at the top of Collection, one per animal group in the region (Birds 212 of 480, Mammals 31 of 120, Under the sea), each a click-to-filter shortcut for the taxon pills. Images: your best photo in that group, or the group's reference image greyed. Only groups with installed species appear (A2); no "Insects and Arachnids" card, since the catalogue has no insects unless added by hand (no disappointing features). Risk: it repeats the page's progress number (less-is-more copy); the page-level "212 of 480" should then go. See decision 2.

## 3. Map relief, atlas and overall polish

### What exists

- MapLibre GL `^6.19.0` with PMTiles and the Protomaps basemap (`apps/web/package.json`).
- Offline relief: `/maps/relief-z5.pmtiles` (terrarium DEM, zoom 0 to 5) inside the roughly 640 MB offline world map. Hillshade layer and a separate terrain source (`apps/web/src/lib/mapStyle.ts`, `reliefStyleParts`); 3D terrain switches on only while tilted (`apps/web/src/lib/pmtiles.ts`, `tiltTerrain`); bigger regions get more exaggeration (`hooks/useRegionCamera.ts`). Shading colours are tokens `--color-map-relief` and `--color-map-relief-highlight` in `apps/web/src/theme.css`. Credits in `lib/mapCredits.ts`. User doc: `docs/docs/guides/photo-map.md` (3D / Flat switch).
- Online detail already exists: OpenFreeMap vectors and EOx satellite under the Automatic map mode (`docs/plans/map-detail-and-satellite.md`). The relief stays at zoom 5, so past about zoom 8 it goes soft. A shortcut comment in `pmtiles.ts` already notes this.
- Stats has gear, monthly, time of day, EXIF and countries charts (`apps/web/src/pages/stats/StatsCharts.tsx`), and a Year in review. No map on Stats; no date scrubber over the photo map.

### Why Specio's map reads as "3D" and ours reads flat

Theirs is a relief-first style: strong, multi-directional shading, elevation tint (greens to browns to white), and stat panels floating over it. Ours is deliberately "quiet under your photos" (photo-map guide), one light direction, and stops at zoom 5.

### How to get there on our stack

| Step | What | Offline | Licence | Cost |
| --- | --- | --- | --- | --- |
| Relief style | Use MapLibre's multidirectional hillshade method and a `color-relief` (elevation tint) layer on the existing DEM source, both from tokens with a light and a dark palette. Both arrived in MapLibre 5.x; confirm on 6.19 before building. Add sky and fog when tilted. | Yes, uses the shipped file | Unchanged | One more raster layer; check frame time on a 2019 Intel Mac and integrated GPUs on Windows and Linux |
| Where it shows | The Stats atlas and the photo map's region view. Collection's small maps stay calm. | | | |
| Sharper online relief | Mapterhorn publishes a key-free global terrain PMTiles (zoom 0 to 12, terrarium, 512 px; zoom 13 to 17 in regional files). Add it as the DEM source above zoom 5 only in Automatic mode and only when online, falling back silently to the bundled file (offline first). Range requests through the existing PMTiles protocol. | Falls back | Attribution "© Mapterhorn" with its sources page; read the licence and terms on mapterhorn.com before shipping (not confirmed in research) | Network only when zoomed in past 5 |
| Bundled relief beyond zoom 5 | Not recommended: each zoom level roughly quadruples size, and the map is already about 640 MB. | | | |

**Stats atlas.** A hero map on Stats showing where your photos are, with relief, and a few glass panels over it: species and photos, top countries (existing countries data), top gear (existing gear data). Under it a month histogram (existing monthly data) that works as a range brush: dragging it filters the pins. Panels use a shared glass surface, never a one-off blur (C1, C5), and fall back to solid when the system asks for reduced transparency. The atlas replaces, not duplicates, the countries card (less is more).

### Typography and polish

- **Display numerals:** a `text-display` token (large, tabular figures) for headline counts on Stats, class headers and category cards. Today the largest role is Large Title at 1.75 rem.
- **Overline:** a small, letter-spaced rank label style for "ORDER", "FAMILY" in the tree and the detail pane.
- **Italic scientific names everywhere** through `SpeciesNameText` (already used on cards); audit Stats and the tree, which print plain text.
- **Dark media surfaces:** photo cards and the atlas sit on a near-black media token in both themes so photos pop; the beige canvas stays for chrome (T2 note "a lot of beige").
- **Motion:** expand and collapse in the tree ease rows in (150 ms), skipped under reduced motion.
- **Glass token pair** (`--color-glass`, `--color-glass-line`) with a contrast test entry.

## 4. Keywords and metadata

### What Lifer does today

Writer: `exiftool-vendored`, `writeLiferMetadataNow` in `apps/api/src/uploads/exif.ts`; triggered through `syncCaptureXmpSidecars` in `apps/api/src/uploads/xmpSidecarSync.ts` after import, identify, rating, place, tag, cover, date and catalog changes, and from a cancellable "apply to all" job (`apps/api/src/settings/metadataRoutes.ts`). In-file for JPEG, TIFF, PNG, DNG, WEBP, HEIC; `.xmp` sidecar for RAW and video. Only Lifer-managed files.

| Field | Written as | Rule today |
| --- | --- | --- |
| Keywords | `XMP-dc:Subject` (+ `IPTC:Keywords` in file): common name, scientific name, ABA and eBird codes, user tags, `Lifer:Cover` | Other apps' keywords kept; Lifer's own replaced |
| Hierarchy | `XMP-lr:HierarchicalSubject`: `Species|Birds|<Family>|<name>`, `Lifer Tags|<tag>` | Same |
| Title | `XMP-dc:Title` (+ `IPTC:ObjectName`): species names in the naming style | Not templated |
| Caption | `dc:description` (+ IPTC, EXIF) from a template with `{species}`, `{scientific}`, `{group}`, `{place}`, `{region}`, `{country}`, `{date}`, `{year}`, `{month}`, `{trip}`, `{camera}`, `{lens}`, `{rating}` | Marked with CaptionWriter "Lifer"; a caption from another app is never replaced |
| Credits | creator, copyright, credit, usage terms | Fill if empty, or replace when "replace existing" is on |
| Place, GPS, date, rating | IPTC place fields, GPS, DateTimeOriginal, `xmp:Rating` | Mostly fill if empty or on an edit in Lifer |

Settings: `apps/api/src/settings/metadataSettings.ts`, screen `apps/web/src/pages/settings/MetadataSettings.tsx` (VariableChips insert tokens, live preview on one of your photos), shared filler `packages/shared/src/metadataTemplate.ts`, guide `docs/docs/guides/metadata-and-file-names.md`. Ownership is inferred from in-file markers; there is no record of what was written. English names only.

### Gap table

| Specio item | Lifer | Verdict | Why |
| --- | --- | --- | --- |
| Templates for Title, Description, Headline, Keywords | Caption only; title fixed | **Add** Title, Headline, extra Keywords templates | Same engine and preview; small step |
| Taxonomy tokens (common name, synonyms, species, genus, family, order, class) | species, scientific, group | **Add** genus, family, order, class, other names (English aliases) | Data is in `species` already |
| Capture tokens (date, camera, lens, focal length, location) | All but focal length, aperture | **Add** focal length, aperture, shutter, ISO | In EXIF already |
| Aggregate tokens (common name summary, species summary, subject count) | Title joins names | **Add** `{species}` lists all species on multi-species frames, `{count}` | `capture_species` exists |
| Drag-and-drop token builder | Text field + chips | **Partly**: tokens render as chips inside a shared template field; click to insert, Backspace removes; no drag | Drag is fiddly and poor for keyboard users (Y1, M4); same result |
| Per-field write rule (fill if empty, append, replace, leave alone) | Fixed per field | **Add**: one Select per field | User decides |
| Remembers what it wrote | In-file markers | **Add** a database record of the last value per field | Works for Title and Headline, which have no marker |
| XMP and IPTC together, sidecar for RAW, in-file for JPEG | Yes | Have | |
| Up to 3 languages of common names | No | **Add later**, with the next catalog republish | Needs per-locale names in the catalogue; offline first rules out a runtime fetch. Search and UI stay English (separate decision). |
| Multi-species frame rule | Joins all | **Add**: all species / main species only | Small |
| Live preview on a sample photo | Caption only, one photo | **Extend** to every field, with "Try another photo" | |
| Hierarchy as lineage at a chosen detail level | Fixed `Species|Class|Family|name` | **Add** detail level (class to species) and root name | Keep today's layout as the default so existing Lightroom catalogs don't churn |
| Import a Lightroom keyword list or CSV as a thesaurus, write the user's path | No | **Add** | The most-asked power feature for Lightroom users; user confirms matches |
| Rewrite all confirmed photos when settings change, only replacing ours | Apply job exists | **Extend** to honour rules and the written-values record | |
| Auto caption "An image of a Griffon Vulture taken on 12 May 2024 with a 600mm f/4" | Template can nearly do it | **Add** a preset caption using the new tokens | Presets, not a new feature |

Nothing here is on the rejected list (field notes, ID review queue, storage cleanup, drive redundancy, GPX). Everything stays zero-config: defaults write what Lifer writes today.

### Design: metadata templates

**Settings screen** (Settings > Metadata, existing page, `SettingsGroup` panels with divided rows, L3):

- One row per field: **Title**, **Headline**, **Caption**, **Extra keywords**. Each row: a `TemplateField` (new shared component, also adopted by the file-name template), a write-rule `Select` (Fill if empty, Replace what Lifer wrote, Add to the end, Don't write), and a preset menu.
- Token picker: a Menu grouped Species, Photo, Place, Trip; search inside it once it passes about 8 items (S11).
- **Species on one photo:** All species / Main species only (Select).
- **Keyword tree:** detail level (Group, Order, Family, Genus, Species) as a Select, root name TextField (default "Species"), and **Use my keyword list** (opens the thesaurus import).
- **Preview:** a panel listing every field as it would be written for a sample photo, with "Try another photo" (opens the shared photo picker, never a typed path, D7). Values over 200 characters wrap.
- **Apply to all photos**: the existing job, background with progress and Cancel (F2, F4); the button says how many photos it touches.

**Data model**

- Settings stay in `install_settings` under `metadata_template:<userId>`, extended to `{ fields: { title, headline, caption, keywords: { template, rule } }, multiSpecies, hierarchy: { level, root }, thesaurusId, ...credits }`. Missing keys read as today's behaviour, so no settings migration.
- New table `capture_written_metadata (capture_id, field, value_hash, written_at, primary key (capture_id, field))`. Before a write, Lifer reads the file's current value: if its hash equals ours, the value is still Lifer's and may be replaced; if it differs, someone edited it, and only "Fill if empty" and "Don't write" are honoured, never an overwrite (unless the rule is an explicit Replace that the user chose, and even then only for fields Lifer owns). Keep the existing in-file markers as a fallback for files written before the table existed.
- Thesaurus: `keyword_thesaurus (id, user_id, name, imported_at)` and `keyword_thesaurus_entries (thesaurus_id, path text, leaf text, species_id null, matched_by)`. Import parses Lightroom's exported keyword text (tab-indented tree, `{synonyms}`, `[non-exported]` categories) and CSV; matches leaves to species by scientific name, then common name, then aliases; shows a review list (matched, unsure, unmatched) for the user to confirm (D5); writes the user's path instead of `Species|...` for matched species.
- Multilingual names (later): `species_common_names (species_id, locale, name)` filled by the catalog pipeline from iNaturalist at the next republish; settings pick up to three locales for keywords and captions (`{species:fr}`).

**Safety**: every write stays in the existing per-file queue; RAW originals are never written; a dry-run count ("Will change 1,204 photos, leave 37 you edited") before Apply to all.

### Specio features we already match

| Feature | Lifer | Where |
| --- | --- | --- |
| Common names in many languages | No | English names and aliases only (`042_common_name_aliases.sql`) |
| Taxonomy updates | Yes | `apps/api/src/species/catalogSeedUpdate.ts`, rewrites files, split prompts |
| Location-aware ID badge (in range or not) | Partly | Region list drives ranking (`captures/identification.ts`, `captures/suggest.ts`), but suggestions show no badge. Worth a small add: "Not on Canada's list" on a suggestion, from data we have. |
| Manual geotagging | Yes | `components/CoordinatesModal.tsx`, `captures/places.ts` |
| Bulk identify | Partly | Batch import assignment, "Confirm all" in review; no "identify selected photos" action in Gallery |
| Burst confirm | Partly | `components/importReview/ImportCompareView.tsx`, `pages/gallery/SceneStrip.tsx` |
| Trips found automatically, trip cards, shareable story | Partly | Trip cards yes (`components/TripCard.tsx`); trips are folder-based, not detected; Year in review and album share links, no trip story |
| Thesaurus import | No | Lightroom import brings keywords in as tags only (`integrations/lightroom/apply.ts`) |

## Work breakdown

Sizes: S about 1 to 2 days, M 3 to 5 days, L 1 to 2 weeks. Model per the review split: Opus for API, data, file writes and engine; Sonnet for UI, copy, docs and tests. Every UI package ends with the screenshot HIG review (light, dark, 390 / 1280 / 2560 px, extreme seed).

### Wave 1: quick wins (no new concepts)

| ID | Scope | Files | Size | Model | API / schema | Risks | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RF-T1 | Never-blank tree previews: representative reference thumb per group, greyed | `api/src/collection/tree.ts`, `pages/TaxaExplorer.tsx`, `explorer/treeModel.ts`, openapi regen | S | Opus (API) | Response field on groups, no schema | Same picture on parent and child groups (prefer a different species per level) | `tree.integration.test.ts`: every node has `photoId` or `referenceUrl`; S4 e2e on `/explore` |
| RF-T2 | Open on your branches, search results list with rank and path, Focus on a group with sticky breadcrumb | `TaxaExplorer.tsx`, `treeModel.ts`, `ExplorerDetail.tsx`, `en.json` | M | Sonnet | None | Row cap with huge libraries; N1 back restores focus | treeModel unit tests; e2e back keeps focus and scroll |
| RF-C0 | Per-species photo count on collection items | `api/src/collection/routes.ts`, `collectionItem.ts`, openapi | S | Opus | Response field | P3 with 5,000 species: one grouped count, not a subquery per row | `collectionQuery.integration.test.ts` counts equal species page (U1) |
| RF-P1 | Tokens: `text-display`, overline, media surface, glass pair; italic Latin audit | `theme.css`, `contrast.test.ts`, Stats and tree text | S | Sonnet | None | Token sprawl; add only these | contrast test; `check:design-tokens` |

### Wave 2: the visible refresh

| ID | Scope | Files | Size | Model | API / schema | Risks | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RF-T3 | Cascade look: connector lines, rank overline, friendly name plus italic Latin, "N species inside", photo count, variable row height, Simple / Extended (genus) View option | `TaxaExplorer.tsx`, `treeModel.ts` | M | Sonnet | None | Windowing with variable heights; long Latin names (S8) | 10,000-species fixture scroll timing (P3); names fit |
| RF-C1 | MediaCard `layout="overlay"` and `count` slot; SpeciesCard adopts it; house icons for seen and target | `MediaCard.tsx`, `SpeciesCard.tsx`, `docs/plans/shared-card.md` | M | Sonnet, Opus review (shared shell) | None (uses RF-C0) | SpeciesCard has live edits from another session; T3 contrast; smallest size | `behaviour.spec.ts` names fit at every size; L10 footers align |
| RF-C2 | Class header band and category cards row | `GroupedSpeciesGrid.tsx`, `CollectionPage.tsx`, `CollectionToolbar.tsx` | M | Sonnet | None | Repeats the page count (drop the page one); 50 groups | U1 header count equals cards; A2 only installed groups |
| RF-M1 | Relief style: multidirectional hillshade, elevation tint, sky and fog when tilted; light and dark palettes | `lib/mapStyle.ts`, `lib/pmtiles.ts`, `theme.css`, `photo-map.md` | M | Sonnet, Opus review (perf) | None | GPU cost on older machines; check MapLibre 6.19 API names | Map keeps one instance (existing); frame-time check on the extreme seed |

### Wave 3: depth

| ID | Scope | Files | Size | Model | API / schema | Risks | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RF-T4 | Circle view (sunburst), zoom into a group, synced with the detail pane; List / Circle SegmentedControl | new `pages/explorer/TreeCircle.tsx`, `TaxaExplorer.tsx` | M | Sonnet | None | Unreadable thin arcs (merge below a minimum angle); keyboard access to arcs | Unit test of arc layout sums; keyboard e2e |
| RF-T5 | Per-node stats: first and latest photographed, most photographed species; quick actions incl. Show in Collection | `tree.ts`, `ExplorerDetail.tsx`, Collection filter param | S | Opus (API) | Response fields | A Collection family filter is a new URL param (N7) | integration test; e2e link lands filtered |
| RF-M2 | Online relief detail from Mapterhorn above zoom 5 in Automatic mode, silent offline fallback, credits | `lib/pmtiles.ts`, `lib/mapCredits.ts`, `pmtilesAvailable.ts`, guides | M | Opus (network, privacy) | None | Licence not yet confirmed; service may change (no SLA) | Offline e2e: map draws, no error (S9) |
| RF-M3 | Stats atlas: relief map, glass panels, month histogram brush filtering pins | `StatsPage.tsx`, `stats/*`, shared Panel `tone="glass"` | L | Sonnet, Opus review | Possibly a pins-by-month param on the map API | Duplicating Photo map; heavy first paint (P1) | P1 budget on Stats; brush e2e |

### Wave 4: metadata templates

| ID | Scope | Files | Size | Model | API / schema | Risks | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RF-K1 | Template engine: new tokens, Title / Headline / Extra keywords templates, multi-species rule, caption preset | `packages/shared/src/metadataTemplate.ts`, `settings/metadataSettings.ts`, `uploads/exif.ts` | M | Opus | Settings shape only | Writing Headline into files that had none: default rules must equal today | Shared template unit tests; exiftool round-trip test per format |
| RF-K2 | Write rules and `capture_written_metadata` record; dry-run counts; Apply to all honours both | migration, `uploads/exif.ts`, `xmpSidecarSync.ts`, `metadataRoutes.ts` | L | Opus | **Schema** (new table) | Data safety: never overwrite a user edit; files written before the table | Integration: edit a title in another app, apply, value kept; DATABASE_URL=lifer_test |
| RF-K3 | Settings screen: shared `TemplateField` (chips inline), rule Selects, token menu, all-field preview with another photo, hierarchy level and root | `MetadataSettings.tsx`, new `components/TemplateField.tsx`, `en.json`, guide | M | Sonnet | None | Keyboard editing of chips (Y1); long previews | Component tests; screenshot review |
| RF-K4 | Keyword thesaurus import (Lightroom text, CSV), match review, write the user's paths | new `api/src/metadata/thesaurus.ts`, migration, settings UI | L | Opus | **Schema** (two tables) | Ambiguous matches; huge lists (10,000 keywords) | Parser unit tests on real Lightroom exports; match-review e2e |
| RF-K5 | Suggestion badge "Not on <region>'s list" | `captures/suggest.ts` response, suggestion UI | S | Sonnet, Opus review | Response field | Wrong badge erodes trust (U2): only when the region list is installed | Unit test with a seeded region list |

Held for the next catalog republish (`docs/plans/next-catalog-republish.md`): **RF-K6** common names in up to three languages (`species_common_names`) and **RF-T6** English names for orders and families outside birds. Both need pipeline data, not runtime fetches.

## 5. Integrations parity (added 2026-11-24)

Specio lists Lightroom Classic, Apple Photos, Folders, Peakto, DxO PhotoLab, Adobe Photoshop, Adobe Bridge, and Google Photos (coming soon) as places species keywords land. Goal: Lifer matches this, non-destructively, zero-config, offline first.

Starting point (from the repo, to be verified by RF-I0): Lifer already has a Lightroom Classic plug-in (`apps/api/src/integrations/lightroom`), writes XMP sidecars and in-file XMP/IPTC keywords, and has an Immich integration. Folders therefore work today.

| Target | Likely route | Work |
| --- | --- | --- |
| Lightroom Classic | Plug-in plus XMP | Already present; extend to the new templates and thesaurus paths (RF-K1, RF-K4) |
| Adobe Bridge, Photoshop, DxO PhotoLab, Peakto | Read XMP sidecars and in-file XMP/IPTC | Verify each reads our sidecar naming and the IPTC block written together with XMP (RF-K1); document per app in `docs/docs/guides/culling-with-other-apps.md` style guide; no code unless a reader needs a different sidecar convention |
| Apple Photos | No sidecar support. Needs a macOS-only bridge (Photos scripting or PhotoKit) to write keywords, or an export/import album route | Research first (RF-I1); macOS only, so Windows and Linux must hide it |
| Google Photos | No keyword write API for existing library items | Skip for now, revisit if an API appears (Specio also lists it as coming soon) |

Work packages:
- **RF-I0** (Sonnet, S): audit what each app reads from our written files, write a compatibility table into the guides, list real gaps. No code.
- **RF-I1** (Opus, M, research then build): Apple Photos keyword write-back on macOS. Decide Photos scripting vs PhotoKit, permissions prompt, what happens when the photo is not in the Photos library. Held until RF-K1 and RF-K2 land so it reuses the template engine and the "only touch what we wrote" record.
- **RF-I2** (Sonnet, S): Settings > Connected apps shows each supported app with a one-line how-to (Lightroom plug-in, Photos, folders and sidecars), reusing the shared components.

### RF-I0 results and gaps (2026-11-24)

Audit done; the per-app table is in `docs/docs/guides/other-apps-and-keywords.md`. Sources: Adobe Bridge, Lightroom Classic and Camera Raw help pages, Cyme's Peakto guides, DxO forum threads (DxO's own support pages returned 403), Apple developer docs and forums. Nothing was tested against the real apps, so DxO and Peakto rows are from documentation and user reports.

Correction to the starting assumption: `lr:HierarchicalSubject` is already written (`writeLiferMetadataNow` in `uploads/exif.ts`, as `Species|Class|Family|Name` and `Lifer Tags|tag`), alongside `dc:Subject` and, in files, `IPTC:Keywords`. Real code gaps:

1. **Sidecar naming:** Lifer writes only `IMG_0001.xmp` (`sidecarPathFor`). Lightroom, Bridge and Camera Raw use that name. digiKam, Capture One and probably DxO use `IMG_0001.CR3.xmp`. Lifer reads both, writes one. Option: an extra setting or writing both for RAW when the second already exists.
2. **No in-file write toggle:** JPEG, TIFF, PNG, DNG, WebP and HEIC always get in-file writes and RAW always gets a sidecar (`metadataGoesInFile`). There is no setting to leave originals untouched or to write sidecars only. Another worker owns the metadata settings, so it is not touched here.
3. **Linked folders get nothing:** only `managed` originals are written, so Folders, Bridge and Peakto users with linked libraries see no Lifer keywords. A "write sidecars next to linked files" opt-in would close this; it conflicts with the read-only promise, so it needs a decision.
4. **Apple Photos:** keywords in already imported photos can't change (see RF-I1).
5. **DxO PhotoLab:** keyword reading from RAW XMP sidecars is unconfirmed and PhotoLab keeps keywords in `.dop`. Needs a real test with PhotoLab before promising support.
6. **Peakto:** XMP round trip only works for watched folders, and a Lightroom conflict was reported when both write. Needs a real test.
7. **Fixed keyword tree layout:** covered by RF-K1/RF-K4 (detail level, root name, thesaurus).

### RF-I1 research: Apple Photos write-back (macOS)

- **PhotoKit** (`PHPhotoLibrary`, `PHAssetChangeRequest`): changes cover favorite, hidden, creation date, location and similar. Keywords exist only on the read side (`PHAssetExtendedMetadata`). No documented keyword write, so PhotoKit can't do it. It also needs the Photos usage permission (NSPhotoLibraryUsageDescription, and read/write access level) in the app's Info.plist and a user prompt.
- **AppleScript or JXA on the Photos app:** `media item` has a writable `keywords` property (read the list, append, set it back), plus name and description. This is the only route in the results that works. It needs the Automation permission (NSAppleEventsUsageDescription and the `com.apple.security.automation.apple-events` entitlement under the hardened runtime), prompted once per controlling app. Reports: add a short delay between items, large selections can fail with error -10000, and Photos must be running. Tauri can run it through `osascript` from a Rust command.
- **Sandbox:** the Lifer desktop app is not sandboxed, so no sandbox entitlement is needed, only the Automation prompt. A Mac App Store build would need the Apple Events temporary exception.
- **Matching a photo to a Photos item:** Photos has no stable file path. Match by the Photos `original filename` plus capture date, or by a Lifer-added marker. If the photo isn't in the Photos library, do nothing, never import silently.
- **Recommendation:** an opt-in, macOS-only "Add keywords in Apple Photos" action using AppleScript, writing only keywords Lifer owns (reusing the RF-K2 written-values record). Fallback that needs no permission: an "Export for Photos" folder of JPEGs carrying keywords, which Photos reads at import. Not verified on a real Photos library.

## Decisions for you

1. **Photo-filled cards: the new default, or a View option?** Recommend the default at medium and large sizes, classic layout kept for the smallest size. Two card styles as a user option would double the screenshot matrix.
2. **Category art: your photos or illustrations?** Recommend your best photo per group, with the group's reference image greyed until you have one. Illustrations need a designer and a licence and would look generic next to real photos (T5). Also confirm the category row replaces the page's "212 of 480" line.
3. **Sharper online relief from Mapterhorn** under the existing Automatic map switch? Recommend yes, once its licence checks out; no new setting, silent fallback offline.
4. **Common names in other languages for keywords and captions**, added at the next catalog republish? Recommend yes, writing only, up to three languages; the interface and search stay English.
5. **Circle view now or after the cascade?** Recommend after RF-T1 to RF-T3: those fix the complaints (blank previews, wall of arrows); the circle is the delight piece and can wait for a wave.

## Deliberately skipped

- **Expand all** in the tree: a full catalogue is about 15,000 rows; "Show my branches" covers the need.
- **Drag-and-drop tokens**: chips inserted by click give the same templates with better keyboard support.
- **Bundling relief past zoom 5**: the offline map is already about 640 MB.
- **Satellite-style 3D globe or flyovers**: no user value over the tilt we have, real GPU cost.
- **Insects and Arachnids category**: the catalogue has no insects unless added by hand; an always-empty card would disappoint.
- **Automatic trip detection and trip stories**: real gaps, but a separate plan (suggest trips from date and place gaps, user confirms, D5); out of scope for "feel".
- **Gallery "identify selected photos"**: partly covered by import and review; worth its own small package if the maintainer wants it, not part of this refresh.
- **Runtime fetches of names or images from iNaturalist or Wikipedia** for the tree: breaks offline first; data goes in at republish.

## Decisions (2026-11-24)

1. Photo-filled cards become the default, once the maintainer approves the mockup in the running app. Reviewed in the app: rejected, it read as a different app and lost the Collection's charm. The classic light card stays, with the photo count and line-icon marks; the category row and class bands stay behind a View option (Show progress by group, on by default).
2. Category art uses the user's own photos.
3. Mapterhorn relief: check the licence, then add it under Automatic.
4. Other-language common names (RF-K6) and insects: parked on the to-do list for a future catalog update.
5. Circle view and cascade both ship (RF-T4 included in this round).
6. Automatic trip detection is a natural extension of smart albums: plan it separately as suggested trips (date and place gaps), user confirms.
