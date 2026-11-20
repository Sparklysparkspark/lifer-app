# Commit plan for the uncommitted 1.0 work

Status: a reviewable guide, written 2026-11-10 from `git status`, `git diff --numstat`, the plans in
`docs/plans/`, `CHANGELOG.md` and `git log`. Nothing in it was executed. The maintainer commits by hand.

HEAD is `c06573d chore(desktop): bundle Node.js 22.23.3`, on top of the 0.11.0 release. Existing commit
style: `type(scope): lowercase subject`, no body for small changes, `chore(deps)` for bumps, `docs:` for
docs, `test(e2e):` for specs. No AI attribution lines (per the maintainer's rule).

## 1. What is in the tree

2065 entries in `git status -uall` (ignoring ignored files). Counts are files.

| Area                                     | Modified | Deleted | Untracked |
| ---------------------------------------- | -------: | ------: | --------: |
| apps/api (src, scripts)                  |      166 |       2 |       147 |
| apps/web (src, public, index.html)       |      248 |      13 |       315 |
| apps/mobile (whole app is new)           |        0 |       0 |       ~180 |
| apps/desktop (Rust shell, scripts, html) |       40 |       5 |        13 |
| packages/core                            |       28 |       0 |        16 |
| packages/shared                          |       10 |       0 |        23 |
| packages/data-pipeline                   |       44 |      17 |        89 |
| packages/mcp                             |        0 |       0 |         1 |
| docs (site, guides, plans, design)       |       49 |       0 |        19 plus plans/assets |
| e2e (specs, support, visual baselines)   |       18 |       0 |        48 plus 54 baseline PNGs |
| integrations (Lightroom Classic plugin)  |        0 |       0 |         9 |
| scripts                                  |        3 |       0 |        12 |
| docker, Dockerfile, compose              |        6 |       0 |         1 |
| .github, root config, README, CHANGELOG  |       ~12 |       1 |         0 |
| packaging (flatpak), site-placeholder    |        0 |       0 |       ~9 |

Migrations 147 to 188 are all untracked (42 files). HEAD ends at 146. The plan docs say 186 was current
on 2026-11-08, so 187 and 188 are the newest.

Two index entries already staged (shown as `D ` and `RM`): `MigrationStatusIndicator.tsx`,
`useMigrationStatus.ts` (staged deletes) and the staged rename `apps/api/src/inaturalist/grouping.ts` to
`packages/shared/src/inatGrouping.ts`. `git add` for the commits below will pick these up; the rename
belongs to commit 8. If you plan commits with `git add <paths>` first run `git reset` (you, not me) so
nothing staged leaks into commit 1.

Largest diffs (all shared, see section 4): `apps/web/src/api/openapi.gen.json` (+28773), `schema.gen.ts`
(+26475), `package-lock.json` (+23417), `locales/en.json` (+3861), `i18n/en.context.json` (+1369).

### Big finding: .gitignore swallows apps/mobile/src/screens

The new ignore line `screens/` (no leading slash) also matches `apps/mobile/src/screens/` (36 files, e.g.
`AlbumsScreen.tsx`). They would silently not be committed. Change it to `/screens/` (the repo-root
Playwright screenshot dir is the intended target) before commit 1, then `git status` should show them as
untracked. No other tracked-by-intent source path is hit.

## 2. Proposed commits (in order)

Conventions used below: paths are repo relative. "Shared" means the file is also named in section 4 and
needs `git add -p`. Migration to commit mapping is in section 3. Verify commands run from the repo root;
integration tests need `DATABASE_URL=...lifer_test` (memory rule: the repo `.env` points at the Docker
`lifer` DB, never migrate that).

Realistic caveat: the web app, API and generated types were built together, so many files import things
from other themes (App.tsx, AppSidebar.tsx, en.json, routes). A commit that stages only its own files may
not typecheck until later commits land. The "checkpoint" lines mark where `typecheck` should first be
green. Between checkpoints use the narrow vitest runs only.

### Foundation

**1. chore(repo): ignore rules, lint config and design-token checks**
Body: ignore `/screens/`, open-vectors cache, Expo prebuild output; add copy, raw-control, remembered-state
and design-token check scripts with baselines.
Paths: `.gitignore` (after the `/screens/` fix), `.prettierignore`, `eslint.config.mjs`, `scripts/**`
(all 15, including `scripts/build-relief.mjs`), `.env.example`.
Shared: none. `package.json` root scripts go in commit 26.
Verify: `npm run test:scripts` (note: script not present until commit 26, so run
`node --test "scripts/*.test.mjs"`), `npx prettier --check .gitignore`.

**2. refactor(data-pipeline): drop per-group seed builders and one-off scripts**
Body: remove the ten `build-seed-<group>.ts` builders, `nonnative-obscure-taxa-review.json` and six
retired scripts; seed builds go through `build-seed.ts` and `seed-groups.ts`.
Paths: `packages/data-pipeline/src/build/build-seed*.ts`, `build/seed-groups.ts`, `build/load-seed*`,
deleted `packages/data-pipeline/src/scripts/{backfill-common-names,build-species-name-index,enrich-listed-batch,flag-nonnative-obscure-taxa,report-vagrant-ebird,verify-vagrant-fishbase}.ts`,
deleted `packages/data-pipeline/data/nonnative-obscure-taxa-review.json`.
Shared: `packages/data-pipeline/package.json` (the `build-seed-*` script entries go here; the rest of the
file goes in commit 4, use `git add -p`).
Verify: `npm run typecheck -w data-pipeline && npm run test:unit -w data-pipeline`.

**3. feat(db): migrations 147 to 188**
Body: sync and instance id, smart albums, trip dates, archive health, saved spots, named places,
gazetteer, iNat unlink/ignored/date write-back, eBird checklists, audio, portfolios, userdata write, Immich
link, pack hotspots applied, API key host open.
Paths: `packages/data-pipeline/migrations/147_*.sql` to `188_*.sql` (42 files).
Dependency: land before every API commit. All migrations in one commit is the recommendation so each later
commit's integration tests have a schema; the alternative (each migration with its feature) is mapped in
section 3.
Verify: `npm run check:migrations`, then
`DATABASE_URL=postgres://.../lifer_test_plan npm run migrate` against a scratch DB.

**4. feat(data-pipeline): gazetteer, region aliases, open vectors, catalog publish**
Body: gazetteer and named-place builders, region search aliases (Holland), open map vector source, catalog
publish and freshness checks, DB snapshot, eBird fixes and exotic flags, corrected reference data.
Paths: `packages/data-pipeline/src/pipeline/**` (gazetteer, places, regionAliases, maps, openVectors,
openVectorSource, catalogPublish, dbSnapshot, freshness, packIndex tests), `src/regions/{ebirdApi,sensitiveLabels}*`,
`src/scripts/{apply-ebird-exotics,check-ebird-only,fix-ebird-region-codes,fix-shared-inat-taxa,open-vectors,publish-catalog-seed}*`,
`src/lib/jsonGuards.ts`, `src/build/build-region-pack*`, `src/build/build-pack-index*` (lite pack index,
see commit 16), `data/reference/**`, `data/review/**`, `DATA_SOURCES.md`, `SCRIPTS.md`, `package.json`
(remaining hunks), deleted `.github/workflows/catalog-seed.yml`, `apps/api/scripts/fetch-catalog-seed.js`.
Shared: the pack-index files are also described in commit 16; keep them here (data side) and let 16 be API
and web only.
Verify: `npm run typecheck -w data-pipeline && npm run test:unit -w data-pipeline`; integration:
`npm run test:integration -w data-pipeline -- gazetteer places`.

**5. feat(core): free-space checks, resumable downloads, species inference and filing**
Body: free space and full-disk handling, safer resumable downloads, promise memo, raw cache, seasonality,
suggested filing, region boundary, user index, sensitive species and licence policy updates.
Paths: `packages/core/src/**` (28 modified, 16 new).
Verify: `npm run typecheck -w @lifer/core && npm test -w @lifer/core`.

**6. feat(shared): shared types for sync, plugins, search, places and card crops**
Body: shared constants and types used by API, web and mobile (plugin manifest and protocol, companion
pairing, photo search and filters, folder layout, metadata template, taxonomic order, design tokens).
Paths: `packages/shared/src/**` (10 modified, 23 new, including the staged rename
`inatGrouping.ts`), `packages/mcp/package.json`.
Dependency: before API and web commits.
Verify: `npx tsc --noEmit -p packages/shared` (or the root `npm run typecheck`).

### API features

**7. feat(sync): desktop to server sync, tombstones and change feed**
Body: instance id, mirror origin, push, tombstones; Settings shows last sync with Sync now; albums, trips
and tags sync both ways including deletions.
Paths: `apps/api/src/sync/**`, `apps/api/src/changes/**`, `apps/api/src/settings/uploadToServer*`
(staged rename of `migrateToServer*`), deleted `apps/api/src/species/restoredSeedVersion*`,
`apps/api/src/lib/{collectionState,libraryRecords,userSpecies,job,schema,secretBox}.ts`,
`apps/api/src/auth/{session,rateLimiter,desktopGate,publicRoutes}*`, `docs/docs/guides/sync.md`,
`docs/docs/contributing/state-and-sync.md`, `docs/docs/install/connect-desktop-to-server.md`,
`docs/plans/desktop-server-sync.md`; web: `apps/web/src/pages/settings/{SyncSettings,syncStatusText,LinkedDevices}*`,
`apps/web/src/lib/desktopLink.ts`, `apps/web/src/components/ConnectionNote.tsx`; deleted web
`MigrationStatusIndicator.tsx`, `useMigrationStatus.ts`.
Shared: `apps/api/src/apiRoutes.ts` and `apps/api/src/apiRoutes.test.ts` (route registration for every
feature, stage the sync, changes and companion registrations here, the rest with their own commit).
Verify: `npm run typecheck -w api && npm run test:integration -w api -- sync changes`.

**8. feat(inaturalist): matching, existing observations, unlink, ignore and date write-back**
Body: match photos to your existing observations, ignore, unlink, send with a date write-back, relay state;
one shared grouping module; new iNaturalist page card grid, Observations and Sightings tabs.
Paths: `apps/api/src/inaturalist/**`, `packages/shared/src/inatGrouping.ts` (staged rename),
`apps/web/src/pages/InaturalistPage*`, `apps/web/src/pages/inaturalist/**`,
`apps/web/src/hooks/{useInatStatus,useExistingCheck,useSendToInat}.ts`,
`apps/web/src/components/{SendToInatMenuItem,ViewOnInatMenuItem}.tsx`, `apps/web/public/branding/inaturalist.png`,
`docs/docs/guides/inaturalist.md`, `docs/plans/shared-inat-taxa-report.md`,
`docs/static/inat-callback/index.html`, `site-placeholder/inat-callback/**`,
`e2e/tests/*inat*`.
Migrations: 177, 178, 179, 180, 182. Dependency: after 3, 6.
Verify: `npm run typecheck -w api && npm run test:integration -w api -- inaturalist && npm test -w web -- inaturalist`.

**9. feat(places): named places, saved spots, location history and place privacy**
Body: name a spot once and Lifer works out the locality; places picker with suggestions; saved spots with
geoprivacy that no longer depends on label text; coordinates, time-shift and place folders with Undo.
Paths: `apps/api/src/places/**`, `apps/api/src/captures/{places,locationHistory,coordinates,placeFolders,takenAtShift,recheck,suggest,identification,versions}*`,
`apps/api/src/regions/{provinces,regionAt}*`, `apps/web/src/components/{PlaceNameInput,PlacePicker,PlaceStep,PlaceSuggestions,SavedSpots,CoordinatesModal,PointPickerMap,FarPhotosConfirm,FolderPath}*`,
`apps/web/src/pages/ManagePlacesPage*`, `apps/web/src/hooks/{usePlaceStep,usePlaceFiling,useSavedSpots}*`,
`apps/web/src/lib/{coordinates,placeLine,onlinePlaces}*`, `apps/web/src/hooks/useOnlinePlaces.ts`,
`docs/plans/named-places.md`, `e2e/tests/{map-placing,import-places}.spec.ts`.
Migrations: 168, 169, 181, 183, 184. Dependency: after 4 (gazetteer data) and 8 only if place sending
shares `SendToInat` (it does, via place_guess).
Verify: `npm run test:integration -w api -- places captures/places` and `npm test -w web -- PlacePicker PlaceStep`.

**10. feat(uploads): media pipeline, versions, video frames, templates and watched folders**
Body: RAW matching and versions grouping, video frame save, prepared-ahead inspection, metadata template
and folder layout settings, watched folders, library reimport and unmatched suggestions, archive-health
inputs, sound recordings.
Paths: `apps/api/src/uploads/**` (39), `apps/api/src/library/**`, `apps/api/src/settings/{metadataRoutes,metadataSettings,autoDownloads,deleteLocalLibrary,speciesNameDisplay}*`,
`apps/api/src/originals/**`, `apps/api/src/photos/**`, `apps/api/src/storageVolumes/**`,
`apps/web/src/pages/settings/{MetadataSettings,WatchedFoldersGroup,LibraryReimportSection,ArchiveHealthRows,BringInWorkGroup}*`,
`apps/web/src/pages/ArchiveHealthPage*`, `apps/web/src/components/{PhotoVersions,VersionSuggestions}*`,
`docs/docs/guides/{metadata-and-file-names,library-folders,importing}.md`, `docs/plans/archive-health.md`,
`e2e/tests/{archive-health,bad-files,video-frame,sound-recordings}.spec.ts`, `e2e/fixtures/bad-files/**`.
Migrations: 155, 158, 160, 161, 171, 175, 185. Dependency: after 3, 5.
Verify: `npm run test:integration -w api -- uploads library` and `npm test -w @lifer/core`.

**11. feat(search): Gallery photo search, multi-value filters, pinned filters and smart albums**
Body: search tokens and synonyms, region search by other names, rating ranges, filters take several values
and can be pinned as chips, smart albums with suggestions and export, trip dates.
Paths: `apps/api/src/gallery/{photoSearch,searchRank,searchTerms,searchTaxonSynonyms,routes,responses}*` and
their tests, `apps/api/src/albums/**`, `apps/api/src/trips/**`, `apps/web/src/pages/gallery/**`,
`apps/web/src/pages/album/**`, `apps/web/src/pages/trip/**`, `apps/web/src/lib/{regionSearch,tripDates,tripChoice}*`,
`apps/web/src/lib/search/**`, `apps/web/src/components/{PhotoFiltersMenu,StarRangePicker,SmartAlbumLabel,TripCard}*`,
`apps/web/src/pages/{GalleryPage,AlbumDetailPage,TripDetailPage,SimilarPhotosPage}*`,
`docs/docs/guides/{gallery-and-search,filters-and-pins,albums-and-sharing,trips}.md`,
`e2e/search-golden/**`, `e2e/support/searchGolden*`, `e2e/tests/{multi-value-filters,pinned-filters,rating-range,region-search,search-tokens,smart-album-restore,find-similar,gallery-selection}.spec.ts`,
`e2e/tests/journeys/smart-album-tag.spec.ts`.
Migrations: 154, 156, 157, 165. Verify: `npm run test:integration -w api -- gallery albums trips` and
`npm test -w web -- gallery`.

**12. feat(map): calmer map, shaded relief, species pins, detail tiles and satellite**
Body: photo map with side panel, hover cards and a Needs placing tray, place photos by dropping on the
map, optional online detail and satellite, per-country detail downloads, palette tokens for land, water and
forest.
Paths: `apps/api/src/collection/{map,mapSql,pinOutline}*`, `apps/api/src/gallery/{map,mapArea}*`,
`apps/api/src/offlinePacks/mapDetail.ts`, `apps/api/src/opendata/**`, `apps/web/src/components/map/**`,
`apps/web/src/components/{PhotoMap,RegionMap,RegionViewBar}*`,
`apps/web/src/lib/{map*,countryBoundaries,regionFraming.json,anchoredBox,zoomOnto,zoomOvershoot}*`,
`apps/web/src/hooks/{useOnlineMap,useRegionCamera,useRegionsWithPhotos}*`,
`apps/web/src/pages/settings/{MapSettingsRows,DetailedMapsRows}*`, `apps/web/public/map-glyphs/**`,
`docs/docs/guides/photo-map.md`, `docs/docs/guides/offline-packs-and-map.md`,
`docs/plans/{map-location-ux,map-detail-and-satellite}.md`, `e2e/tests/journeys/region-pack.spec.ts`.
Shared: `apps/web/src/theme.css` and `index.css` (map colour tokens and map CSS only, section 4).
Dependency: after 9 (needs-placing tray applies places) and 4 (open vectors).
Verify: `npm run test:integration -w api -- collection/map gallery/map` and `npm test -w web -- map`.

**13. refactor(web): one card shell, one photo grid, one photo menu, one modal**
Body: MediaCard replaces the lookalike cards, PhotoGrid and PhotoMenu replace per-page copies, shared Menu,
Panel, Tooltip, Slider, TextField and Checkbox; modals follow one pattern; caption and sort defaults.
Paths: `apps/web/src/components/{MediaCard,PhotoGrid,PhotoMenu,PhotoTileCaption,PhotoGridControls,Menu,Panel,Tooltip,Slider,TextField,Checkbox,SelectMark,SelectionActionRow,Tip,ZoomPane,Lightbox,PhotoTile,SpeciesCard,GroupedSpeciesGrid,DotsIcon,MagnifierIcon,PlusIcon}*`,
`apps/web/src/lib/{cardImage,cardPlacement,photoGridSections,compareZoom,exclusivePopover,fieldClasses,speciesGrouping}*`,
`apps/web/src/hooks/{useAnchoredPosition,useFocusTrap,useListCardSize,usePhotoCaptionPrefs,usePhotoEdits,useCuratedTilt}*`,
deleted `AddToAlbumButton.tsx`, `DotMenu.tsx`, `pages/gallery/GalleryTile.tsx`, `pages/species/CaptureMenu.tsx`,
`packages/shared/src/cardCrop.ts` (if not already in 6), `docs/plans/{shared-card,shared-photo-grid}.md`,
`docs/plans/assets/{shared-card,shared-photo-grid,modals}/` (see section 5, probably do not commit),
`e2e/tests/{modals,view-menus,affordance}.spec.ts`.
Shared: `locales/en.json`, `index.css`, `theme.css`. Dependency: before 14, 15, 11 should re-run after this.
Checkpoint: after 13 run `npm run typecheck -w web`; the page commits before it reference these components,
so expect red until here, which is why 11 and 12 verify with narrow tests only.
Verify: `npm run typecheck -w web && npm test -w web`.

**14. feat(collection): species pins, add species, downloaded-only tree, uncollected look**
Body: select several species or groups and act on them; Add species with groups; hub boundaries;
uncollected species dim and grey; tree only shows downloaded taxa; best-photo order.
Paths: `apps/api/src/collection/{bulk,tree,photoSetSpecies,collectionItem,defaultCardCrop,routes,responses}*`,
`apps/api/src/species/**`, `apps/api/src/lib/{bestPhotoOrder,taxonomicOrder}.ts`,
`apps/web/src/pages/{CollectionPage,CollectionsPage,SpeciesDetailPage}*`, `apps/web/src/pages/collection/**`,
`apps/web/src/pages/species/**`, `apps/web/src/components/{AddedSpeciesList,ManageListPage,SpeciesNameText}*`,
`apps/web/src/lib/{speciesDownloads,taxaColour,tierDescription}*`, `apps/web/src/hooks/useCuratedTilt.ts`,
`docs/docs/guides/collection-and-checklists.md`, `docs/plans/assets/uncollected-look/`,
`e2e/tests/{collection-add-groups,collection-select,hierarchy}.spec.ts`.
Migrations: 151, 153. Verify: `npm run test:integration -w api -- collection species` and
`npm test -w web -- Collection`.

**15. feat(import): review groups, compare mode, place step and location apply**
Body: import review groups by place, compare mode with arrow keys and zoom, a location step that applies
places in one go, per-row version grouping, trip import form.
Paths: `apps/api/src/imports/**`, `apps/web/src/components/importReview/**`,
`apps/web/src/components/{CompareView,PhotoImportRows,AddedSpeciesList}*`, `apps/web/src/pages/import/**`
(except `LightroomImport`, commit 18), `apps/web/src/pages/trip/ImportTripForm*`,
`apps/web/src/pages/settings/OrderedChecklist*`, `docs/docs/contributing/imports-and-metadata.md`,
`e2e/tests/{import,import-places,gallery-selection}.spec.ts`.
Dependency: after 9 and 13. Verify: `npm run test:integration -w api -- imports` and
`npm test -w web -- importReview PhotoImportRows`.

**16. feat(packs): offline first pack index, weak-signal downloads, free-space notes**
Body: lite pack index so Collection works before any download, resumable downloads that survive weak
signal, downloads check free space and say how much is needed, hotspots applied after download; the old
desktop offline page cache is removed.
Paths: `apps/api/src/offlinePacks/**` (except `mapDetail.ts`), `apps/api/src/sync/packs.ts` (if staged in 7,
leave there), `apps/web/src/components/{PackDownloadTray,PackProgress,FreeSpaceNote,DownloadedPacksList}*`,
`apps/web/src/lib/{packProgress,timeLeft,rateLimitWait,readyMarker}*`,
`apps/web/src/hooks/{useTimeLeft,useTaskbarProgress}*`, `apps/web/src/pages/{OfflinePacksPage,offlinePacks/**}*`,
deleted `components/OfflineCacheSync.tsx`, `lib/offlineCache*`, `pages/settings/OfflineCacheSetting.tsx`,
deleted desktop `offline_cache.rs`, `src/offline.html`, `src/offline.js`,
`apps/desktop/src-tauri/tests/offline-cache-integration.sh`, `docs/docs/install/requirements.md`.
Migration: 187. Dependency: after 4 (build-pack-index) and 5. Verify: `npm run test:integration -w api -- offlinePacks`
and `npm test -w web -- Offline Pack`.

**17. feat(onboarding): setup flow, download page, tips and guided tour (OB-07 to OB-10)**
Body: first run shows a download page, separates download from apply, reaches the Collection sooner; setup
tips, a short tour, and hints that can be turned off.
Paths: `apps/web/src/pages/OnboardingPage*`, `apps/web/src/components/{SetupTips,Tour,Tip}*`,
`apps/web/src/lib/{setupTips,tips,mainPages}*`, `apps/web/src/hooks/useTip.ts`,
`apps/api/src/settings/{autoDownloads,routes}*` (tips and onboarding parts, `git add -p`),
`docs/docs/getting-started.md`, `docs/plans/onboarding-import-overhaul.md`,
`e2e/tests/{first-run,first-run-setup,tour}.spec.ts`, `e2e/visual/tour.visual.spec.ts`.
Migration: 147, 187 (shared with 16). Dependency: after 16. Verify: `npm test -w web -- OnboardingPage`
and `npx playwright test e2e/tests/first-run-setup.spec.ts`.

**18. feat(integrations): Lightroom Classic, eBird, Immich, public API and MCP**
Body: Lightroom catalogue import (read only) and a plugin that tags photos; eBird "My eBird Data" import;
Immich link; OpenAPI document and an MCP server for assistants with the access you approve.
Paths: `apps/api/src/integrations/**`, `integrations/lightroom-classic/**`,
`apps/web/src/pages/import/LightroomImport*`, `apps/web/src/pages/settings/{ConnectedAppsSettings,ImmichSettings}*`,
`docs/docs/guides/{lightroom,connected-apps,ebird-import}.md`, `docs/docs/api/{overview,mcp}.md`,
`docs/plans/plugin-host-and-integration-api.md`, `e2e/tests/{lightroom-import,ebird-checklists}.spec.ts`.
Migrations: 170, 186. Verify: `npm run test:integration -w api -- integrations` and
`lua integrations/lightroom-classic/lifer.lrplugin/tests/keywords_test.lua` if Lua is installed.

**19. feat(plugins): plugin host preference, Cull grant and userdata endpoints**
Body: companion apps run as their own process and show a page inside Lifer; per-key host-open preference;
Cull entry and grant; read and write endpoints for the user's own species photos.
Paths: `apps/api/src/plugins/**`, `apps/api/src/userdata/**`, `apps/api/src/auth/apiKeyRoutes*`,
`apps/api/src/auth/{responses,session}*` (shared with 7), `packages/shared/src/{pluginManifest,pluginProtocol,cull}.ts`,
`apps/web/src/components/{PluginFrame,PluginFrames,PairingConsentModal,HostOpenListener,OpenInMenuItems}*`,
`apps/web/src/pages/{PluginPage,PluginOfferPage}*`, `apps/web/src/lib/{plugins,pluginHost,hostPreference,suggestedApps,cullPrice}*`,
`apps/web/src/hooks/useOpenInEditors.ts`, `e2e/fixtures/example-plugin/**`, `e2e/tests/plugins.spec.ts`,
`docs/docs/api/plugins.md`, `docs/docs/guides/culling-with-other-apps.md`.
Migrations: 162, 176, 188. Verify: `npm run test:integration -w api -- plugins userdata auth` and
`npm test -w web -- Plugin`.

**20. feat(library): portfolio export, archive health, sensitive species, crash reports, year in review**
Body: export best photos and life list as a website without exact locations; sensitive species hidden by
region everywhere a location leaves Lifer; crash reports offered on next open (send only on click); Review
and Year in Review pages; keyboard shortcut sheet.
Paths: `apps/api/src/portfolio/**`, `apps/api/src/crashReports/**`, `apps/api/src/stats/**`,
`apps/api/src/captures/{hidden,trash,tags}*`, `apps/api/src/shares/**`, `apps/api/src/csp*`,
`apps/web/src/pages/{PortfolioPage,SensitiveSpeciesPage,ReviewPage,YearInReviewPage,TaxaExplorer}*`,
`apps/web/src/pages/stats/**`, `apps/web/src/components/{CrashBoundary,CrashReportSheet,ShortcutSheet}*`,
`apps/web/src/lib/keymap*`, `apps/web/src/hooks/{useReviewCount,useAnnounceSuggestionChanges}*`,
`docs/docs/guides/stats.md`, `docs/docs/privacy.md`, `docs/docs/security-model.md`,
`docs/plans/keyboard-shortcuts.md`, `e2e/tests/{portfolio,keyboard,long-actions}.spec.ts`.
Migrations: 159, 166, 167, 172, 173, 174. Verify: `npm run test:integration -w api -- portfolio crashReports stats`.

### Cross-app

**21. feat(settings): simpler sidebar, Albums and Trips merge, Species downloads, Settings reorganised**
Body: sidebar becomes Collection, Gallery, Map, Albums, Stats, then iNaturalist and suggested apps; Trips
sit under Albums; region downloads move to Settings > Offline maps and regions; old links redirect;
Docker password no longer needs setting.
Paths: `apps/web/src/components/{AppSidebar,WindowTitleBar,TransitionRouter,Tip}*`, `apps/web/src/pages/settings/**`
not claimed above (`PhonesSettings`, `RegionsSettings`), `apps/web/src/pages/SettingsPage*`,
`apps/web/src/hooks/{useNavCounts deleted,useCommandPalette,useTheme}*`, `docs/docs/settings.md`,
`e2e/tests/{navigation,settings,albums-trips-switch,logout}.spec.ts`, `docs/docs/faq.md`.
Shared: `apps/web/src/App.tsx` (routes and layout, whole file here since it wires every page; commit it
last among 8 to 21 if you want earlier checkpoints green).
Verify: `npm run typecheck -w web && npm test -w web -- App AppSidebar Settings` and
`npx playwright test e2e/tests/navigation.spec.ts`.

**22. feat(web): theme, brand icons and design tokens**
Body: sage accent at WCAG AA, white controls, taxa colours, dark sidebar and viewer surround; new icons and
wordmarks; boot script avoids a theme flash; design-token export.
Paths: `apps/web/src/{theme.css,index.css}` (the non-map hunks), `apps/web/public/theme-boot.js`,
`apps/web/index.html`, `apps/web/public/*.png`, `apps/web/public/branding/*.png`,
`apps/web/src/lib/themeFade*`, `packages/shared/src/designTokens.ts`, `docs/design/**`,
`docs/static/img/*.png`, `apps/desktop/src-tauri/icons/**`, `apps/desktop/src/app-icon.png`,
`docs/src/css/custom.css`.
Shared: `theme.css` and `index.css` (see section 4). Verify: `npm run check:design-tokens` and
`npm test -w web -- contrast`.

**23. feat(mobile): companion app (Expo)**
Body: phone companion with pairing by QR, pinned fetch, local search and offline library, native modules.
Paths: `apps/mobile/**` (excluding ignored `ios/`, `android/`, `.expo/`, `node_modules/`), `docs/plans/{mobile-app,mobile-app-research,mobile-implementation-plan,mobile-ux-plan}.md`,
`apps/api/src/companion/**` (if not already in 7), `packages/shared/src/{companionPairing,companionPake}.ts`.
Dependency: after 6, 7. Verify: `npm run typecheck -w mobile && npm test -w mobile && npm run check:mobile`.

**24. feat(desktop): shell changes (tray, companion, plugins, editors, crash report, window state)**
Body: Rust shell gains tray, server link, window state, open in editors, plugin install, companion listener
and crash reports; the old offline cache and window controls are removed.
Paths: `apps/desktop/src-tauri/src/**`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `capabilities/**`,
`permissions/**`, `entitlements.plist`, `apps/desktop/src/{index.html,picker.html,picker.js}`,
`apps/desktop/scripts/**`, `packaging/flatpak/**`.
Dependency: icons are in 22, offline deletions in 16. Verify:
`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

### Docs, tests, release

**25. docs: site redesign, guides and contributor pages**
Body: new home, download, self-hosting and site-kit pages; updated install, privacy and contributor docs.
Paths: `docs/src/**`, `docs/docusaurus.config.ts`, `docs/sidebars.ts`, `docs/package.json`, `docs/tsconfig.json`,
`docs/docs/**` not claimed above, `docs/plans/*.md` not claimed above (`lifer-1.0-implementation-plan`,
`lifer-website-plan`, `library-first`, `ux-*`, `world-class-ux`, `extreme-fixture-findings`, `next-catalog-republish`, `commit-plan.md`),
`README.md`, `THIRD_PARTY_NOTICES.md`, `TECH_DEBT_AUDIT.md`, `site-placeholder/**`.
Verify: `npm run build -w docs && npm test -w docs`.

**26. test(e2e): realistic and extreme libraries, visual baselines, known failures**
Body: extreme and realistic fixture libraries, sweeps (dark, failure, back-navigation, monkey, performance),
visual tour and baselines.
Paths: `e2e/support/**`, `e2e/extreme/**`, `e2e/visual/**`, `e2e/playwright.*.config.ts`, `e2e/known-failures.json`,
`e2e/perf-baseline.json`, `playwright.config.ts`, remaining `e2e/tests/**`.
Verify: `npx playwright test e2e/tests/first-run.spec.ts --list` (typecheck of specs) and one real spec run.

**27. chore(ci): CI, release and Docker changes**
Body: CI jobs for mobile, scripts, checks and e2e; release workflow updates; generated Docker DB password.
Paths: `.github/**`, `Dockerfile`, `docker-compose.yml`, `docker/**`, `.env.example` if not in 1.
Verify: `actionlint` if installed; `docker compose config`.

**28. chore: regenerate API types, locales, lockfile and changelog (cross-cutting)**
Body: openapi.gen.json, schema.gen.ts, en.json, en.context.json, root package.json scripts,
package-lock.json (npm 11 only: `npx -y npm@11 install --package-lock-only`), CHANGELOG.
Paths: `apps/web/src/api/{openapi.gen.json,schema.gen.ts}`, `apps/web/src/locales/en.json`,
`apps/web/src/i18n/en.context.json`, `apps/mobile/src/locales/en.json` (if not in 23), `package.json`,
`package-lock.json`, `apps/web/package.json`, `apps/api/package.json`, `docs/package.json` (if not in 25),
`CHANGELOG.md`.
Verify: `npm run gen:api-types && npm run check:api-types && npm run check:i18n && npm run check:em-dashes && npm run typecheck && npm test`.
Dependency: last. Honest option: if you do not want to hand split the shared files, put them here whole and
accept that commits 7 to 22 are not individually green (section 4).

## 3. Migration to commit map

| Migrations                               | Feature                                              | Commit |
| ---------------------------------------- | ---------------------------------------------------- | ------ |
| 147 tips                                 | tips and tour                                        | 17     |
| 148, 149, 150, 152, 163, 164             | instance id, mirror, push, tombstones, library sync  | 7      |
| 151, 153                                 | cover chosen photo, dead rarity scores               | 14     |
| 154, 156, 157, 165                       | any-taxa search default, smart albums, trip dates, similar dismissals | 11 |
| 155, 158, 160, 161, 171, 175, 185        | folder layout, subject count, archive health, photos changed, audio, search frames, original roles | 10 |
| 159, 166, 167, 172, 173, 174             | share exact locations, assistant batches, suggested IDs, portfolios, drop seasonality, vector licences | 20 |
| 162, 176, 188                            | API key plugin, userdata write, host open            | 19     |
| 168, 169, 181, 183, 184                  | saved spots, region places and aliases, named places, gazetteer, dismissals | 9 |
| 170, 186                                 | eBird checklists, Immich link                        | 18     |
| 177, 178, 179, 180, 182                  | iNat ignored, date write-back, noon dates, existing observations, unlink | 8 |
| 187                                      | pack hotspots applied                                | 16     |

Recommended: ship all of them together in commit 3 and keep this table as the reviewer's index. 148 and
152 are consumed by the sync code in 7, 181 and 183 by 9 and the gazetteer data in 4. Do not reorder
numbers; `check:migrations` rejects gaps.

## 4. Shared files (use `git add -p`, or the cross-cutting commit)

| File                                              | Hunks and which commit takes them |
| ------------------------------------------------- | --------------------------------- |
| `apps/web/src/api/openapi.gen.json`, `schema.gen.ts` | Whole file is generated from every API route. Regenerate (`npm run gen:api-types`) in commit 28. Hand splitting is not worth it. |
| `apps/web/src/locales/en.json`                    | Split by top level key: `inaturalist.*` to 8, `places.*`, `placePicker.*`, `savedSpots.*` to 9, `map.*`, `photoMap.*` to 12, `gallery.*`, `smartAlbum.*`, `filters.*` to 11, `collection.*`, `addSpecies.*` to 14, `import.*`, `compare.*` to 15, `packs.*`, `offline.*` to 16, `onboarding.*`, `tour.*`, `tips.*` to 17, `lightroom.*`, `ebird.*`, `immich.*` to 18, `plugins.*` to 19, `portfolio.*`, `crash.*`, `shortcuts.*` to 20, `settings.*`, `nav.*` to 21. Keys cannot stay unused (`check:i18n`), so only add a key in the commit that uses it, or put the file whole in 28. |
| `apps/web/src/i18n/en.context.json`               | Same key split as en.json, always together with it. |
| `apps/web/src/theme.css`, `index.css`             | Hunks with `--color-map-*` and `.map-*` rules to 12; `--color-taxa-*` to 14; `--color-accent`, `--color-control*`, `--color-link`, `--color-sidebar`, `--color-surround` and dark overrides to 22. |
| `apps/web/src/App.tsx`                            | Imports and routes for each lazy page belong to the page's commit (Similar to 11, Lightroom to 18, ArchiveHealth to 10, Sensitive/Portfolio/Review/YearInReview to 20, Plugin pages to 19, ManagePlaces to 9), layout, sidebar wiring, tour, crash boundary and redirects to 21. Simplest: stage whole in 21. |
| `apps/web/src/components/AppSidebar.tsx`          | Untracked (new). One commit, 21. |
| `apps/api/src/apiRoutes.ts`, `apiRoutes.test.ts`  | One registration line per feature router; stage with each feature, or whole in 7. |
| `apps/api/src/integrations/openapi.ts`            | Describes routes from several features; whole in 18. |
| `apps/api/src/auth/*`                             | `session`, `rateLimiter`, `desktopGate` to 7; `apiKeyRoutes`, `responses` to 19. |
| `apps/api/src/captures/routes.ts` and `captures/responses.ts` | Places and coordinates to 9, hidden and trash to 20, identify to 9. |
| `apps/api/src/settings/routes.ts`                 | Metadata to 10, sync to 7, auto downloads and tips to 17. |
| `packages/data-pipeline/package.json`             | Script entries removed to 2, the rest to 4. |
| `package.json`, `package-lock.json`               | 28 (lockfile via `npx -y npm@11` only). |
| `CHANGELOG.md`                                    | 28; one block with Added and Changed that already reads as one release. |

Riskiest overlaps, in order: `en.json` plus `en.context.json` (a missing key fails the app at runtime and
the i18n check); `App.tsx` and `AppSidebar.tsx` (every page commit depends on routes); generated API types
(they will differ from a hand-merged one, always regenerate); `captures/routes.ts` (places, hidden, tags,
identification all in one file); `theme.css`/`index.css` (map and brand tokens interleaved).

## 5. Files that should NOT be committed

| Path                                           | Size / why                                       | Handle with |
| ---------------------------------------------- | ------------------------------------------------ | ----------- |
| `apps/api/dist-triage/` (11 files)             | 12.5 MB `models/yolov8n.onnx`, 4.4 MB source map, 2 MB bundle: a built scratch folder | `.gitignore`: `apps/api/dist-triage/`; also `apps/api/scripts/.triage-build.mjs` looks like its builder, ignore or delete |
| `docs/plans/assets/` (~87 MB: map-palette 40 MB, shared-card 31 MB, uncollected-look 12 MB, modals 3.8 MB, shared-photo-grid 3.7 MB) | before and after screenshots at 2560 px, individual files 1 to 3.7 MB | Do not commit. `.gitignore`: `docs/plans/assets/`; keep a few small ones by hand if the plans link them, and downsize to under 200 KB. The plans reference them, so either drop the image links or move to a release asset |
| `e2e/visual/__screenshots__/` (54 PNG, 8.7 MB) | Visual regression baselines: normally committed. Platform specific (`chromium-darwin`, `webkit-darwin`), so CI on Linux will not match them | Commit only if CI runs on macOS, else ignore `e2e/visual/__screenshots__/*-darwin/` |
| `screens/`, `test-results/`, `playwright-report/` | Already ignored. Fix `screens/` to `/screens/` (section 1) | `.gitignore` |
| `apps/mobile/node_modules`, `ios/`, `android/`, `.expo/` | Ignored already (2.5 GB under `apps/mobile`) | existing |
| `.env`, `.cache/`, `.claude/`, `apps/desktop/.updater-keys/`, `apps/desktop/src-tauri/{binaries,gen,resources-staging,target}/` | Ignored already. `.updater-keys` holds signing keys, double check it is covered (it shows as `!!`, ignored) | existing |
| `e2e/perf-baseline.json`, `e2e/known-failures.json` | Small, intentional, commit | none |
| `packages/data-pipeline/data/review/shared-inat-taxa-applied-2026-10-20T1730.tsv` | Timestamped run output, check size and whether it is a record worth keeping | review by hand |
| `site-placeholder/` | Placeholder site; confirm it is meant for the repo (it duplicates `docs/static/inat-callback`) | maintainer call |

Only files over 5 MB found in the untracked set: `apps/api/dist-triage/models/yolov8n.onnx` (12.5 MB).
Modified tracked files over 1 MB: `openapi.gen.json` (1.4 MB), `package-lock.json` (1.1 MB), `schema.gen.ts`
(1.1 MB), `species-merges.tsv` (0.5 MB), `icon.icns` (0.4 MB). Several untracked PNGs under
`docs/plans/assets/` are 2 to 3.7 MB each (below 5 MB).

Suggested `.gitignore` additions:

```
/screens/
apps/api/dist-triage/
docs/plans/assets/
```

and replace the existing `screens/` line with `/screens/`.

## 6. Suggested order of work

1. Fix `.gitignore`, then commits 1 to 6 (foundation, all low risk, can be verified alone).
2. 7 to 12 (API features). Verify with the narrow integration runs.
3. 13 then 14, 15, 16, 17: first typecheck checkpoint for web is after 13 and again after 21.
4. 18 to 20, then 21 (App.tsx wiring), then 22 to 24.
5. 25 to 27, then 28 last, regenerate the shared files from the final tree.
6. After 28: `npm run check:all && npm run typecheck && npm test`.
