# Onboarding and import overhaul

Status: plan, drafted 2026-11-08. No code changed. Covers ten requests from the maintainer: first run
(download page, download vs apply, time to the Collection), theme, Collection (Add species, uncollected
look), species page menu, Gallery labels, and the import review screen (compare mode, arrow keys,
location step).

Format follows `lifer-1.0-implementation-plan.md`: task ids (OB-xx), a model tag per task, waves and
dependencies. Reviews follow the split: Opus 5.5 reviews engine, data, security and file writes;
Sonnet 5.5 reviews copy, simple UI and tests. The standing rules and sub-agent briefing in that plan
apply to every task here.

## Contents

1. [Measured: where first-run time goes](#measured-where-first-run-time-goes)
2. [The ten requests](#the-ten-requests)
3. [Work packages](#work-packages)
4. [Waves and parallel work](#waves-and-parallel-work)
5. [Open decisions](#open-decisions)

## Measured: where first-run time goes

Measured 2026-11-08 on the maintainer's Mac (Apple Silicon), Docker Postgres 18.6
(`lifer-app-postgres-1`), against scratch databases `lifer_test_onboard` and `lifer_test_onboard2`
(migrated to 186, dropped afterwards). Inputs: the bundled seed
`apps/desktop/src-tauri/resources-staging/catalog-seed/lifer-catalog-seed.sql.gz` (217 MB, 810 MB
uncompressed; same bytes as the published `catalog-latest` seed of 2026-10-08) and the built pack
`packages/data-pipeline/data/build/packs-out/canada-aves.pack.tar.gz` (35 MB). Docker on macOS adds
some I/O overhead against the embedded Postgres, so treat absolute numbers as within about 30%;
the ratios are what matter. Runs varied by a few seconds.

### The first-run path today

```
launch -> embedded Postgres -> migrations -> Rust psql seed restore -> API starts
       -> onboarding: pick countries and groups -> pack job: [catalog check] -> per pack:
          download -> apply (one transaction) -> photo download -> next pack -> Collection
```

- The desktop restores the seed with `psql --single-transaction` piped from the gzip
  (`apps/desktop/src-tauri/src/embedded_db.rs:400-468`, `stream_catalog` at 582-652), then rebuilds
  species search names (470-492).
- The pack job (`apps/api/src/offlinePacks/download.ts:138-348`) waits for any first-boot catalog
  (`ensureCatalogCurrent`, 103-136), then for each pack in turn downloads (215-221), applies in one
  transaction (247-313) and downloads its photos (318-331). Packs never overlap and the user sees
  one progress line throughout.

### Finding 1: the bundled seed no longer loads on a fresh desktop install

Migration `173_drop_region_seasonality.sql` dropped `region_species.seasonality`, but the seed's
`COPY public.region_species (..., seasonality, ...)` still names it. Migrations run before the
restore (`api.rs:251-262`), so the psql restore fails after loading regions and species (about 9 s),
rolls back, and shows a warning dialog ("Lifer couldn't load the species catalog...", `api.rs:254-261`).
The API then finds an empty catalog and runs `seedCatalogIfEmpty`
(`apps/api/src/index.ts:274`, `catalogSeedUpdate.ts:858-906`), the tolerant temp-table merge.
In the packaged layout `BUNDLED_CATALOG_SEED_DIR` resolves to `REPO_ROOT/catalog-seed`
(`packages/core/src/config.ts:11,196`), which from `target/debug/api/dist` is `target/catalog-seed`,
not where the seed is bundled (`target/debug/catalog-seed`), so it most likely downloads the 217 MB seed
again. **Not verified** in the running app (I did not touch its database); the maintainer's fresh
install of 2026-11-08 shows `app-data/catalog-downloads` written from 11:41:17 to 11:45:03, which fits
a download.

This affects every new desktop user until the next catalog republish, and again whenever a migration
changes a seeded table before a republish.

### Timings

| Step | Today | Measured alternative | How |
|---|---|---|---|
| Decompress seed (gzip, 810 MB out) | 0.7 s | same | not a bottleneck |
| psql restore, schema-matched seed (regions 4.1 s, species 3.8 s, region_species 12.7 s, rest 1.7 s) | 22.3 s | 12.8 s (regions 1.5 s, species 2.0 s, region_species about 8 s) + 2.7 s index builds | lz4 TOAST on `regions.boundary_geojson` and `gbif_area_wkt`; drop `region_species` pkey and species-id index, and the three species GIN indexes, before COPY; rebuild after |
| Species search names rebuild | 5.9 to 6.5 s | 0 s on the critical path | run after the user is in (the API already rebuilds when empty) |
| ANALYZE after load | not run | 0.9 s | run once after restore |
| **Seed total, schema matches** | **about 28 s** | **about 16 s, 23 s with search names inline** | |
| **Seed total today (mismatch)** | **about 9 s failed psql + seed download (217 MB, network bound) + 100 s merge** | **about 16 s** | ship a schema-tolerant fast path (OB-07) |
| API tolerant merge, empty DB (`applyCatalogSeedFile`, regions pass then full) | 100 s: regions pass 7.2 s, load to temp 6.5 s, species merge 9.8 s, traits/rarity/synonyms 4.7 s, **region_species diff 64 s**, sea zones 2.6 s | about 16 s | on an empty table, skip the diff and COPY straight in |
| Pack apply, Canada birds (777 species, 14 regions, 6,266 checklist rows, 28,640 gallery refs, 1,057,932 hotspot rows) | 30.6 to 32.1 s | about 3.5 s to a usable checklist, hotspots about 5 s after in the background | see below |
| of which hotspot INSERTs (2,121 statements of 500 rows) | 28.6 s | 16.5 s plain COPY; 6.5 s COPY with FK checks off; **5.1 s** COPY with FK checks off and the two secondary indexes built after | COPY, `session_replication_role = replica` inside the apply transaction (rows come from our own verified pack), build indexes after |
| of which everything else (checklist upsert 0.5 s, gallery 0.1 s, backfill flag 0.3 s, prune 0.2 s, reads, JSON parse 0.7 s, extract 0.2 s) | 3.5 s | same | already bulk |
| Photo download (pack photo store) | network bound; on the maintainer's 2026-11-08 install, 785 species photos and 3,430 gallery photos landed over 1 min 41 s (file times 11:43:11 to 11:44:52) | unchanged, but off the critical path | the user enters once the first country's checklist is applied; photos fill in |

What the numbers say:

- The **catalog** is the first-run cost, not the packs: a fresh install today pays roughly two minutes
  (failed restore, re-download, 100 s merge) before any pack can apply, because packs wait on
  `waitForFirstBootCatalog` (`download.ts:231-239`).
- Inside a pack, **93% of apply time is gap-finder hotspots** (`apply.ts:424-461`), a table only the
  species page reads (`apps/api/src/species/detail.ts`). A new user does not need it to see the
  Collection.
- The seed already carries every region's checklist (2,516,091 `region_species` rows), so the
  Collection grid can show a country's species as soon as the catalog is in; the pack adds enrichment,
  photos, child regions, hotspots and refreshed tiers.

Targets (to be checked by an e2e timing on all three OSes, Q-10 style):

| Milestone on a fresh install, 50 Mbit/s | Today (estimated from the above) | Target |
|---|---|---|
| Launch to the welcome screen | seed restore inside setup splash, then failure dialog | under 20 s, no dialog |
| Countries listed in onboarding | after the regions pass | at once (regions-only pass, already built) |
| Pick to the Collection with the first country and group usable | about 2.5 to 4 min | under 30 s after the catalog is in |
| Everything chosen applied and photographed | minutes, blocking | continues in the background with progress in the sidebar |

## The ten requests

Each request: what happens today (verified in code), the root cause where something is wrong, the
design, and the work package that builds it. Packages are detailed in [Work packages](#work-packages).

### 1. Nothing preselected on the download page

**Today.** Onboarding preselects Birds and Mammals: `DEFAULT_TAXA = ["aves", "mammalia"]`
(`apps/web/src/pages/OnboardingPage.tsx:42-43`), applied through `defaultTaxa` and `taxa`
(174-187), with the line "Birds and mammals are chosen to start with." (`onboarding.groups.defaults`).
An existing library's groups are restored instead (`restoredTaxa`, 179-183). Settings > Offline maps
and regions starts with nothing selected (`useOfflinePackSelection.ts:53`) but an empty choice means
every group: `taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all"` (`OfflinePacksPage.tsx:157`,
`selectionBytes` 270-283), so the summary and the download both act on everything while the pills
show nothing chosen.

**Design.** Nothing chosen on either page until the user clicks. The Download button stays disabled
with "Choose at least one animal group" until one is picked (A4). Restoring an existing library still
preselects what it had (that is the user's own earlier choice, D1). Settings drops the "empty means
all" rule: the summary reads "Choose animal groups" until one is picked; "Select all" and "Deselect
all" sit on the group list (D4). The suggested country stays a one-click button, never preselected
(already so, `OnboardingPage.tsx:334-336`).

**Package:** OB-01.

### 2. Downloading and setting up as two visible phases

**Today.** One background job per run, one pack at a time: download, apply, photos, next pack
(`download.ts:169-346`). Phase names exist (`PACK_DOWNLOAD_PHASES`,
`apps/web/src/hooks/usePackDownloadStatus.ts:22-61`) but the onboarding shows one `JobProgress` panel
where "applying" has no progress (`progress: "none"`) and reads like more downloading. Apply never
overlaps the next pack's download, so the network sits idle during apply and the disk sits idle
during download.

**Design.** Two lanes in the one job, shown as two rows (C6, F4):

| Row | Wording | Progress | Uses |
|---|---|---|---|
| Download | "Downloading 2 of 6: Canada birds, 12 of 35 MB" then "Downloading photos, 340 of 4,215" | bytes and count | internet |
| Set up | "Setting up on this computer: Canada birds, 2 of 6" with "Doesn't use the internet" as the row's one-line note | count of packs, then steps within a pack | this computer |

- The download lane fetches pack N+1 while the set-up lane applies pack N (bounded: at most two packs
  waiting on disk). Photos download in a third, lower-priority lane after a pack's checklist is in,
  so a slow photo store never holds up the next checklist.
- When downloads finish first, the Download row turns to "Downloaded" and the Set up row keeps going,
  so nobody wonders why the internet is busy.
- Cancel stops the download lane; packs already downloaded still finish setting up unless the user
  chooses "Stop everything" (one menu, not two buttons).
- Job status gains `lanes: { download, setup, photos }` with their own `currentItem`, bytes and
  counts; the old single-phase fields stay filled for the server's sync API callers
  (`requireScope("sync")` on `/offline-packs/download/status`, `download.ts:359-363`).

**Package:** OB-08 (API lanes), OB-09 (UI rows and copy).

### 3. From the first screen to the Collection, and a setup screen worth watching

**Today.**

- Desktop setup screen (`apps/desktop/src/picker.html` and `picker.js:49-56`): a bar and one status
  line ("Loading the species catalog..."), driven by `report_setup` (`pg_upgrade.rs:185-195`). On the
  current seed it ends in a warning dialog (Finding 1).
- Onboarding: countries, then groups, then a progress panel that holds the user until every pack and
  its photos are done (`OnboardingPage.tsx:224-227` moves on only when `finished`). Only then does
  the finish step offer Import, Lightroom, Collection and the tour (566-581).
- The tour (`apps/web/src/components/Tour.tsx:24-33`) has eight steps and starts only on the
  Collection.

**Root causes of the wait** (from the measurements above): the stale seed sends every new desktop
install down the 100 s tolerant merge plus a re-download; 93% of a pack's apply time is hotspot rows
written with 2,121 multi-row INSERTs; packs, apply and photos run strictly in sequence; the user is
held until all of it ends.

**Design.**

1. **Catalog in about 16 s, every time** (OB-07). One schema-tolerant load path for desktop and server:
   - The API's `applyCatalogSeedFile` gets an empty-table fast path: when a catalog table is empty,
     its temp rows go straight in with `INSERT ... SELECT` inside a transaction that sets
     `session_replication_role = replica` (the seed is checksum-verified, so per-row FK checks add
     nothing), with the big secondary indexes dropped first and rebuilt after, then `ANALYZE`. The
     64 s `region_species` diff (`catalogSeedUpdate.ts:294-347`) is skipped for an empty table.
   - `regions.boundary_geojson` and `gbif_area_wkt` move to lz4 TOAST compression (migration;
     4.1 s to 1.4 s on load). Check the embedded Postgres build has lz4 first; fall back silently.
   - The desktop stops piping the seed into psql (`embedded_db.rs:400-468`) and lets the API load the
     bundled file, so a migration can never again break first run. The Rust side passes the bundled
     seed folder to the API (an internal env var set by the shell, not user config), fixing the
     `BUNDLED_CATALOG_SEED_DIR` path that today points at `target/catalog-seed`
     (`packages/core/src/config.ts:11,196`).
   - Species search names are rebuilt after the user is in (the API already does this when empty).
   - A CI test loads the bundled seed against the current migrations, so Finding 1 can't recur.
2. **Packs in seconds** (OB-08): hotspots leave the critical path. A pack applies in two
   transactions: the checklist, enrichment, gallery rows and embeddings first (about 3.5 s for Canada
   birds), then hotspots by COPY with FK checks off and indexes rebuilt (about 5 s), in the
   background lane. The species page already copes with a species that has no hotspots yet.
3. **In after the first pack** (OB-09, OB-10). The queue orders packs by the first chosen country,
   then Birds, Mammals and the rest in the order picked. Once that first pack's checklist is applied,
   onboarding offers "Open your collection" (the primary button) while the rest continues; the
   progress moves into the bottom-left `StatusTray` (`apps/web/src/components/StatusTray.tsx:6-13`),
   where uploads already show (F2). The finish screen's choices stay as they are.
4. **A setup screen that teaches** (OB-10). While the catalog loads and the first pack applies, the
   onboarding and the desktop setup page show a short carousel of cards built from the tour's own
   steps and the guide: what the Collection is, how Import suggests species, what "seen" and
   "target" mean, the Gallery's search ("try fox playing"), the map, and three keyboard tips. Each
   card is one sentence and one image or icon (W5, W6); arrows and dots let people page through at
   their own pace; it never hides the progress rows. The cards come from one list
   (`apps/web/src/lib/setupTips.ts`) so the tour, the guide and the setup screen can't drift.
   The desktop setup page (`picker.html`) shows the same cards with its own tokens, since it runs
   before the web app loads.

**Targets:** see the table in [Measured](#measured-where-first-run-time-goes). OB-12 measures them
on all three OSes.

**Packages:** OB-07, OB-08, OB-09, OB-10, OB-12.

### 4. Follow the system theme from the first launch

**Today.** The web app defaults to Light: `initialPreference()` returns `"light"` when nothing is stored
(`apps/web/src/components/ThemeProvider.tsx:20-29`). The `dark` class is applied in a layout effect
after React mounts (46-55), and `apps/web/index.html` has no pre-paint script, so a dark-system user
would see light until then. The desktop window's first colour comes from the saved `dark` flag
(`apps/desktop/src-tauri/src/lib.rs:217-226`), which is false on a new install. The setup and startup
pages force light (`apps/desktop/src/picker.html:23` `color-scheme: light`; neither `picker.html`
nor `index.html` has a dark palette). The 1.0 plan's standing rule says "Light theme by default"
(`lifer-1.0-implementation-plan.md:121`, open question at 2416-2419); this request reverses it.

**Design.**

- Default preference becomes `"system"`; an explicit Light or Dark choice is kept as today.
- A tiny inline script in `apps/web/index.html` reads `lifer-theme` and `prefers-color-scheme` and sets
  the `dark` class before first paint (T1, P2).
- First window colour on a new install follows the OS: with no saved state, the shell asks the OS theme
  (`tauri::Theme` from the window or `dark-light` style query) instead of assuming light.
- `picker.html` and the startup page get a dark palette under `@media (prefers-color-scheme: dark)`
  with the same tokens as `theme.css`.
- Update the standing rule in `lifer-1.0-implementation-plan.md` and rule T1 to "follows the system".

**Package:** OB-02.

### 5. Add species can also download more animal groups; a findable link to downloads

**Today.** The Collection header shows "+ Add a species" only for a single region, never on a
continent or other hub view: `regionMeta && !regionKnownHub` (`RegionBreadcrumb.tsx:168-177`). It
opens `AddSpeciesToChecklistModal` (one species by hand). Downloading other groups is only reachable
from `TaxonPackPrompt` when a group filter has nothing (`PackPrompts.tsx:147-238`) or from Settings >
Offline maps and regions (`/settings/regions`), which the Collection links only in an empty-state
sentence (`RegionBreadcrumb.tsx:208-217`).

**Design.**

- "Add species" becomes a small menu button (shared `Menu`, M7) shown on every Collection view,
  hubs included:
  - **Download animal groups** (top): a `md` Modal listing the groups not yet downloaded for the
    countries in view, as Pills, nothing preselected (request 1), each with its size, plus the free
    space line (`FreeSpaceNote`). The heading names the countries: "Add animal groups for Canada and
    United States". On a hub, the countries are the downloaded countries under it; on a province,
    its country. Download starts the existing `/offline-packs/download-batch` with those
    `regionNames` and `taxa` and closes at once (F2); progress shows in the `StatusTray`.
  - **Add one species by hand** (today's dialog), single region only, as now.
  - **Download more countries...** links to `/settings/regions` with a back label (N2, W8).
- A permanent, quiet "Downloads" entry in the app sidebar's Collection section (or the Collection's
  View menu if the sidebar is too full; open decision 3) opens Settings > Offline maps and regions.

**Package:** OB-05.

### 6. Species page menus in small groups; "Set as Featured Photo"

**Today.** The species header menu has three or four unseparated items (`SpeciesDetailPage.tsx:188-216`;
a separator only before the danger item). The shared photo menu (`apps/web/src/components/PhotoMenu.tsx:105-181`)
lists up to about 18 items in one run, with one separator before Hide and Delete (172). "Use as
species card photo" is `photoMenu.feature` (and `photoMenu.unfeature` "Stop using as species card
photo"); `Menu.tsx` has `MenuSeparator` (371) and `MenuGroup` (385, for controls like the rating) but
no labelled section.

**Design.**

- Add `MenuSection` to `Menu.tsx` (an optional small heading, items, and a separator between sections,
  never one at the top or bottom, never two in a row) so every menu groups the same way (C2, C11).
- PhotoMenu sections, in order:
  1. Rate (as now)
  2. Species: View species, Set as Featured Photo, Correct the ID, Also features another species
  3. Organise: Add to album, Edit tags, Set location or place, Similar photos, Versions
  4. File: Download original, Download RAW, Reveal, Copy path, Open in
  5. Share: Send to iNaturalist
  6. Hide, page items, Delete (as now)
- Species header menu: Card (Adjust card preview), Checklist (Add to a checklist), Counting (Don't
  count or Count again), then the danger item.
- Rename everywhere (W8, W11), with "Featured photo" as the one noun:

| Key | Today | New |
|---|---|---|
| `photoMenu.feature` | Use as species card photo | Set as Featured Photo |
| `photoMenu.unfeature` | Stop using as species card photo | Remove as Featured Photo |
| `shortcuts.action.feature` | Use as species card photo | Set as Featured Photo |
| `compare.featured` | Species card photo | Featured Photo |
| `compare.featuredToast` | Now the species card photo | Now the Featured Photo |
| `compare.featureFailed` | Couldn't change the species card photo. | Couldn't change the Featured Photo. |
| `compare.help.feature` | K uses the outlined photo as its species card photo... | K sets the outlined photo as the Featured Photo... |
| `species.edits.featuredFailed` | Couldn't change the species card photo | Couldn't change the Featured Photo |
| `connectedApps.scope.yourDataWrite` | ...choose species card photos | ...choose Featured Photos |
| `pairing.scopes.userdataWrite` | ...choose each species' card photo and its crop... | ...choose each species' Featured Photo and its crop... |
| `stats.filter.info.narrower` | ...each species' card photo... | ...each species' Featured Photo... |

  Also `apps/web/src/i18n/en.context.json` (296, 1102), the API's OpenAPI descriptions that feed
  `schema.gen.ts` (search "card photo" in `apps/api/src`), the guides
  (`docs/docs/guides/collection-and-checklists.md:238`, `gallery-and-search.md:104,110,198,204`),
  `docs/docs/api/plugins.md:111-115`, and the e2e specs (`e2e/tests/pages-gallery.spec.ts:101-112`,
  `pages-species-photos.spec.ts:69-84`). English is the only locale file (`apps/web/src/locales/en.json`).
  Capitalisation: the maintainer wrote "Set as Featured Photo"; Lifer's menus are otherwise sentence
  case, so this is open decision 4.

**Package:** OB-03.

### 7. Gallery starts with no labels

**Today.** Caption rows are shared by every photo grid: labels default on
(`apps/web/src/hooks/useShowLabels.ts:5-8`, key `showPhotoLabels`, default `true`), ratings default on
(`usePhotoCaptionPrefs.ts:10`, `galleryShowRatings` `true`), camera info off (9). The Gallery uses
them through `useGalleryDisplayPrefs.ts:10-11`.

**Design.** Defaults become all off (labels, ratings, camera info). Kept shared across grids (C3, one
View menu), so albums, trips, share links and Trash also start clean; a saved choice still wins.
Open decision 5 asks whether "labels" also means ratings.

**Package:** OB-04.

### 8. Import: compare mode, and arrow keys that move between photos

**Today.**

- Keyboard (`apps/web/src/components/importReview/useImportReview.ts:157-190`, bindings in
  `apps/web/src/lib/keymap.ts:96-99,129`): the keyboard only acts on the first unassigned row
  (`activeRow`, 116). Right and **Down** both move the highlighted suggestion (176); **Up** runs
  `goBackToPreviousRow` (133-151), which **clears the previous row's species and unticks it**. With no
  unassigned row, every key but Enter does nothing (165-172). There is no row cursor, so Up and Down
  can't move between photos.
- Assigning ticks the row (`assignSpecies`, 68-69), so "ticked" means both "has a species" and
  "selected for bulk assign". Unticking a confirmed row leaves the species but shows the bulk "Assign
  N selected" picker for the others (`PhotoImportRows.tsx:637-651`), and Up reopens a confirmed row's
  suggestions. The reported symptom (unselecting reopens the species dialog) matches either; the
  first step of OB-11 is a failing test that reproduces it.
- Comparing: a suggestion card's photo opens the species' reference photos in a separate Lightbox
  (`useSpeciesGallery.tsx:7-35`), never beside the user's photo. The import screen shows a 56 px
  thumbnail (`PhotoImportRows.tsx:681-705`). Inspect already computes a subject crop for matching
  (`apps/api/src/uploads/inspect.ts:200-212`) but doesn't return it; reference gallery photos have
  focal points (`focalX`, `focalY` in packs, `apply.ts:102-112`).

**Design: review keys.**

| Key | Does |
|---|---|
| Up, Down | Move the row cursor to the previous or next photo, assigned or not; the cursor row is outlined (T4) |
| Left, Right | Move the highlighted suggestion on the cursor row |
| Enter | Confirm the highlighted suggestion and move the cursor to the next unconfirmed photo |
| C | Open compare mode on the cursor row |
| Backspace | Clear the cursor row's species (the old Up behaviour, now explicit and undoable) |
| Space | Tick or untick the cursor row for bulk actions |
| Mod+Z | Undo the last confirm |

New bindings go in `keymap.ts` and `docs/plans/keyboard-shortcuts.md` (shared keymap with the culling app,
Lightroom conventions). Ticking is only for bulk actions; confirming no longer ticks, and a confirmed
row shows its species and a confirmed mark instead. Unticking never touches the species.

**Design: compare mode.** A full-window view (the shared Lightbox shell in a split layout, M3, M10
`lg`), opened with C, from a row's "Compare" button, or by clicking a suggestion's photo:

```
+---------------------------------------------------------------------------------+
|  Your photo  (IMG_4412.CR3)            |  Lifer suggests                         |
|  [ zoomed on the subject ]             |  [ Featured photo, zoomed on subject ]  |
|                                        |  < 3 of 12 reference photos >           |
|  [ 1 of 14 photos to confirm ]         |  Song Sparrow  88%  | Lincoln's 7% | ...  |
|                                        |  [ Compare with another species... ]    |
|  Fit / Subject (Z)                     |              [ Not this ]  [ Confirm ]  |
+---------------------------------------------------------------------------------+
```

- Left pane: the user's photo, opening zoomed to the subject box (inspect returns it), with Z to
  toggle Fit and Subject. Right pane: the suggested species' Featured Photo, framed on its focal
  point, with Left and Right (or the arrows on the photo) paging that species' reference gallery.
- Candidates: the row's visible suggestions as tabs under the photo; Tab or 1 to 5 switch.
- Typing any letter focuses "Compare with another species" (the shared `SpeciesPicker`, region-aware,
  W10); choosing adds that species as a tab and shows it.
- Enter confirms the shown species and loads the next unconfirmed photo in place (D3); Esc closes
  (M3). "Not this" moves to the next candidate.
- Pan and zoom are synced between the panes on request (S, "Sync zoom"), off by default.
- Works for trip scan review too, since both screens share `useImportReview` and `ImportReviewRow`.

**Packages:** OB-11 (keys and selection), OB-13 (compare mode), OB-14 (inspect returns the subject
box and GPS).

### 9. Uncollected species feel less special; photographed ones feel earned

**Today.** `SpeciesCard.tsx:480` and 528: unseen cards get `opacity-60` on the photo and the text;
**seen** cards get `grayscale` (full colour removed, no dimming); targets not yet collected get
`opacity-60`. Collected cards are full colour. On the beige canvas, 60% opacity of a colour photo
still reads as a colour photo.

**Design.**

| State | Today | Proposed |
|---|---|---|
| Not seen | colour at 60% opacity | line-art cover (setting on) or desaturated (`grayscale` plus lowered contrast), at full opacity; muted name |
| Seen, not photographed | grayscale, full opacity | today's not-seen look: colour at 60% opacity, so seen reads as "nearly" |
| Photographed | full colour | full colour, plus a one-time "New" flourish the first time it appears after an import (subtle, reduced-motion aware) |
| Target, not photographed | colour at 60% opacity | same as its seen or not-seen state, plus the target mark |

Technique for the line art, in order of preference:

1. **Precomputed per cover** (recommended): the API renders a line-art WebP next to each reference
   thumb with sharp (already a dependency: `apps/api/package.json:39`): greyscale, a Sobel-style
   `convolve`, `negate`, `threshold` or a soft levels curve, tinted with the ink token at render
   time via CSS. Cached in `app-data/reference-lineart/` keyed by the thumb's file and a filter
   version, made lazily on first request and in a low-priority background pass after a pack applies.
   Cost: one small file per species (thumb size), no per-frame GPU work, so 5,000 cards scroll as
   today (P3). Dark mode uses the same file with CSS `invert` or a light tint.
2. CSS `filter: grayscale(1) contrast(...)`: free, instant, and the fallback when the line-art file
   isn't made yet or the setting is off.
3. SVG `feConvolveMatrix` through `filter: url(#...)`: rejected for grids; it runs per paint on the CPU
   in WebKit and stalls scrolling with thousands of cards.
4. Canvas or WebGL per card: rejected; a context per card doesn't scale and adds code for no gain over 1.

Setting: Settings > Appearance "Show species you haven't photographed as drawings" (on by default
once the experiment is signed off), plain wording per W3.

**Experiment before committing (OB-06a).** Take 24 covers across groups (birds on sky, birds in foliage,
mammals at night, fish, insects, snakes on leaf litter, a white bird on snow) and render each with
three line-art settings plus the desaturated fallback; mock a Collection page of 200 cards in light
and dark at the smallest and largest card size; screenshot side by side with today's look; check
contrast of names over the drawing (Y3) and that a drawing never reads as a missing image (S4). The
maintainer picks a style (or rejects line art) before OB-06b ships it.

**Packages:** OB-06a (experiment and mockups), OB-06b (build).

### 10. Import location: a real workflow

**Today.** Above the drop area: "Location" with "Optional", a free-text `PlaceNameInput` holding one
label for the whole batch (`PhotoImportRows.tsx:218-219, 577-589`), sent as `locationLabel` with every
file (`apps/web/src/lib/importCommit.ts:18-36`) and written as the photo's label and XMP Location
(`apps/api/src/uploads/exif.ts:580-582`). Below it, "Region (for suggestions)", one `RegionBrowser`
for the batch (591-614). No coordinates can be set, saved spots can't be chosen, nothing groups the
photos, and the camera GPS each file carries isn't shown (inspect reads `lat` in
`exif.ts:160` but doesn't return it). Meanwhile the app already has the right parts:
`PlacePicker.tsx`, `PlaceStep.tsx` (`PlaceChooser`, "This looks like King Fisher Pond" offers),
`PointPickerMap.tsx`, `CoordinatesModal.tsx`, `SavedSpots.tsx`, `usePlaceFiling.tsx`
(apply to capture ids with far-photo confirm and Undo) and `useSavedSpots.ts`.

**Design.** Import becomes three calm parts on one screen, no wizard: **Add** (drop zone), **Where**
(groups and places), **What** (species review with compare). Each photo's place and species can be
set in any order; Import stays one button.

- **Groups.** As files arrive, rows are grouped into sessions with the rule the map tray already uses
  (no gap of an hour or more, split at a day and at a region change; `map-location-ux.md` "Needs
  placing tray"). Each group header: four thumbnails, "14 photos, Sun 14 Sep, 07:10 to 08:02", and its
  place chip.
- **Place chip per group** (photos inherit; a single photo can override from its row):
  - Photos with camera GPS: "From the camera: near Prince George" (nearest town offline, MAP-12), and
    if a saved place contains the point, "This looks like King Fisher Pond. Use it?" (the
    named-places rule that a place is recognised again whenever the user returns).
  - Photos without GPS: "Add a place" opens the shared `PlaceChooser`: Nearby, Recent and All places,
    region search, and "New place from the map" (`PointPickerMap`). Choosing a region only sets the
    region (as today); choosing a saved place or a pin sets the point too.
  - Session hint: a group without GPS next to one with GPS in the same day offers "Same place as the
    07:10 group?" (one click, never automatic; MAP-11's rule).
  - "Skip" leaves the group unplaced; it shows later in the map's Needs placing tray.
- **Region for suggestions follows the place.** The group's region (from GPS, place or pin) is what
  matching uses for that group's rows; the batch-level `RegionBrowser` becomes the fallback for groups
  with no place, defaulting to the last region (N4). Changing a group's place re-runs suggestions for
  its rows only (`selectRegion` re-inspects every pending row today, 266-277).
- **Applying.** Places are applied after each file commits, through `usePlaceFiling` and the shared
  `applyLocation` job, so camera GPS is kept, far photos are asked about, the files are written, and
  one Undo toast covers the batch (F3; `named-places.md` "What choosing does"). The free-text label
  stays for people who only want a label (named-places decision 1), now as "Label" inside the place
  chip's menu, not a top-level field.
- **Send with a place.** If the user sends the batch to iNaturalist afterwards, the place's privacy and
  accuracy go with it (PLACE-04, already built through `PlaceStep`).
- **Extremes.** 2,000 files in 60 groups: groups virtualised and collapsed after the first five
  (S7); a 300-character place name wraps (S8); 0 GPS photos: every group says "Add a place"; mixed
  GPS in one group: the chip says "9 from the camera, 5 without" and the place applies to the 5 only.

**Packages:** OB-14 (inspect returns GPS and subject box), OB-15 (groups and place chips), OB-16
(apply after commit, undo, region per group).

## Work packages

Effort is in worker sessions (about one package per session) with a conventional-days figure beside
it; Lifer's measured pace is far faster for coding, as the 1.0 plan's calibration note says. "Model" is
who builds it; "Review" follows the split (Opus for engine, data, security and file writes; Sonnet for
copy, simple UI and tests). Every UI package reads `ux-rules.md`, names the rules it touches, and ends
with the screenshot HIG self-review (light, dark, smallest window, 27 inch, extremes: 0, 1, 5,000
species, 2,000 import files, 300-character names). `apps/web/src/locales/en.json` is shared by most
packages: stage only your own hunks (`git add -p`), never rewrite the file.

### OB-01 Nothing preselected on download pages

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 1.
- **Scope:** in: remove `DEFAULT_TAXA` and `defaultTaxa`; keep `restoredTaxa`; disabled Download with a
  plain reason until a group is chosen; Settings drops "empty means all" in `selectionBytes` and the
  `download-batch` call; Select all and Deselect all on the group list; copy (`onboarding.groups.defaults`
  removed, a new "Choose the animals you photograph" line). Out: country preselection (unchanged).
- **Files:** `apps/web/src/pages/OnboardingPage.tsx` (42-43, 174-187, 422-423, 518-526),
  `apps/web/src/pages/offlinePacks/useOfflinePackSelection.ts`, `OfflinePacksPage.tsx` (155-157, 466-472),
  `TaxonPicker.tsx`, `useOfflinePackSelection.test.ts`, `OnboardingPage.test.tsx`, `e2e/tests/first-run.spec.ts`,
  en.json, `docs/docs/getting-started.md`, `docs/docs/guides/offline-packs-and-map.md`.
- **Tests:** unit: nothing chosen gives 0 bytes and a disabled button; restored library preselects its
  groups; e2e first run clicks a group before Download.
- **UX checks:** A4, D1, D4, W5, W9.
- **Risks:** low. The server API keeps accepting `"all"` for sync callers.
- **Effort:** 1 session (half a day).

### OB-02 Theme follows the system from first launch

- **Model:** Sonnet 5.5. **Review:** Opus 5.5 (touches the Rust shell's window setup).
- **Goal:** request 4.
- **Scope:** in: default `"system"` in `ThemeProvider.tsx:28`; pre-paint inline script in
  `apps/web/index.html` (CSP-safe: check `tauri.conf.json` CSP allows it, else a tiny external
  `theme-boot.js`); first-window colour from the OS theme when no window state is saved
  (`lib.rs:217-226`, `window_state.rs`); dark palettes for `apps/desktop/src/picker.html` and
  `index.html`; update standing rule (`lifer-1.0-implementation-plan.md:121`, open question 2416-2419)
  and T1 wording. Out: new themes.
- **Files:** the above, `apps/web/src/components/ThemeProvider.test.tsx` (new or existing), Settings >
  Appearance copy if it names a default.
- **Tests:** unit for the default; e2e with `colorScheme: "dark"` emulation asserting the first
  screenshot frame is dark (P2) and `html` and `body` backgrounds match (T1).
- **UX checks:** T1, P2, X1, X4.
- **Risks:** the OS theme query differs per platform; Linux desktops without a portal report nothing,
  so fall back to light there.
- **Effort:** 1 session (1 day).

### OB-03 Menu sections and "Featured Photo"

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 6.
- **Scope:** in: `MenuSection` in `Menu.tsx` (no leading, trailing or doubled separators; optional
  heading); PhotoMenu and the species header menu regrouped as in request 6; every rename in the
  table there, the context file, API description strings, guides, plugin docs and e2e selectors;
  regenerate `schema.gen.ts` if API descriptions change. Out: new menu items.
- **Files:** `apps/web/src/components/Menu.tsx`, `PhotoMenu.tsx`, `PhotoMenu.test.tsx`,
  `apps/web/src/pages/SpeciesDetailPage.tsx:188-216`, en.json, `apps/web/src/i18n/en.context.json`,
  `apps/api/src/**` description strings, `apps/web/src/api/schema.gen.ts`,
  `docs/docs/guides/collection-and-checklists.md`, `gallery-and-search.md`, `docs/docs/api/plugins.md`,
  `e2e/tests/pages-gallery.spec.ts`, `pages-species-photos.spec.ts`.
- **Tests:** PhotoMenu unit: sections render, empty sections vanish with their separator; `rg -i "card
  photo"` over web, api, docs and e2e returns only API route names; `check:i18n`.
- **UX checks:** C2, C11, M1, M7, W8, W11.
- **Risks:** `check:raw-controls` lists PhotoMenu's items; update its allowlist if item order is part of it.
- **Effort:** 1 session (1 day).

### OB-04 Photo grids start with no caption rows

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 7.
- **Scope:** in: defaults `false` for `showPhotoLabels` and `galleryShowRatings`; saved choices win; guide
  line in `gallery-and-search.md`. Out: changing keys (would reset everyone's saved choice).
- **Files:** `apps/web/src/hooks/useShowLabels.ts`, `usePhotoCaptionPrefs.ts`, tests that assume labels
  on (search `showLabels` in `*.test.tsx` and e2e).
- **Tests:** unit for defaults; e2e grids that read a caption turn it on first.
- **UX checks:** C3, C4, L7.
- **Effort:** under 1 session (2 hours).

### OB-05 Add species menu: download more animal groups, and a downloads link

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 5.
- **Scope:** in: "Add species" becomes a Menu on every Collection view including hubs; "Download animal
  groups" modal (countries in view, groups not yet downloaded, sizes, free space, nothing preselected,
  closes at once); "Add one species by hand" (single region, today's modal); "Download more countries"
  link; the sidebar or View-menu entry per open decision 3. Out: provinces (they come with the country).
- **Files:** `apps/web/src/pages/collection/RegionBreadcrumb.tsx` (168-190), new
  `apps/web/src/pages/collection/AddGroupsModal.tsx`, `useTaxonAvailability.ts` (reuse for "not yet
  downloaded"), `apps/web/src/components/AppSidebar.tsx` (if chosen), en.json,
  `docs/docs/guides/collection-and-checklists.md`.
- **Depends on:** OB-01 (pill behaviour), OB-09 (progress in the StatusTray).
- **Contracts:** reuses `POST /offline-packs/download-batch { regionNames, taxa }` (`download.ts:403-449`).
- **Tests:** unit: hub with Canada and United States lists their missing groups and posts both names;
  e2e: choose Reptiles on North America, dialog closes, StatusTray shows progress.
- **UX checks:** A2, A4, F2, F4, M2, M7, M10, N2, S6, W8, W9; extremes: 50 countries under a hub, every
  group already downloaded (menu item disabled with the reason).
- **Effort:** 1 session (1 to 2 days).

### OB-06a Uncollected look: experiment and mockups

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5, then the maintainer picks.
- **Goal:** request 9's experiment, nothing shipped.
- **Scope:** in: a throwaway script (scratchpad, not the repo) rendering 24 covers with three sharp
  line-art settings and the desaturated fallback; a static mock Collection of 200 cards per variant,
  light and dark, smallest and largest card size; seen versus not-seen versus photographed side by
  side; contrast numbers for names. Out: app code.
- **Files:** `docs/plans/assets/uncollected-look/` (screenshots only).
- **Tests:** none (visual).
- **UX checks:** T3, T5, S4, Y3, P3.
- **Effort:** 1 session (1 day).

### OB-06b Uncollected and seen card treatment

- **Status:** done 2026-11-08, desaturated only (maintainer rejected line art and isolation). Shared `.cover-uncollected`, `.cover-seen`, `.text-uncollected` in `theme.css`; no setting, no API work.

- **Model:** Opus 5.5. **Review:** Opus 5.5 (writes cached image files).
- **Goal:** request 9, in the style the maintainer picked.
- **Scope:** in: `GET /species/:id/reference-photo/lineart` rendering and caching to
  `app-data/reference-lineart/<speciesId>-v<N>.webp` from the reference thumb (sharp), lazy plus a
  low-priority pass after packs apply, removed with the pack's photos; SpeciesCard states per the table
  in request 9; Settings > Appearance switch; fallback to CSS desaturation while a file is missing.
  Out: line art for the user's own photos.
- **Files:** `apps/api/src/species/` (new `lineart.ts` and route), `apps/api/src/offlinePacks/remove.ts`
  (delete cached files), `apps/web/src/components/SpeciesCard.tsx` (480, 528), `MediaCard.tsx` if a slot
  is needed, settings page and prefs, en.json, `docs/docs/guides/collection-and-checklists.md`.
- **Depends on:** OB-06a sign-off.
- **Tests:** unit for the filter pipeline on a fixture image (deterministic output hash); integration:
  cache hit, version bump regenerates, pack removal deletes; e2e scroll budget with 5,000 cards (P3).
- **UX checks:** P3, P4, S4, T1, T3, Y3.
- **Risks:** disk use (about 5 to 15 KB per species, so 10,000 species is about 100 MB at worst; measure in
  OB-06a); files go under app data, never the user's library.
- **Effort:** 1 to 2 sessions (2 to 3 days).

### OB-07 Catalog loads fast and survives schema changes

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a fresh-install run on macOS, Windows and Linux.
- **Goal:** request 3, the catalog half; fixes Finding 1.
- **Scope:** in: empty-table fast path in `applyCatalogSeedFile` (`catalogSeedUpdate.ts:591-720`):
  `session_replication_role = replica` within the transaction, drop and rebuild the listed big indexes,
  plain `INSERT ... SELECT` from the temp tables, skip `diffChecklistFromSeed` for an empty table,
  `ANALYZE` after; lz4 TOAST migration for `regions.boundary_geojson` and `gbif_area_wkt` (pre-approved
  as spec'd here, claim the number; skip if the server build lacks lz4); desktop loads through the API:
  remove the psql restore from `api.rs:251-262` and `embedded_db.rs:400-492`, pass the bundled seed folder
  to the API process, report catalog progress to the setup page through the existing status channel;
  search names rebuilt after the user is in; CI test that loads the bundled seed into a fresh
  migrated database. Out: changing the seed format or the pipeline's seed build.
- **Files:** `apps/api/src/species/catalogSeedUpdate.ts`, `catalogSeedUpdate.integration.test.ts`,
  `packages/core/src/config.ts` (196), `apps/desktop/src-tauri/src/api.rs`, `embedded_db.rs`,
  migration `<next>_regions_lz4.sql`, `.github/workflows/ci.yml` (seed-load job),
  `docs/docs/contributing/` page that describes first boot.
- **Contracts:** seed loads stay one transaction; a failure leaves an empty catalog and retries next
  launch (today's behaviour); progress phases unchanged for `PACK_PHASES.preparing`.
- **Tests:** integration on `lifer_test`: empty database fills in under a budget (about 20 s on CI
  hardware, measured first); an update over a filled catalog still takes the diff path and gives the
  same rows as today; a seed with an extra or missing column still loads.
- **Measured target:** 100 s merge (plus failed restore and re-download) down to about 16 s.
- **Risks:** `session_replication_role` needs superuser or a role with the setting granted: the
  embedded database runs as its owner (fine); Docker servers use the `lifer` role, so check, else fall
  back to deferring constraints and accept FK checks (still far faster without the diff). Dropping
  indexes inside the transaction blocks readers of those tables, which on an empty catalog is nobody.
- **Effort:** 2 sessions (3 to 4 days).

### OB-08 Pack apply in two steps, lanes, and COPY for hotspots

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check a cancel or crash mid-pack leaves no half pack.
- **Goal:** requests 2 and 3, the pack half.
- **Scope:** in: `applyPack` split: transaction 1 is today's apply without hotspots; transaction 2 writes
  hotspots with COPY (`apps/api/src/lib/pgCopy.ts` `copyInto`), FK checks off, the two secondary indexes
  rebuilt only when a pack adds over a threshold (say 100,000 rows), in the background lane;
  `downloaded_packs` gains nothing new if the hotspot state can be derived (a pack whose hotspots are
  pending is retried at startup by comparing `content_version`; otherwise a nullable
  `hotspots_applied_version` column, pre-approved as spec'd); the job runs download, set-up and photo
  lanes concurrently with a bound of two packs on disk; queue order: first chosen country, then groups
  in the order picked, Birds first by default; status gains `lanes`. Out: changing pack contents.
- **Files:** `apps/api/src/offlinePacks/apply.ts` (424-461 and `applyPack` 644-730), `download.ts`
  (138-348), `responses.ts`, `apply.integration.test.ts`, `download.integration.test.ts`,
  `apps/web/src/lib/packDownloadStore.ts` (types only).
- **Contracts:** `PackDownloadStatus.lanes = { download: {...}, setup: {...}, photos: {...} }`, each with
  `currentItem`, `processed`, `total`, `downloadedBytes`, `totalBytes`; old fields kept for sync callers.
- **Tests:** integration: Canada birds checklist commits under 5 s on CI; hotspots arrive after;
  killing the job between the two transactions leaves a working checklist and hotspots re-applied on
  the next start; removal during the hotspot step waits (pack removal already refuses while a download
  runs, `download.ts:381-382`).
- **Measured target:** 30.6 s to about 3.5 s to a usable checklist; hotspots about 5 s in the background.
- **Risks:** hotspots are read for "where to find it"; until they land, the species page falls back to
  the checklist (it already does, `apps/api/src/species/detail.ts:64-110`).
- **Effort:** 2 sessions (3 to 4 days).

### OB-09 Two progress rows and the StatusTray

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 2's UI.
- **Scope:** in: a shared `PackProgress` showing the Download and Set up rows (and photos) from `lanes`,
  used on onboarding, Settings > Offline maps and regions, Collection pack prompts and a new StatusTray
  entry; wording from the request 2 table; one Cancel menu. Out: the setup tips (OB-10).
- **Files:** `apps/web/src/hooks/usePackDownloadStatus.ts`, new `apps/web/src/components/PackProgress.tsx`,
  `StatusTray.tsx`, `OnboardingPage.tsx` (427-437), `OfflinePacksPage.tsx`, `collection/PackPrompts.tsx`,
  `DownloadedPacksList.tsx`, en.json, `docs/docs/guides/offline-packs-and-map.md`.
- **Depends on:** OB-08 contract (can start against the agreed type with a mocked status).
- **Tests:** unit per lane state (downloading only, both, set-up only, photos); e2e with a delayed pack
  server: both rows visible, Download finishes first and says so.
- **UX checks:** C6, F2, F4, F5, P6, W5, W9.
- **Effort:** 1 session (1 to 2 days).

### OB-10 In after the first pack, with a setup screen that teaches

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 3's experience.
- **Scope:** in: onboarding shows "Open your collection" once the first pack's checklist is set up
  (from `lanes.setup.processed >= 1`), the rest continues in the StatusTray; the finish step's choices
  appear at the same moment; `setupTips.ts` (one list: title, one sentence, icon or image, link to the
  guide section) feeding a carousel on onboarding and on `picker.html` during catalog load; the tour
  reuses the same copy where it overlaps. Out: new tour steps.
- **Files:** `apps/web/src/pages/OnboardingPage.tsx` (224-227, 410-584), new
  `apps/web/src/lib/setupTips.ts` and `apps/web/src/components/SetupTips.tsx`, `apps/desktop/src/picker.html`,
  `picker.js`, `apps/web/src/components/Tour.tsx` (copy only), en.json, `e2e/tests/first-run.spec.ts`.
- **Depends on:** OB-01 and OB-09 (same page; one worker does OB-01, OB-09's onboarding part, then OB-10,
  or they run in that order), OB-08.
- **Tests:** e2e: with a slow second pack, the Collection opens after the first and shows the first
  country; tips page with arrows and keyboard; reduced motion stops auto-advance.
- **UX checks:** N5, F2, P2, P7, W5, W6, Y3, X4.
- **Risks:** the picker page has no React or i18n; keep its tips in a small JSON the build copies from
  `setupTips` so the wording stays in one place.
- **Effort:** 1 to 2 sessions (2 days).
- **Built (2026-11-08):**
  - No fixed times anywhere. The catalog panel and every progress row show "Loading…" (rows show
    nothing) until the rate is measured, then "About 15 seconds left" from one estimator
    (`apps/web/src/lib/timeLeft.ts`): a 10 s window, at least 2 s and 2% in, 5 s steps under a
    minute, then minutes and hours, never up, at most 3 s above its own countdown, hidden under 5 s,
    and back to measuring when the rate stalls or collapses. The API publishes the seed load as
    processed of total (`catalogLoadProgress`: reading the file is the first half, merging the
    second, tables weighted by their bytes) on `GET /settings` and the pack status.
  - Pack rows name packs as the server sends them ("Canada birds"); the old "for" label is gone.
  - "Continue in the background" shows on the setup screen once the catalog is in and packs are
    moving. Not before: the first catalog load drops and rebuilds indexes, which locks the species
    tables until it commits, so the Collection would hang.
  - Each tip links to its guide section.
  - `picker.html` keeps its bar and no tips: it now only creates and migrates the database, and the
    catalog loads afterwards behind the onboarding screen. Recheck on a slow disk in OB-12.

### OB-11 Review keys and selection that mean one thing

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 8's keyboard and the "unselecting reopens" bug.
- **Scope:** in: first, a failing test reproducing the reported bug; a row cursor in `useImportReview`
  (Up, Down over all rows); Left, Right for suggestions; Enter confirms and jumps to the next
  unconfirmed; Backspace clears; Space ticks; Mod+Z undoes the last confirm; confirming no longer ticks
  (`assignSpecies` 68-69); unticking never changes a species; the cursor row outlined; `keymap.ts`,
  the `?` sheet and `keyboard-shortcuts.md` (also the culling app's shared table). Out: compare mode (OB-13).
- **Files:** `apps/web/src/components/importReview/useImportReview.ts`, `ImportReviewRow.tsx`,
  `apps/web/src/components/PhotoImportRows.tsx` (only the review wiring, 420-434, 732-741),
  `apps/web/src/pages/trip/TripScanReview.tsx`, `apps/web/src/lib/keymap.ts`,
  `docs/plans/keyboard-shortcuts.md`, `docs/docs/guides/importing.md`, tests.
- **Tests:** unit for the hook (cursor moves with nothing ticked, Enter skips confirmed rows, untick keeps
  species, Mod+Z restores); e2e on 20 files.
- **UX checks:** M4, M8, D3, F3, T4, Y1.
- **Risks:** muscle memory for Up as "undo"; the guide and the `?` sheet say where it went.
- **Effort:** 1 session (1 to 2 days).

### OB-12 First-run timing check on three OSes

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** keep the request 3 targets from regressing.
- **Scope:** in: an e2e (Q-10 style) that starts from an empty database with the bundled seed and a local
  pack server, and records launch to countries listed, pick to Collection usable, all packs set up;
  baselines in `e2e/perf-baseline.json` per OS. Out: real network timing.
- **Files:** `e2e/tests/first-run-timing.spec.ts`, `e2e/perf-baseline.json`, CI workflow.
- **Depends on:** OB-07, OB-08, OB-10.
- **Effort:** 1 session (1 day).

### OB-13 Compare mode on import

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5 (UI only; data contract is OB-14's).
- **Goal:** request 8's compare mode, as designed above.
- **Scope:** in: `ImportCompareView` built on the Lightbox shell in a split layout; user photo zoomed to
  the subject box with Fit and Subject; the species' Featured Photo framed on its focal point and its
  reference gallery paged in place; candidate tabs; type to compare any species (`SpeciesPicker`);
  Enter confirms and loads the next unconfirmed photo; narrow windows stack the panes; trip review gets
  it too. Out: syncing zoom by default.
- **Files:** new `apps/web/src/components/importReview/ImportCompareView.tsx`, `useSpeciesGallery.tsx`
  (return slides with focal points), `ImportReviewRow.tsx` (Compare button), `PhotoImportRows.tsx` and
  `TripScanReview.tsx` (open it), `keymap.ts` (C, Z), en.json, `docs/docs/guides/importing.md`.
- **Depends on:** OB-11 (cursor and keys), OB-14 (subject box).
- **Tests:** unit for candidate switching and confirm-advance; e2e: open with C, page the gallery, type a
  name, confirm, next photo shows.
- **UX checks:** M3, M4, M10, M11, L9, P2, T3, W10, S8.
- **Risks:** RAW and HEIC previews come from the server (`rawPreviewUrl`); the subject box must be in the
  preview's coordinates.
- **Effort:** 2 sessions (3 days).

### OB-14 Inspect returns the subject box and camera GPS

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** data for OB-13 and OB-15.
- **Scope:** in: `/uploads/inspect` response gains `subject: { x, y, w, h } | null` (percent of the
  preview, from the subject pass already run for matching, `inspect.ts:200-212`, or `cardCrop`) and
  `gps: { lat, lon } | null` plus `takenAt` (already there); a looked-up `regionId` for the GPS point
  (the same lookup capture rows use); OpenAPI schema and `schema.gen.ts`. Out: storing anything new.
- **Files:** `apps/api/src/uploads/inspect.ts`, its schema and tests, `apps/web/src/api/schema.gen.ts`,
  `apps/web/src/components/PhotoImportRows.tsx` (row type only).
- **Tests:** integration with a GPS-tagged fixture and one without; the subject box of a centred
  fixture is roughly centred.
- **Risks:** the subject pass runs only when a suggestion model is ready; return null otherwise.
- **Effort:** 1 session (1 day).

### OB-15 Import groups and place chips

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** request 10's "Where" part, UI.
- **Scope:** in: rows grouped by session (the `suggestedEncounters` rule, split by day and region) with a
  group header and place chip; chip states (camera GPS with nearest town, recognised place offer, Add a
  place via `PlaceChooser`, Skip, mixed); per-photo override from the row; the free-text label moves into
  the chip's menu; the top-level "Location (optional)" field goes. Out: applying (OB-16).
- **Files:** new `apps/web/src/components/importReview/ImportPlaceGroups.tsx`, `PhotoImportRows.tsx`
  (577-589 replaced, rows rendered per group), `PlaceStep.tsx` (export `PlaceChooser` use as is),
  en.json, `docs/docs/guides/importing.md`.
- **Depends on:** OB-14.
- **Tests:** unit for grouping (hour gaps, day split, region change); e2e: 30 files in three sessions,
  one with GPS shows its town, choose a saved place for another, skip the third.
- **UX checks:** D1, D5, D7, S7, S8, W5, W10, L1; extremes: 2,000 files, 60 groups, no GPS at all.
- **Effort:** 2 sessions (3 days).

### OB-16 Places applied after commit, with one undo, and region per group

- **Model:** Opus 5.5. **Review:** Opus 5.5 (writes locations into files).
- **Goal:** request 10's apply and suggestions.
- **Scope:** in: after each commit, captures in a placed group are filed through `usePlaceFiling` and
  the shared `applyLocation` job (camera GPS kept, far photos asked, files written), batched per group;
  one Undo in the import toast reverses species and places together; a group's region drives that
  group's suggestions and re-inspects only its rows; the batch `RegionBrowser` becomes the fallback;
  skipped groups appear in the map's Needs placing tray. Out: GPX or tracks (rejected).
- **Files:** `apps/web/src/components/PhotoImportRows.tsx` (`importAll` 436-541, `undoBatch` 547-562,
  `selectRegion` 266-277), `apps/web/src/lib/importCommit.ts`, `apps/web/src/hooks/usePlaceFiling.tsx`,
  tests.
- **Depends on:** OB-15.
- **Tests:** integration through the API: import 20 files with a place, undo, files and rows restored;
  far-photo prompt appears once per group.
- **UX checks:** D2, D5, F2, F3, N4, S1.
- **Risks:** an import of thousands with places is a long job; it already runs in the background with
  the upload banner; place filing joins the same banner.
- **Effort:** 1 to 2 sessions (2 days).

## Waves and parallel work

```
Wave 1 (no shared files except en.json hunks):
  OB-07 catalog (Opus)      OB-08 packs API (Opus)     OB-14 inspect (Opus)
  OB-01 no preselection     OB-02 theme                OB-03 menus and rename
  OB-04 caption defaults    OB-06a look experiment     OB-11 review keys
Wave 2:
  OB-09 progress rows (after OB-08's type) --> OB-10 in-after-first-pack (same worker as OB-09's
                                                onboarding part; OnboardingPage.tsx)
  OB-05 add groups (after OB-01, OB-09)
  OB-13 compare mode (after OB-11, OB-14)
  OB-15 import groups (after OB-14)
Wave 3:
  OB-16 place apply (after OB-15)
  OB-06b card treatment (after the maintainer signs off OB-06a)
  OB-12 first-run timing (after OB-07, OB-08, OB-10)
```

| File | Packages touching it | How to keep them apart |
|---|---|---|
| `OnboardingPage.tsx` | OB-01, OB-09, OB-10 | OB-01 in wave 1 (lines 42-43, 174-187, 518-526 only); OB-09's onboarding part and OB-10 by one worker in wave 2 |
| `PhotoImportRows.tsx` | OB-11, OB-13, OB-14, OB-15, OB-16 | OB-11 and OB-14 touch only the review wiring and row type in wave 1; OB-13 and OB-15 in wave 2 split by region of the file (compare opener vs rows and location block); OB-16 alone in wave 3 |
| `ImportReviewRow.tsx`, `useImportReview.ts` | OB-11, OB-13 | sequential (OB-13 after OB-11) |
| `download.ts`, `apply.ts` | OB-08 only | |
| `catalogSeedUpdate.ts`, Rust shell | OB-07 (and OB-02 touches `lib.rs` window colour only) | OB-02 edits `lib.rs:217-226`; OB-07 edits `api.rs` and `embedded_db.rs`; no overlap |
| `SpeciesCard.tsx` | OB-06b only | |
| `keymap.ts` | OB-11, OB-13 | sequential |
| `en.json` | most | `git add -p`, own hunks only |

Rebuild the desktop dev app only between waves. Migrations here (OB-07 lz4, OB-08 if a column is
needed) are spec'd and pre-approved; claim numbers from the coordinator (186 is the last today).

Total: 16 packages, about 20 worker sessions; three waves, roughly 1.5 to 2.5 calendar weeks with
three or four workers, plus the OB-06a sign-off wait.

## Open decisions

1. **Line art for uncollected species.** After OB-06a's mockups: line art (precomputed), desaturated
   only, or no change beyond the seen/not-seen swap. Recommendation: precomputed line art, on by
   default, if the mockups read as "a drawing waiting for your photo" rather than "image missing".
2. **Theme default reverses a standing rule.** The 1.0 plan says "Light theme by default"; this request
   says follow the system. Recommendation: follow the system and update the rule and T1 (OB-02).
3. **Where the downloads link lives.** In the Add species menu only, or also a permanent sidebar entry.
   Recommendation: the Add species menu plus a "Downloads" row in the sidebar's bottom group beside
   Settings, since regions are what new users look for most.
4. **"Set as Featured Photo" capitalisation.** Lifer's menus are sentence case ("Add to album").
   Recommendation: "Set as featured photo" and "Featured photo" everywhere, unless you want Featured
   Photo as a named feature in title case.
5. **"No labels" scope.** Labels only, or every caption row (labels and ratings) off by default, and in
   every photo grid or only the Gallery. Recommendation: all caption rows off, shared by every grid.
6. **Up arrow no longer undoes a confirm in import review.** It moves to the previous photo; undo moves
   to Mod+Z and Backspace clears. Recommendation: yes (it is what you asked for; listed so the change of
   habit is a conscious one).

## Not verified

- Whether the packaged desktop API downloads the seed again after the failed restore
  (`BUNDLED_CATALOG_SEED_DIR` path reasoning plus file timestamps; the running app's database was not
  touched).
- lz4 support in the embedded Postgres build (`postgresql_embedded` 0.21, `theseus` feature).
- Photo-store download speed; the plan treats it as network bound and moves it off the critical path.
- The exact trigger of "unselecting reopens the species dialog"; OB-11 starts with a reproducing test.
