# Tech Debt Audit: Lifer

Generated: 2026-10-08, against `71dbfa9` (release 0.10.2). First run.

## Executive summary

- **1 Critical, 16 High, 49 Medium, 18 Low** across 84 findings (F81-F84 added after maintainer answers). Baseline hygiene is unusually good: `tsc` clean in every workspace, ESLint clean, `npm audit` 0 vulnerabilities, default `clippy` clean, 5 `any` in 140k lines, every GitHub Action SHA-pinned, Docker non-root. The debt is not in the types; it's in duplicated logic that has drifted, and in tests that exist but never run.
- **Critical (F01):** `build-catalog-seed.ts` NULLs every reference-photo path in the live maintainer DB, keeps the only backup in process memory, and restores it row by row in `finally`. A kill or crash mid-dump loses the paths. The crash-safe pattern already exists 10 lines above it for `tier_explain`.
- **Files land in the wrong folder (F02):** RAW and video imports build the species folder path without the user's naming styles or the iNat iconic taxon, so for any Other Taxa species (insects, plants, fungi) the `RAW/` folder lands under a different taxon folder than its JPEG. That breaks the README's core layout promise; Reorganize then moves them again.
- **Two copies of CLIP preprocessing (F03):** the pipeline's `embeddings.ts` has its own preprocessing with no grayscale handling. A 1-channel reference photo reads past the buffer and yields a NaN/garbage vector that ships in the catalog and is compared against users' photos.
- **Tier philosophy violated in two live code paths (F08, F09):** a percentile-quota fallback in `apply-rarity-phase4.ts` (reachable via `npm run compute-elusiveness`, and marine invertebrates now exist to hit it) and a percentile-rank local tier written by `compute-provinces-bulk.ts`.
- **Tests that never run (F04, F05, F33):** 25 Rust tests, including `pg_upgrade` crash recovery for the user's only database, are never run by CI; the end-to-end upgrade test is manual-only and not part of release.
- **Pipeline publish safety (F07, F10, F11, F12):** publish doesn't require the gate; the scheduled job bypasses `refresh` and becomes a no-op after one sweep; tier computation silently skips countries; the GPU ID-model filename the exporter writes isn't the one the app downloads.
- **Owner lockout (F06):** 50 failed logins for the owner's email from any IPs lock the owner out for 15 minutes, repeatable indefinitely. The comment above the check claims the opposite.
- **Web app is effectively untested where it matters (F14):** no DOM test environment, so 34k lines of React have zero hook/component tests; the import-undo path silently creates duplicates on a failed delete (F13).
- **Largest debt concentration:** `apps/api/src/uploads/*` (5 hand-written `INSERT INTO captures`, a 530-line `importPhoto`, 3 ways to build a library path) and the HTTP-client sprawl across `packages/core` and the pipeline (2 functions both named `fetchWithRetry`, 4+ independent iNat rate limiters, 6 User-Agent strings).

## Architectural mental model

Lifer is one Fastify API process (`apps/api`) that serves the JSON API, the built React SPA (`apps/web`) and offline map tiles, backed by plain Postgres. The same build runs in two deployments: a Docker server (one account, login, share links, API keys) and a Tauri desktop shell (`apps/desktop`) that embeds Postgres, runs migrations, then launches the API as a Node sidecar with a launch token instead of a login. Species identification runs in-process: `packages/core/src/species/inference.ts` queues work to a worker thread (or, when a downloaded GPU runtime is active, a forked child process) running CLIP ViT-L/14, BioCLIP 2 and YOLOv8n on onnxruntime. The user's photo library is a real species folder tree on disk; Lifer writes species and ratings into the files (and `.lifer` recovery files) so the library survives without the DB.

Species data is not computed on installs. `packages/data-pipeline` is a maintainer toolchain (one `refresh` orchestrator plus ~50 standalone scripts) that runs against a maintainer Postgres, then publishes a catalog seed, region packs, a photo store, a basemap and models as GitHub prerelease assets with checksums. Installs download and verify. `packages/core` is the shared library for the API and pipeline; `packages/shared` is types for API and web.

**Where reality differs from the docs:** the API's config lives in `packages/core/src/config.ts`, not `apps/api/src/config.ts` (architecture.md:53). Inference is not only a worker thread; there is a child-process mode for GPU runtimes that architecture.md and ADR 0008 don't mention. `packages/core` is less "shared" than described: about half its modules (`regions/inatChecklist`, `buildRegionSpecies`, `gbif/*`, `computeRarityPhase1`) are pipeline-only, and one of them writes into `packages/data-pipeline/data/`. `packages/shared` contains Node-only `Buffer` code that the web app must never import.

## Findings

Severity is calibrated to this project: Lifer servers have exactly one account by design (security-model.md:10), so missing `user_id` filters are latent, not cross-user leaks.

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|----------|-----------|----------|--------|-------------|----------------|
| F01 | Data integrity | packages/data-pipeline/src/scripts/build-catalog-seed.ts:290 | Critical | S | Copies all path columns into an in-memory array, then commits `UPDATE ... SET path = NULL` on the live `species`/`species_reference_photos`. Restore is one UPDATE per row in `finally` (:415). A kill, OOM or crash during the dump loses every reference-photo path. `tier_explain` (:285) already uses a DB backup table that the next run restores. | Immediately: back up path columns into a `seed_path_backup` table like `tier_explain`, restore with one `UPDATE ... FROM`. Properly: dump from a scratch schema and never mutate source tables (Top 5 #1). |
| F02 | Correctness | apps/api/src/uploads/raw.ts:84 | High | M | Species folder paths are assembled by hand at ~10 sites. `raw.ts` (84, 184, 295) omits `inatIconicTaxon` and `namingStyles`; `video.ts:237` hard-codes `namingStyles: []`; `common.ts:152` omits both; `trips/import.ts:186` queries `users` directly. `organizedPath.ts:12` uses those fields to pick the taxon folder, so Other Taxa RAWs/videos land in a different tree than their JPEG. | One `speciesFolder(userId, speciesId, base, opts)` in `managedFolders.ts` built on `speciesFolderParts` + `getUserFileSettings`; all callers use it (Top 5 #2). |
| F03 | Correctness / Duplication | packages/data-pipeline/src/embeddings.ts:57 | High | S | Standalone copy of core's CLIP preprocessing. It always indexes `data[i*3+c]`, with no `toRgb` (core: inferenceWorker.ts:295), so grayscale sources produce NaN/garbage catalog vectors. Also skips the pixel limit and model checksum. Its stated reason (avoid sharp/onnxruntime deps) is false: the file imports both. | Delete it; call core's `computeEmbedding` with a full-precision placement override. Recompute only reference vectors from 1-channel sources (Top 5 #3). |
| F04 | Test debt | .github/workflows/ci.yml:204 | High | S | Desktop CI job runs only `cargo fmt` and `clippy`. 25 Rust tests (9 in `pg_upgrade.rs`, incl. the bundled-major agreement check desktop-app.md:99 relies on) never run automatically. | Add `- run: cargo test --lib --locked` after clippy. |
| F05 | Test debt | .github/workflows/desktop-build.yml:99 | High | M | The 17-to-18 `pg_upgrade` end-to-end test (with crash recovery) runs only via manual `workflow_dispatch` with an opt-in box; `release.yml` never runs it, yet every release ships `postgres-previous`. | Make `desktop-build.yml` callable and run the pg-upgrade job (arm64 at least) from `release.yml`, and on PRs touching `pg_upgrade.rs`/`embedded_db.rs`/`stage-postgres.js`. |
| F06 | Security | apps/api/src/auth/routes.ts:96 | High | S | Per-email cap (50 failures / 15 min) applies regardless of IP, and success clears only the email+IP key (:114). Anyone who knows the owner's email can lock them out indefinitely. Comment at :91 says the opposite. | Exempt a signed "known device" cookie from the per-email cap and clear `emailKey` on success (sketch in Top 5 #5). |
| F07 | Publish safety | packages/data-pipeline/src/scripts/refresh.ts:419 | High | S | `publish` checks only that `packs` ran, not that `gate` passed. `--stages=packs,publish --publish` ships ungated. Stages run in user-typed order (:371). | Require a `done` gate row with `ok=true` for this runId; sort requested stages by `STAGES` order. |
| F08 | Tier philosophy | packages/data-pipeline/src/build/apply-rarity-phase4.ts:218 | High | S | "Fallback for any other taxon (none seeded today): the percentile-quota system." Marine invertebrates are now seeded, and `npm run compute-elusiveness` (package.json:27) still rewrites `species_rarity.tier`. | Decided: the scores are dead (nothing reads `elusiveness_score`/`composite`/`range_score`/`abundance_score`; compute-global-tiers.ts:86 says they "no longer decide anything"). Delete the quota branch and every `species_rarity` write in apply-rarity-phase4, keeping only the endemic computation (see F81). |
| F09 | Tier philosophy | packages/data-pipeline/src/scripts/compute-provinces-bulk.ts:1071 | High | M | Builds a local tier from within-province percentile ranks of record count and spread (:1070-1071) and writes `region_species.local_tier` (:1231). `compute-local-tiers` overwrites it only for countries with partitions, so rank-based tiers survive elsewhere (see F11). | Decided: fix, but keep the shipped packs close to what they are. Replace each percentile-rank sub-score with a fixed absolute scale (e.g. log record count against constant breakpoints), calibrate the breakpoints so a dry run reproduces today's local tiers for most species, and review the diff before writing. Stop writing `local_tier` here if compute-local-tiers covers every country after F11. |
| F10 | Pipeline / single command | packages/data-pipeline/ops/scheduled-refresh.sh:63 | High | S | Scheduled job calls `refresh-all-provinces` directly, not `refresh`, with no `--reset-checkpoint`: after one full sweep every later run does nothing. No tiers or gate stage follows. | Decided: refresh stays manual. Delete `ops/scheduled-refresh.sh` and its timer so nobody runs the broken wrapper. |
| F11 | Silent stale data | packages/data-pipeline/src/scripts/compute-local-tiers.ts:906 | High | S | A country with no province partitions is skipped with a log line and exit 0; its rows keep prior (possibly F09 rank-based) tiers and the refresh proceeds to packs. | Record skipped countries and fail the gate unless `--allow-skip`. |
| F12 | Model publishing | packages/data-pipeline/python/export_id_model.py:72 | High | S | Exporter deletes `bioclip-2-v1-fp32.onnx` and emits `-fp16.onnx`; the app downloads `-fp32.onnx` (packages/core/src/config.ts:184). SCRIPTS.md documents the trap instead of fixing it. | Decided: fp32 is correct. `ID_MODEL_GPU_URL`, `ID_MODEL_GPU_BYTES` (1.2 GB, an fp32 size) and `ID_MODEL_GPU_CHECKSUM` all describe the published fp32 file, and config.ts:181 says GPUs run full precision. Make the exporter keep `-fp32.onnx` (stop deleting it) and drop the fp16 output; fix SCRIPTS.md:237. |
| F13 | Data integrity | apps/web/src/components/PhotoImportRows.tsx:477 | High | S | `undoLastBatch` swallows a failed `DELETE /captures/:id`, then resets the row to `ready` anyway. The capture stays on the server; re-importing duplicates it. | Collect failures, leave those rows `done`, toast "undo partly failed". |
| F14 | Test debt | apps/web/vite.config.ts:33 | High | M | No DOM test environment (no jsdom, no Testing Library). All 38 web test files cover pure helpers; none cover `useCollectionData.ts` (306 lines of cache/race logic), `useGalleryListing.ts`, the import commit/undo flow, or the five most-churned pages. | Approved: add jsdom + @testing-library/react as web devDeps; start with `useCollectionData`, `useGalleryListing`, import commit/undo. |
| F15 | Test debt | packages/data-pipeline/src/build/build-region-pack.ts:363 | High | M | Builders of shipped artifacts are nearly untested: build-region-pack ~5% lines, `pipeline/packs.ts` ~10%, `photoStore.ts` and `build-catalog-seed.ts` (12 commits / 6 mo) have none. | Integration tests from a fixture DB: assert pack manifest; run the seed builder and assert source rows unchanged (catches F01). |
| F16 | Correctness / Duplication | apps/api/src/uploads/photo.ts:569 | High | S | Fingerprint RAW claim runs `UPDATE originals SET capture_id = $1 WHERE id = $2` without `AND capture_id IS NULL`, unlike the filename path at :536. Two concurrent uploads can both claim one RAW; the second silently steals it. | Add `AND capture_id IS NULL`; set `claimedRaw` only when `rowCount === 1`. |
| F17 | Architecture | apps/api/src/uploads/photo.ts:457 | Medium | M | `INSERT INTO captures` hand-written 5 times (photo.ts:457, raw.ts:325, video.ts:261, trips/import.ts:77, library/reimport.ts:270) with different column lists; `INSERT INTO originals` 9 times. `originals.user_id` set by only 3 of 9 (photo.ts:497). | `insertCapture(client, CaptureInsert)` / `insertOriginal(client, OriginalInsert)` with named fields. Decided: `insertOriginal` always sets `user_id`; a migration backfills it from `captures_all.user_id`, after which ownership checks can drop the `COALESCE`. |
| F18 | Architecture | apps/api/src/uploads/photo.ts:117 | Medium | L | `importPhoto` is ~530 lines: three source modes, RAW hand-off, duplicate check, cull marks, EXIF, file moves, transaction, sidecar, vector queue. `uploads/*` had ~60 commits in 6 months. | Split into `resolveSource`, `prepareFiles`, `insertCaptureTx`, `afterCommit` (after F17). |
| F19 | Consistency | apps/api/src/library/reimport.ts:301 | Medium | M | Reimport and trip import (trips/import.ts:106) run `generateDerivatives` inside the open transaction (holding a pool connection during sharp decode) and leave WebP files behind on ROLLBACK. `uploads/*` does the opposite. | Generate derivatives before BEGIN; `removeFiles(derivativeFiles(photoId))` in the catch, as photo.ts:440 does. |
| F20 | Error handling | apps/api/src/uploads/xmpSidecarSync.ts:92 | Medium | S | Per-file `writeCaptureMetadata(...).catch(() => {})` means the "Logged" wrapper (:97, "so sidecars don't drift silently") never sees failures. raw.ts:397 adds another silent catch. | Log with captureId/ref inside the per-file catch. |
| F21 | Consistency | apps/api/src/captures/routes.ts:36 | Medium | S | `resyncSpeciesMetadata` is a second metadata writer (JPEG only, own species query) that always runs right before `syncCaptureXmpSidecarsLogged` on the same file: two exiftool rewrites per change, contradicting imports-and-metadata.md. | Delete it; rely on `syncCaptureXmpSidecars`. |
| F22 | Performance | apps/api/src/storageVolumes/resolve.ts:97 | Medium | S | Every `resolveOriginalPath` on a drive-tagged original calls `listMountedVolumes()` uncached (one `diskutil info` per `/Volumes` entry on macOS). captures/trash.ts:94 does this per row for up to 500 rows; species/detail.ts:250 per capture. | Single-flight cache for ~2-5 s; batch the volume lookup. |
| F23 | Test debt | apps/api/src/uploads/photo.ts:245 | Medium | M | No tests for `mode=link`, `mode=s3` or `skipDuplicates=1` (which desktop-to-server migration relies on), nor for F02 or F16. | Integration tests for each mode, skipDuplicates, and "JPEG/RAW/video for an Other Taxa species land in one folder". |
| F24 | Data integrity | apps/api/src/inaturalist/routes.ts:298 | Medium | M | Create observation, upload photos, write link rows: no idempotency. A failed photo upload returns 502 with captures still unsubmitted; retry creates a duplicate iNat observation. Also `rows[0]` taxon (:279) files mixed-species captureIds under one species. | Persist `inat_observation_id` as pending right after create; reject mixed species and dedupe ids. |
| F25 | Error handling / Data loss | apps/api/src/albums/albumIndex.ts:24 | Medium | S | A corrupt `albums.json` parses as `{}` and the next write replaces it, erasing the album recovery copy ADR 0006 relies on. | Distinguish ENOENT from parse error; move a bad file to `albums.json.corrupt` and log. |
| F26 | Error handling | apps/api/src/settings/routes.ts:395 | Medium | S | Reorganize-originals `catch {}` only increments `failed`; resync errors at :405 dropped. "3 failed" is undiagnosable. | Log `{ err, ref }` at warn; keep last error in job status. |
| F27 | Architecture | apps/api/src/settings/routes.ts:281 | Medium | M | The 130-line `runReorganize` file-move engine (rename/copy/rollback/DB) lives in the top-churn routes file (20 commits); its test covers only input validation. | Move to `uploads/reorganizeOriginals.ts`; unit-test rollback paths. |
| F28 | Architecture / Perf | apps/api/src/stats/routes.ts:144 | Medium | M | GET /stats is one ~300-line handler with 11 queries; it loads every capture row (:196, no LIMIT) into JS to bucket EXIF. | Per-widget functions; bucket focal/aperture/ISO in SQL (`width_bucket`). |
| F29 | Architecture | apps/api/src/regions/routes.ts:65 | Medium | M | 570-line plugin. Shared SQL fragments hard-code positional params (`TAXON_PACK_DOWNLOADED_SQL` assumes `$7`, `CAPTURED_IN_TREE_SQL` assumes `$1`, :79): reordering params breaks queries silently. | Fragments take placeholders as arguments, as `userAddedInTreeSql("$1")` already does; split by route group. |
| F30 | Architecture | apps/api/src/offlinePacks/apply.ts:136 | Medium | M | `applyChecklist` is a 390-line function: diff, copy, enrichment, gallery upserts, embeddings, checklist writes. | Split into phase functions sharing `db`, each returning counts. |
| F31 | Contract | apps/api/src/stats/insights.ts:18 | Medium | M | ~50 of ~150 routes in scope have response schemas (stats 0/7, offlinePacks 1/13), incl. API-key-reachable routes with `schema: {}`. OpenAPI is empty for them and responses aren't allowlist-serialized. | Add response schemas, `requireScope` routes first; make apiRoutes.test.ts fail on a scoped route without a 200 schema. |
| F32 | Type / Trust boundary | apps/api/src/offlinePacks/index.ts:62 | Medium | S | Remote JSON cast unchecked: `as PackIndex`, `as PhotoStoreIndex` (photoStore.ts:31), `as PackManifest` (apply.ts:540). Download trust checks depend on these fields. | TypeBox schemas + `Value.Parse` at the boundary (TypeBox already ships). |
| F33 | Test debt | apps/desktop/src-tauri/src/offline_cache.rs:1046 | Medium | M | Offline-cache integration test is `#[ignore]` and `tests/offline-cache-integration.sh` is not in any workflow; ~270 lines of it live in `src/`. | Run it in the e2e job (has Postgres); move it to `src-tauri/tests/`. |
| F34 | Performance | apps/api/src/offlinePacks/index.ts:163 | Medium | S | GET /offline-packs/index can block on a 120 s photo-store fetch, then `gunzipSync` + `JSON.parse` on the event loop. | Async gunzip; return sizes as pending when cold; warm in background. |
| F35 | Consistency | packages/core/src/species/lazyEnrich.ts:190 | Medium | M | Two exported functions named `fetchWithRetry` with different timeouts, retries and caches (this one and lib/fetchWithRetry.ts:59); a copied `fetchWithHardTimeout` (regions/inatChecklist.ts:23); raw-fetch retries in ~10 pipeline scripts; api's lib/download.ts:31 duplicates core's `downloadResumable`. | One `httpClient({cacheTable, pacing, userAgent, timeoutMs, maxRetries})` in core/lib; rename the iNat one `inatFetch`; fold api's downloader into `downloadResumable`. |
| F36 | Consistency | packages/core/src/regions/inatChecklist.ts:48 | Medium | S | At least 4 independent iNat pacers with module-level clocks (this file, lazyEnrich.ts:144 `paceHost`, data-pipeline inatApi.ts:5, flag-nonnative-obscure-taxa.ts:52) plus copied 60 s sleeps. Two in one process can exceed iNat's ~1 req/s together. | One shared per-host pacer inside F35's client. |
| F37 | Layering | packages/core/src/regions/inatChecklist.ts:59 | Medium | S | Core hard-codes and writes to `packages/data-pipeline/data/...` (also :254, :400), a hidden dependency on the pipeline package against architecture.md's "core depends on neither". Comment at :13 describes the wrong location. | Take the cache dir from config (`PIPELINE_CACHE_DIR`) or a parameter. |
| F38 | Error handling | packages/core/src/species/lazyEnrich.ts:694 | Medium | M | Four near-identical vector-store functions (:694/:730/:781/:810) end in bare `catch {}`. Missing model, unreadable file, DB error and timeout all look the same; a broken model shows up only as an empty backfill. | Merge into one `tryStoreVector(...)`; `log.warn` anything other than model-not-downloaded. |
| F39 | Error handling | packages/core/src/species/embeddings.ts:1222 | Medium | S | BioCLIP failure (including DB errors in `rankSpeciesByEmbeddings`) falls back to CLIP silently; users get worse suggestions with no trace. | Warn with the error; fall back only on inference errors. |
| F40 | Test debt | packages/core/src/species/inference.ts:213 | Medium | M | 4 tests, none for the riskiest paths: `onWorkerGone` (crash before/after ready, GPU child to thread after 3 crashes), `timedOut`, `replaceAfterJob`, `stopInference`. | Inject `startWorker`; test crash, timeout, plan change, requeue with a fake handle. |
| F41 | Type / Trust boundary | packages/core/src/species/lazyEnrich.ts:264 | Medium | M | iNat/GBIF JSON cast with `as {...}` at ~20 core sites and 25 pipeline sites (e.g. data-pipeline/src/inatApi.ts:18). Response caches never expire (`fetched_at` never read), so one odd payload replays forever. | Small guards for the 4-5 shapes actually read (taxa, taxon_changes, GBIF facets/search/match). |
| F42 | Layering | packages/shared/src/speciesVectorFormat.ts:23 | Medium | S | `@lifer/shared` is for API + web, but this and `galleryEmbeddingsFormat.ts` are Node-only (`Buffer`); one web import breaks the browser build. Their tests live in apps/api. | Move both to `packages/core/src/species/` with their tests. |
| F43 | Architecture | packages/core/src/species/embeddings.ts:496 | Medium | L | 1248 lines, 49 functions: vector memo, capture LRU, user/species index caches with eviction, ranking, near-duplicate search, store, warm-up. lazyEnrich.ts (834) mixes HTTP client, parsing, persistence and embeddings. | Split into `vectorCache`, `userIndex`, `suggest`, `nearDuplicate`; lazyEnrich into `inatClient`, `enrich`, `persistReference`. |
| F44 | Test debt / Privacy | packages/core/src/species/sensitiveSpecies.ts:2028 | Medium | S | `sensitiveRegionMatches` and `weekInSeason` (:2019) decide which coordinates get coarsened to 20 km, via free-text region-label matching. No tests. | Table tests incl. year-wrapping seasons; log eBird labels that never match a region. |
| F45 | Doc drift | docs/docs/contributing/architecture.md:89 | Medium | S | Doc and ADR 0008 say models run in a worker thread; `inference.ts:118` forks a child process whenever a GPU runtime is active, with its own crash fallback. | Document the child-process mode and why (LD_LIBRARY_PATH needs a new process). |
| F46 | Duplication / Type drift | apps/web/src/pages/collection/useRegionTree.ts:29 | Medium | M | `GET /offline-packs/index` fetched at 7 sites with 4 hand-written shapes that disagree on `taxon` and nullable `region`; no shared cache, so lists refresh independently after a download. | One `usePackIndex()` store + one `PackIndexEntry` type in @lifer/shared + `refreshPackIndex()` on download finish. |
| F47 | Duplication | apps/web/src/hooks/useRegions.ts:11 | Medium | M | The same hand-rolled cached store (module state, listener set, pending promise, `useSyncExternalStore`) in 5 places (useRegions, useSettings:33, useNavCounts:5, CommandPalette:56, useCollectionData:22). ADR 0012 names this as its known cost. | A ~30-line `createCachedResource<T>(path)` (Top 5 #4); still no library. |
| F48 | Race | apps/web/src/pages/trip/useTripData.ts:17 | Medium | S | `fetchTrip` (and `fetchAlbum`, album/useAlbumDetail.ts:17; GalleryPage.tsx:47) has no cancel guard and doesn't clear old data on id change: trip A's late response can render under trip B's URL. | `useApiResource(path)` with AbortController and reset on id change. |
| F49 | Bug | apps/web/src/pages/OnboardingPage.tsx:72 | Medium | S | Hand-rolled map-download poll keyed on `[mapStatus]` with `.catch(() => {})`: one failed request stops polling and onboarding stays on "downloading". `MapStatus` defined twice (also settings/phases.ts:24). | `useJobPoll<MapStatus>("/settings/map/status")` as OfflineDataSettings.tsx:236 does. |
| F50 | Consistency | apps/web/src/components/SpeciesCard.tsx:90 | Medium | M | `lib/speciesName.ts:3` says every common-name display goes through it, but `commonName ?? scientificName` is inlined at ~34 sites; only 7 files use `useSpeciesName`. Localised names won't reach those screens. | Replace with `useSpeciesName()`; `no-restricted-syntax` lint rule for new copies. |
| F51 | Duplication | apps/web/src/pages/OfflinePacksPage.tsx:145 | Medium | M | `availableTaxaByRegion` copied into OnboardingPage.tsx:189; `countriesByContinent` drifted (Onboarding has no Central America bucket, OfflinePacksPage hard-codes one at :27-50), so the two pickers group countries differently. | Shared tested `lib/regionGrouping.ts`. |
| F52 | Architecture | apps/web/src/pages/OfflinePacksPage.tsx:76 | Medium | L | 995-line component: 21 `useState`, ~12 `useMemo`, selection, search, province manager, download start/cancel, domain constants. 14 commits / 6 mo. | Extract `useOfflinePackSelection`, `regionGrouping`, `ProvinceManager`. |
| F53 | Architecture | apps/web/src/components/PhotoImportRows.tsx:73 | Medium | L | 717 lines on the critical import path, running its own upload pipeline beside `lib/uploadQueue.ts`. Untested. | Move commit/undo into pure `lib/importCommit.ts`; consider routing through `enqueueUploads`. |
| F54 | Type debt | apps/web/src/api/client.ts:43 | Medium | L | `api.get<T>` is an unchecked `as T`; ~240 hand-written response types in web while the API already has TypeBox schemas for the same routes. Nothing catches drift. | Export `Static<typeof Schema>` types via @lifer/shared (or generate from OpenAPI). |
| F55 | i18n | eslint.config.mjs:73 | Medium | L | `i18next/no-literal-string` is off; 32 of the 40 largest .tsx files have no i18n; new literals keep landing (useStatsDownloads.ts:20). | Enable as `warn` with an ignore-list of unmigrated files; shrink it over time. |
| F56 | Lifecycle | apps/desktop/src-tauri/src/api.rs:376 | Medium | S | `run_migrations` returns `Ok(())` if the event channel closes without `Terminated`, has no timeout, and drops the child handle (:352): a hung migration blocks startup forever and is orphaned on quit. | Treat missing `Terminated` as Err; `tokio::time::timeout`; keep and kill the child in `stop_api_async`. |
| F57 | Durability | apps/desktop/src-tauri/src/pg_upgrade.rs:115 | Medium | S | `write_marker` and `swap()` renames (:647, :651) never fsync the parent dir (store.rs:81 does). Power loss can persist marker phase and folder renames out of order. Three divergent atomic-write helpers exist (store.rs:69, offline_cache.rs:175, here). | One `fsutil::write_atomic` + `fsync_dir` used everywhere. |
| F58 | Security | apps/desktop/src-tauri/src/lib.rs:81 | Medium | S | Plain-http remote servers get the full `REMOTE_PERMISSIONS` (fs write, updater install, process restart; :39-55). A LAN MITM on an http server could inject script calling them (updates are signature-checked, which limits it). | Omit updater/process grants for non-TLS origins, or warn in the picker for non-private http. |
| F59 | Architecture | apps/desktop/src-tauri/src/lib.rs:383 | Medium | M | `choose_setup` is 213 lines with two near-identical remote branches (:462-471, :516-523) and 20 literal result constructions despite `setup_error()` (:306). lib.rs (1201) also mixes ACL logic, 20+ commands, menu, watcher and bootstrap. | `connect_remote()` helper; split into `security.rs`, `commands.rs`, `menu.rs`, `server_watch.rs`. |
| F60 | Legacy | docker-compose.yml:6 | Medium | M | ~140 lines of 0.9.x Postgres 16-to-18 volume migration run on every `compose up`, and every new install pulls the third-party `imresamu/postgis:16-3.4-alpine` (:182). Also `LIFER_SKIP_DB_UPGRADE` in .env.example:9-12. | Approved: delete the `db-upgrade*` services, the script anchor, the postgis image and `LIFER_SKIP_DB_UPGRADE`; trim the matching section of upgrading.md. |
| F61 | Swallowed error | packages/data-pipeline/src/scripts/compute-provinces-bulk.ts:455 | Medium | S | eBird network errors and non-OK responses (:449) return null and are cached for the run as "no rescue": province membership depends on network luck. | Only 404 means "no list"; network/5xx fails the country for the retry pass. |
| F62 | Swallowed error | packages/data-pipeline/src/scripts/refresh-inat-counts.ts:36 | Medium | S | Exits 0 with failed places; apply-introduced-flags.ts:76 silently falls back. The refresh proceeds to tiers with missing counts. | Non-zero exit above a threshold, or surface failures to the gate. |
| F63 | Publish hygiene | packages/data-pipeline/src/scripts/refresh.ts:446 | Medium | S | Uploads every `*.sql.gz`/`*.bin.gz` in `catalog-seed/`, including stale files the manifest doesn't list; DATABASE_URL falls back to hard-coded `lifer:lifer` (:443). | Upload only manifest-listed files; fail when DATABASE_URL is unset. |
| F64 | Dead code | packages/data-pipeline/src/build/vernacular-regions-data.ts:1 | Medium | S | 982 lines nothing imports (its consumer was removed). Also `gbif-bulk-ab-test.ts` (one-off experiment citing a deleted file, still in SCRIPTS.md:179) and `compute-all-regions.ts` whose CLI is superseded (only `drillDownAllCountries` is used). | Delete; move `drillDownAllCountries` into a lib module. |
| F65 | Security | apps/api/src/shares/routes.ts:269 | Low | S | Same pattern as F06 on share links: 50 wrong passwords from any IPs lock every visitor out of that link for 15 min. | Growing delay instead of hard 429. |
| F66 | Security | apps/api/src/auth/routes.ts:17 | Low | S | `NonEmpty` has no `maxLength`; unauthenticated login/register/unlock can send multi-MB passwords into argon2. Global limiter keys raw `request.ip` (lib/rateLimit.ts:8), not the IPv6 /64 grouping login uses. | `maxLength: 1024`; `keyGenerator: (r) => ipRateLimitKey(r.ip)`. |
| F67 | Security | apps/api/src/offlinePacks/index.ts:117 | Low | S | `index.photoStore.indexUrl` fetched without `assertTrustedPackUrl`, unlike pack and shard URLs (download.ts:154, :267). Needs a tampered index from an admin-set URL. | Assert inside `fetchPhotoStoreIndex`. |
| F68 | Dead code | apps/api/src/photoSources/local.ts:5 | Low | S | `PhotoSource` abstraction unused: `LocalPhotoSource` and `S3PhotoSource`/`s3Configured` (s3.ts:13, :51) never instantiated. `apps/api/src/uploads/rawExtensions.ts:3` also unused, yet imports-and-metadata.md and web's lib/rawExtensions.ts:1 still point at it. | Delete the classes and interface, keeping `fetchS3Object`/`signedS3Url` (S3 mode itself is a documented API feature, environment-variables.md:119). Delete the API RAW list; point docs at packages/core/src/uploads/formats.ts. |
| F69 | Dead code | packages/core/src/species/inference.ts:455 | Low | S | Unreferenced exports (tests included): `inferenceQueueDepth`, `computeSuggestionEmbedding` (embeddings.ts:290), `computeIdSuggestionEmbedding` (:296), `fetchINaturalistWikipediaSummary` (lazyEnrich.ts:354), `filterSentences`, `boostElusivenessForDistribution`, `readCachedJson`. Web: `resetServerInfoCache` (useDeploymentMode.ts:40), `formatDate.ts` shim. | Delete, or wire `inferenceQueueDepth` into /health. |
| F70 | Consistency | apps/api/src/species/embeddingBackfill.ts:22 | Low | M | Three hand-rolled job state objects (:22, :83, :140) next to `lib/job.ts createJob` used by 11 files. offlinePacks/download.ts:86 polls a legacy `catalogUpdateJob.running` alias every 1 s instead of `catalogUpdate.settled()`. | Move onto `createJob`; delete the alias and dead `_userId` param (catalogSeedUpdate.ts:741). |
| F71 | Consistency | apps/api/src/inaturalist/client.ts:7 | Low | S | Six User-Agent strings ("lifer-app/0.1", "Lifer/0.7", "lifer-data-pipeline/0.1"...), stale and often without contact info, which iNat/Wikimedia ask for. | One `LIFER_USER_AGENT` from APP_VERSION inside F35's client. |
| F72 | Performance | apps/api/src/settings/routes.ts:467 | Low | S | Sync fs on request/job paths: `readdirSync` here; `listManagedFiles` walk (library/reimport.ts:54) and trips/scan.ts:34; per-photo full rewrite of `.lifer/index.json` (trips/tripIndex.ts:43, O(n²)). On a slow NAS this trips the event-loop watchdog. | `fs.promises` / `opendir`; batch trip index writes. |
| F73 | Correctness | apps/api/src/originals/routes.ts:24 | Low | S | Ownership query joins the `captures` view (excludes trash) while /photos/:id/original uses `captures_all`; a trashed capture's original 404s here only. Related: reimport hash lookup (library/reimport.ts:188, :377) has no user filter (latent; one account per server). | Use `captures_all`; scope the hash lookup. |
| F74 | Error handling | apps/api/src/trips/import.ts:229 | Low | S | `managed = true` update for a copied RAW swallowed; failure leaves it unmanaged forever. Model failure in inspect also silent (uploads/inspect.ts:254, trips/jobs.ts:450). | Do it in the import transaction; log fallbacks once. |
| F75 | Swallowed errors | apps/web/src/pages/gallery/useGalleryFacets.ts:14 | Low | M | ~40 bare `.catch(() => {})` in web (e.g. Lightbox.tsx:439 download fails with no feedback, GalleryPage.tsx:52, SpeciesPicker.tsx:68). | `ignore(reason)` helper that logs; toast on user-initiated actions like Download. |
| F76 | Hooks | apps/web/src/components/Lightbox.tsx:337 | Low | S | 7 `exhaustive-deps` suppressions with no reason; Lightbox's keyboard handler can hold stale `toggleFullscreen`/`video`. `useLatest` exists for this. | `useLatest` or a `-- reason` on each. |
| F77 | Network | apps/web/src/components/UpdatesBanner.tsx:69 | Low | S | Effect keyed on `onPacksPage` re-calls unauthenticated `api.github.com` (60 req/h/IP) on every visit to /offline-packs; `r.ok` never checked. `localInference.ts:56` polls forever with no deadline. | Split effects; check `r.ok`; add a deadline/AbortSignal to the poll. |
| F78 | Pipeline security | packages/data-pipeline/src/fetch/wikipediaArticles.ts:347 | Low | S | Second `sparqlString` without `\n`/`\r` escaping (fetch-wikidata.ts:36 has it). | Import the one escaper. |
| F79 | CI / Supply chain | .github/workflows/release.yml:48 | Low | M | release.yml, catalog-seed.yml, docs.yml have no `timeout-minutes`; macOS FFmpeg/Postgres build steps copied 3x (release.yml:150, desktop-build.yml:53, :135); `node:22-slim` pinned by tag only (Dockerfile:3) though actions are SHA-pinned. | Job timeouts; composite `.github/actions/macos-natives`; digest-pin the base image. |
| F80 | Doc drift | docs/docs/contributing/architecture.md:53 | Low | S | Says API config is in `src/config.ts` (it's `packages/core/src/config.ts`; its tests sit in `apps/api/src/config.*.test.ts`). Also: ADR 0011:9/:40 stale status; ADR 0001:48 says macOS 15 (requirements.md:14 says 14); DATA_SOURCES.md:52, :67 cite moved files; testing.md omits `cargo test`; desktop-app.md:66-69 legacy-version text. | Fix paths/status lines; move config tests to core; drop legacy text. |
| F81 | Data freshness | packages/data-pipeline/src/build/apply-rarity-phase4.ts:240 | High | M | NEW. `species_traits.endemic_country_iso3` (endemic badges, trip endemic counts, species detail) has exactly one writer: this file, reached only through `npm run compute-elusiveness`, which is not part of `refresh`. Endemic data is frozen at its last manual run, species added since have none, and refreshing it also rewrites tiers through the F08 quota path. | Move the endemic computation into its own refresh stage that writes only `endemic_country_iso3`; then delete compute-elusiveness's score and tier writes. |
| F82 | Resilience | packages/core/src/species/inference.ts:150 | Medium | S | NEW. `runtimeCrashes` resets only on a plan change, so three GPU child crashes spread over weeks move matching to the CPU until restart (confirmed unintended). | Count crashes in a sliding window (e.g. 3 within 10 minutes), or reset after a period of healthy jobs. |
| F83 | Doc drift | packages/core/src/regions/compute/occurrences.ts:73 | Low | S | NEW. Says introduced flags come from compute-elusiveness.ts; `species_nonnative_countries` is now rewritten by apply-introduced-flags.ts from iNaturalist (also compute-provinces-bulk.ts:664). compute-elusiveness.ts:249 cites a `reapply-elusiveness-from-cache.ts` that doesn't exist. | Point the comments at apply-introduced-flags.ts; drop the dead reference. |
| F84 | Data freshness | packages/core/src/species/lazyEnrich.ts:190 | Low | S | NEW. The iNat response cache is meant for pipeline builds, but the API's lazy enrichment (species/detail.ts, otherTaxa.ts, referencePhotos.ts, withheldPhotos.ts) reads it on installs too, with no expiry, so an install never sees iNaturalist taxon changes for species it enriched once. | Give the API path a max age (e.g. 90 days, as inatChecklist.ts:40 already does), or bypass the cache outside the pipeline. |

Not separately listed but noted: `madge` finds 2 import cycles (`core/species/clientVectors.ts <-> embeddings.ts`, `data-pipeline/src/pipeline/packs.ts <-> packStore.ts`), both small; `apps/desktop/package.json:20` lists six `@tauri-apps/*` deps nothing in `apps/desktop` imports; `.gitignore:17` ignores `data/` subfolders one by one.

## Top 5: if you fix nothing else, fix these

### 1. F01: Stop mutating the source DB in the seed build

Quick, safe step (same pattern the file already uses for `tier_explain`):

```ts
// build-catalog-seed.ts, replacing the in-memory `backups` loop at :290
for (const [table, columns] of Object.entries(PATH_COLUMNS)) {
  const bak = `seed_path_backup_${table}`;
  if ((await pool.query(`SELECT to_regclass($1) AS t`, [bak])).rows[0].t) {
    await restorePaths(table, columns, bak);          // a previous run crashed: restore first
  }
  await pool.query(`CREATE TABLE ${bak} AS SELECT id, ${columns.join(", ")} FROM ${table}`);
  await pool.query(`UPDATE ${table} SET ${columns.map((c) => `${c} = NULL`).join(", ")}`);
}
// finally: one set-based restore per table, then DROP the backup table
async function restorePaths(table: string, columns: string[], bak: string) {
  await pool.query(`UPDATE ${table} t SET ${columns.map((c) => `${c} = b.${c}`).join(", ")}
                    FROM ${bak} b WHERE b.id = t.id`);
  await pool.query(`DROP TABLE ${bak}`);
}
```

Proper fix afterwards: `CREATE TABLE seed_export.<t> AS SELECT <cols with path cols as NULL> FROM public.<t> WHERE <not other taxa>`, `pg_dump` that schema, rewrite `COPY seed_export.` to `COPY public.` in the stream, `DROP SCHEMA` in `finally`. Source tables are never touched, and the SCRIPTS.md "Danger" paragraph goes away. Add the F15 test asserting source row counts and path counts are unchanged after a build.

### 2. F02: One function builds every species folder path

```ts
// uploads/managedFolders.ts
export async function speciesFolder(
  userId: string, speciesId: string, base: string,
  o: { subfolder: Subfolder; takenAt: Date | null; wallClock?: string | null;
       locationLabel?: string | null; allowLocation?: boolean },
  settings?: UserFileSettings,
): Promise<string> {
  const s = settings ?? (await getUserFileSettings(userId));
  return originalsFolder(base, {
    ...(await speciesFolderParts(userId, speciesId, s.namingStyles)),
    organizeByYear: s.organizeByYear,
    organizeByLocation: (o.allowLocation ?? true) && s.organizeByLocation,
    locationLabel: o.locationLabel ?? null,
    takenAt: o.takenAt, takenAtWallClock: o.wallClock ?? null, subfolder: o.subfolder,
  });
}
```

Replace the hand-built options at photo.ts:385/417, raw.ts:84/184/295, video.ts:230, common.ts:152 (`allowLocation: false`), trips/import.ts:192 (drops its direct `users` query). Then make `originalsFolder` non-exported outside this module so new call sites can't reintroduce drift. Test: JPEG + RAW + video for an Other Taxa species with a non-default naming style all land under one `<Taxon>/<Species>`. Existing misfiled RAWs are fixed by the next Reorganize, which already uses the correct options.

### 3. F03: One CLIP preprocessing implementation

```diff
 // packages/data-pipeline/src/scripts/backfill-reference-embeddings.ts
-import { computeEmbedding, EMBEDDING_MODEL_VERSION } from "../embeddings.js";
+import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
+import { computeEmbedding, clipModel } from "@lifer/core/species/embeddings.js";
+await clipModel.download();   // checksum-verified
+setPlan({ device: null, runtime: null,
+  placements: { clip: { backend: "cpu", modelPath: CLIP_GPU_MODEL_PATH, providers: ["cpu"], force: true } } });
```

`placementFor` (core/species/acceleration.ts:43) needs a `force` flag so an explicit CPU placement can use the full-precision path. Delete `packages/data-pipeline/src/embeddings.ts`; point build-catalog-seed.ts:38 at core's `EMBEDDING_MODEL_VERSION`. Add a parity test (grayscale + RGB fixture through both entry points). Then a dry run lists reference photos whose source has 1 channel and recomputes only those vectors, no full rerun.

### 4. F13/F46/F47/F48: A shared cached-resource primitive for the web app

No new library (ADR 0012 holds):

```ts
// lib/resource.ts
const resetters = new Set<() => void>();
export const resetAccountCaches = () => resetters.forEach((r) => r());

export function createCachedResource<T>(path: string) {
  let state: { data: T | null; error: unknown } = { data: null, error: null };
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const emit = (s: typeof state) => { state = s; listeners.forEach((l) => l()); };
  const refresh = () => (pending ??= api.get<T>(path)
    .then((d) => (emit({ data: d, error: null }), d))
    .catch((e) => { emit({ ...state, error: e }); throw e; })
    .finally(() => { pending = null; }));
  resetters.add(() => { pending = null; emit({ data: null, error: null }); });
  const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
  return {
    refresh,
    use() {
      const s = useSyncExternalStore(subscribe, () => state);
      useEffect(() => { if (!state.data) void refresh().catch(() => {}); }, []);
      return { ...s, loading: !s.data && !s.error, refresh };
    },
  };
}
```

Order: move `useRegions`/`useSettings` onto it (no behaviour change); replace the 7 pack-index fetches with `packIndex.use()` + `packIndex.refresh()` on download finish; call `resetAccountCaches()` from AuthProvider; add a sibling `useApiResource(path | null)` that aborts on id change for trip/album detail (fixes F48). Pair with F14 (jsdom + Testing Library) so this primitive is the first thing tested. Fix F13 in the same PR: collect failed deletes in `undoLastBatch` and keep those rows `done`.

### 5. F04/F05 + F06: Run the tests you already wrote, and close the lockout

```diff
 # .github/workflows/ci.yml (desktop job)
       - run: cargo clippy --all-targets --locked -- -D warnings
+      - run: cargo test --lib --locked
```

```yaml
# .github/workflows/release.yml
  pg-upgrade:
    needs: ci
    uses: ./.github/workflows/desktop-build.yml   # add `on: workflow_call` with the same inputs
    with: { arch: arm64, pg_upgrade_test: true }
# desktop job: needs: [ci, pg-upgrade]
```

Login lockout (auth/routes.ts:96):

```diff
-if (isRateLimited(rateLimitKey) || isRateLimited(emailKey, LOGIN_PER_EMAIL_MAX)) {
+const knownDevice = hasUnlock(request.cookies[KNOWN_DEVICE_COOKIE], normalizedEmail);
+if (isRateLimited(rateLimitKey) || (!knownDevice && isRateLimited(emailKey, LOGIN_PER_EMAIL_MAX))) {
 ...
 clearAttempts(rateLimitKey);
+clearAttempts(emailKey);
+reply.setCookie(KNOWN_DEVICE_COOKIE, addUnlock(request.cookies[KNOWN_DEVICE_COOKIE], normalizedEmail).value,
+  { httpOnly: true, sameSite: "lax", secure: cookieSecureFor(request), maxAge: 365 * 86400 });
```

The signing key must survive restarts (inject a persisted key into `unlockCookie.ts` instead of its process-local one). Per-email+IP limiting still applies to known devices. Add a test: "owner logs in after 50 foreign failures".

## Quick wins

Low effort, Medium+ severity:

- [ ] F01: back up path columns to a DB table, set-based restore
- [ ] F03: delete the pipeline preprocessing copy, use core's
- [ ] F04: add `cargo test --lib --locked` to CI
- [ ] F06: known-device exemption + clear `emailKey` on success
- [ ] F07: publish requires a passing gate; canonical stage order
- [ ] F08: delete the percentile-quota branch in apply-rarity-phase4
- [ ] F10: point scheduled-refresh.sh at `refresh`, or delete `ops/`
- [ ] F11: compute-local-tiers fails on skipped countries
- [ ] F12: align the BioCLIP GPU artifact filename
- [ ] F13: don't reset rows whose undo delete failed
- [ ] F16: `AND capture_id IS NULL` on the fingerprint RAW claim
- [ ] F20, F26, F38, F39: log inside the swallowed catches
- [ ] F21: delete `resyncSpeciesMetadata`
- [ ] F22: cache `listMountedVolumes` for a few seconds
- [ ] F25: move a corrupt `albums.json` aside instead of overwriting
- [ ] F32: `Value.Parse` on pack index/manifest
- [ ] F34: async gunzip off the request path
- [ ] F37: core takes the pipeline cache dir from config
- [ ] F42: move Node-only vector formats out of @lifer/shared
- [ ] F44: table tests for sensitive-species coarsening
- [ ] F45: document the inference child-process mode
- [ ] F48, F49: cancel guard on trip/album fetch; onboarding poll via `useJobPoll`
- [ ] F56, F57: migration timeout + kill; fsync parent dir after renames
- [ ] F58: no updater/process grants for http servers
- [ ] F61, F62, F63: pipeline stops treating failures as success; upload only manifest files
- [ ] F64: delete `vernacular-regions-data.ts`, `gbif-bulk-ab-test.ts`

## Things that look bad but are actually fine

- **149 em dashes in the repo.** All are in released migrations (`packages/data-pipeline/migrations/*.sql`). `scripts/check-em-dashes.mjs:29` skips migrations on purpose because released migrations are immutable history. Zero elsewhere in apps, docs, CI or Docker. (One real gap: its `EXCLUDED_DIRS` also contains `build`, so `packages/data-pipeline/src/build/**` is never scanned; it's clean today.)
- **Knip reports 60 unused files and 14 unused deps.** Mostly false positives with no knip config: ~45 are pipeline scripts run via `tsx` CLI, desktop JS is loaded from HTML, and `onnxruntime-node`/`@huggingface/transformers`/`pino` are imported by core but must also be in `apps/api` so the esbuild bundle and desktop sidecar resolve them. The genuinely dead items are in F64, F68, F69.
- **Missing `user_id` filters on some queries** (reimport hash lookup, global reorganize/catalog jobs guarded only by `requireAuth`, shared library allowlist). A server has exactly one account by design (security-model.md:10, register refuses a second). They're latent and noted in F73, not leaks.
- **Template-string SQL** in catalogSeedUpdate.ts `mergeGenericTable`, stats/routes.ts, embeddings.ts:548 (`FROM ${table}`), build-region-pack.ts:368. Every interpolated identifier goes through `ident()` or is a closed union/enum checked against constants; user values are always `$n` parameters.
- **`sensitiveSpecies.ts` at 2037 lines.** ~1950 lines of a typed `Map` literal plus 3 small functions. TypeScript validates the scope/season shapes for free; converting to JSON would lose that without adding a validator. Only the logic needs tests (F44).
- **The worker and inference modules reading `process.env` directly** instead of config.ts. Deliberate: the desktop inference sidecar reuses the worker without loading config.ts (which loads dotenv and resolves DATA_DIR). The `LIFER_MAX_IMAGE_PIXELS` copy in inferenceWorker.ts:30 is the one exception worth folding back.
- **Undocumented-looking env vars** (`LIFER_ALLOW_NONCOMMERCIAL_PHOTOS`, `LIFER_INAT_OFFLINE`, `LIFER_INAT_CACHE_MAX_AGE_DAYS`). Maintainer-only knobs, documented in rebuilding-data.md, SCRIPTS.md and ADR 0010, not the install docs, which is correct.
- **~70 `.catch(() => {})` in the API.** The majority are `ROLLBACK.catch` or `rm(...).catch` on paths that already rethrow the original error, which is the right pattern. Only the specific ones in F20, F26, F74 hide real failures.
- **`backfill-descriptions` calling Wikipedia directly** despite the "prefer iNat's wikipedia_summary" rule. iNat's copy is truncated for this use; it goes through `PoliteClient` + `RateLimitBreaker` and only refetches changed revisions.
- **Destructive migrations** (125 DELETE, 129 DROP COLUMN, 131 DROP TABLE). Each moves data before dropping and has a dedicated integration test. Migration number gaps (078/079/083) never existed and the runner only rejects duplicates.
- **API keys hashed with plain SHA-256.** Correct for 256-bit random tokens; argon2 would only add per-request latency.
- **Large lists without a virtualization library.** `content-visibility: auto`, cursor paging with IntersectionObserver, and memoized cards cover it.
- **62 `let _ =` in Rust.** Best-effort cleanup on already-failed paths or in tests; `pg_upgrade` keeps the old cluster until `/health` answers. Process lifecycle generally is solid (parent-pid watchdogs, `LIFER_PG_CTL`, pid-reuse guard).

## Maintainer decisions (2026-10-08)

Answers to the first run's open questions, folded into the findings above.

1. **Tier sub-scores (F09):** quota or percentile-rank logic is not allowed at any level, inputs included. Fix it, but calibrate so current packs change as little as possible.
2. **Elusiveness scores (F08, F81):** investigated. Nothing reads `elusiveness_score`, `composite`, `range_score` or `abundance_score`. The same step is the only writer of `endemic_country_iso3`, which the app does use, so that piece has to move into `refresh` before the rest is deleted.
3. **Scheduled refresh (F10):** stays manual. Delete the broken `ops/` wrapper.
4. **BioCLIP GPU file (F12):** fp32 is correct; fix the exporter.
5. **Response caches:** meant for pipeline builds. The API also reads the iNat cache on installs (F84).
6. **0.9.x Docker migration (F60):** the only user has migrated; delete it.
7. **`packages/core` scope:** the modules in question (`regions/inatChecklist`, `buildRegionSpecies`, `gbif/*`, `computeRarityPhase1`, `rawCache`, `descriptionText`, `licensePolicy`) are imported by `packages/data-pipeline` only, never by `apps/api`. Low priority; move them only when touching them anyway.
8. **API keys on desktop:** intended. Keys are for home-made integrations against a server; the desktop has none.
9. **S3 mode:** a documented API-only feature (`LIFER_S3_*`, environment-variables.md:119): an integration can register a photo whose original lives in an S3 or MinIO bucket instead of on disk. The web app never uses it. F68 deletes only the dead classes, not the feature.
10. **`originals.user_id` (F17):** always set it and backfill.
11. **GPU crash counter (F82):** unintended; now a finding.
12. **Web test deps (F14):** approved.

## Open questions for the maintainer

1. **S3 mode:** keep it as an API feature (then it needs tests, F23, and a video path), or remove it? It has no known users and adds `@aws-sdk/*` to the server bundle.
