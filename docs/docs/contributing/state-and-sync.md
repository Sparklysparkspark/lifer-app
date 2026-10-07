---
title: State and sync
description: Which data in Lifer belongs to the user and which is downloaded and replaceable, what each update path changes, and what Lifer guarantees when things go wrong.
---

# State and sync

Lifer has no sync engine. There's one database per install, one library folder, and a set of one-way paths that bring published data in or move a library out. This page lists each path, what it may change, and what it guarantees, including where the guarantees stop. Paths are relative to the repository root. [Data model](./data-model.md) describes the tables.

## Whose data is it

| Kind | Where | Owner | If lost |
|---|---|---|---|
| Original photos, RAWs, videos, XMP sidecars | The library (`DATA_DIR`), drives, trip folders | User | Gone. Back them up. |
| `.lifer` recovery files | `.lifer/` folders in the library and trip folders | User (written by Lifer) | Recreated as the library changes |
| User records | Database: captures, `user_species`, albums, trips, overlays, settings, accounts | User | Partly rebuildable from the library ([below](#reimport)) |
| Catalog | Database: species, regions, checklists, vectors | Published | Downloaded again |
| Previews of the user's photos | `APP_DATA_DIR/display`, `medium`, `thumb`, `video-preview` | Cache | Regenerated from the originals when missing (`apps/api/src/photos/routes.ts`) |
| Reference photos, models, map, GPU runtime, downloads | `APP_DATA_DIR/reference-*`, `models/`, `maps/`, `gpu-runtime/`, `catalog-downloads/` | Published | Downloaded again |
| Desktop database files and their password | `app-data/postgres-data`, `app-data/postgres-password` | User | Treat as the database. The password file is needed to open the data. |

The rule that keeps these apart: **published data may be replaced at any time; user data is never written by a download.** Catalog tables hold catalog rows only, and everything a user adds or changes about the catalog lives in separate per-user tables that no update path writes to ([ADR 0005](./decisions/0005-catalog-separate-from-user-data.md)). The one place user data moves during an update is a species merge, which re-points it rather than discarding it (below).

## First start: the catalog seed

A new database has no species. Two code paths fill it, depending on how Lifer runs:

- **Docker and development** (`seedCatalogIfEmpty` in `apps/api/src/species/catalogSeedUpdate.ts`, started without waiting at the end of `apps/api/src/index.ts`): if `species` has no rows, it loads the seed bundled in the image (`catalog-seed/`), or downloads it if there's none. A downloaded seed is checked against the SHA-256 in `catalog-manifest.json`. Regions load first, in their own transaction, then the full merge described below. A failure is logged and the server keeps running without a catalog; **Settings > Offline Data** can retry.
- **Desktop** (`apps/desktop/src-tauri/src/embedded_db.rs`, called from `api.rs` after migrations and before the API starts): if `species` is empty, it loads the seed bundled with the installer with `psql --single-transaction -v ON_ERROR_STOP=1`. A failure leaves `species` empty, so the next launch tries again.

Limits:

- **Bundled seeds aren't checksummed at install time.** They're trusted as part of the image or installer, which are themselves checksummed and signed ([Security model](../security-model.md#releases-and-dependencies)). The desktop's development-only download (`tauri dev` without a bundled seed) checks only its length.
- **The desktop restore doesn't record which seed version it loaded.** The API does it at startup (`recordRestoredSeedVersion` in `apps/api/src/species/restoredSeedVersion.ts`, called by `seedCatalogIfEmpty` when the catalog already has species): with no `install_settings.catalog_seed_version` yet, it records the `version` from the `catalog-manifest.json` bundled next to the seed (the image's `catalog-seed/`, or the desktop's `resources/catalog-seed/`, found from the compiled server's own path). It does so only when the database's first migration ran after Postgres last started, that is, the database was created in this run, which is when the desktop restores the seed it ships. An existing install opened by a newer app keeps its older catalog, so nothing is recorded for it and Settings keeps offering the update, as it does when the restore only succeeded on a later launch.
- Restoring collection state from the library (`syncCollectionStateOnStartup` in `apps/api/src/lib/collectionState.ts`) runs after the first-boot seed has finished, since it matches species by name. If none of the record's species are in the catalog (the seed failed, say), the restore isn't counted as tried, and the user's next session check (`/auth/me`) tries again.

## Catalog updates

**Settings > Offline Data > Species catalog updates** runs `runCatalogUpdate` (`catalogSeedUpdate.ts`):

1. Fetch the manifest from `CATALOG_MANIFEST_URL`, download the seed into `APP_DATA_DIR/catalog-downloads/` (resumable, checked against the manifest's SHA-256), delete older downloads.
2. Apply it in **one Postgres transaction**, holding the reference-data advisory lock (`packages/core/src/lib/referenceDataLock.ts`) so pack installs and vector installs wait:
   - Each table's data is streamed from the dump into a temporary table, then **upserted** into the real table on its primary key (`MERGE_TABLES`). Nothing is truncated. Columns the install's schema doesn't have yet are dropped with a warning, so an older install can take a newer seed.
   - Local file paths are never overwritten. A photo the install fetched itself for a withheld species is kept.
   - A region whose id changed upstream keeps its local id, matched by name and parent, so references to it survive.
   - Checklist rows the seed no longer lists are deleted, only for regions and sea zones the seed covers. User additions are in other tables and aren't touched. A sea zone that disappears takes its catalog rows with it; user additions to a zone that comes back under the same name are moved to the new id.
   - Species merges are applied (next section).
   - The seed version is written to `install_settings` last, inside the transaction.
3. After the commit: blocklisted photo files are deleted, XMP sidecars of photos moved by a merge are rewritten in the background, and species splits are resolved.

Guarantees and limits:

- **All or nothing for the database.** Any error, or the user cancelling, rolls back everything including the version. A crash before commit leaves the old catalog; the downloaded seed stays and is reused if its hash still matches.
- **Species rows are never deleted by the merge itself**, only by an explicit merge record. A species dropped upstream without one stays on the install.
- **The seed overwrites catalog columns it carries.** Enrichment such as descriptions and credits follows the published value; only the excluded path and withheld-photo columns are protected.
- **Steps after the commit aren't transactional.** If Lifer stops between the commit and them, the catalog is updated but some sidecars may still name the old species, and a deleted blocklisted photo file may linger. Splits are resolved again after every pack install; sidecars are rewritten at the photo's next change.
- **Updating the gallery vectors is a separate step** after the catalog, and its failure doesn't undo the catalog update.

## Species merges and splits

When the pipeline merges two species, the seed carries `species_merges` (old id to survivor). `applySpeciesMerges` (`packages/core/src/species/speciesMerges.ts`) runs inside the catalog transaction:

- Follows chains of merges to the final survivor, ignoring pairs not present locally.
- Fills the survivor's empty columns from the old species, keeps the old common name as an alias and the old scientific name as a synonym.
- Copies the user's overlays (archived, hidden in a region, checklist additions, tier overrides) to the survivor where it has none.
- Folds the user's `user_species` rows into one: collected beats seen, earliest first-collected date, best rating, the survivor's cover first.
- Moves captures, unpaired RAWs and extra-species links to the survivor.
- Deletes the old species. Because captures and `user_species` reference species with no cascade, a missed reference makes the delete fail and **the whole update rolls back** rather than losing user rows.

Splits are different: one species becomes several, and the right one depends on where each photo was taken. `resolveSpeciesSplits` (`apps/api/src/species/speciesSplits.ts`) runs after the commit, outside any transaction, because it moves files. A photo moves to a daughter species only when exactly one daughter is on the checklist where it was taken; otherwise it stays and the species card says the name changed. The user can choose to keep a photo on the parent (`species_split_kept`).

## Region packs

A pack is one region's checklists and reference photos for one species group, published as a byte range inside a shard file listed in `pack-index.json` ([ADR 0004](./decisions/0004-species-data-shipped-as-release-assets.md)).

**Install** (`apps/api/src/offlinePacks/download.ts`, `apply.ts`):

1. Installs a newer catalog first, if there is one, and stops if that fails.
2. Skips a pack whose `content_version` hasn't changed.
3. Fetches the pack's byte range into a temp file. Pack URLs must have the same origin as the index (`assertTrustedPackUrl`); the response must be a 206 of exactly the requested range; the file must match the index's SHA-256.
4. Applies it in **one transaction per pack**: fills species photos and descriptions that are missing, upserts the region's checklist rows and removes those the pack no longer lists (user additions untouched), records the pack in `downloaded_packs` and its species in `pack_species`. Photo files are copied before the rows that point at them.
5. After the commit, fetches the pack's reference photos from the photo store (below).

Species are matched to the catalog by scientific name and regions by name; a species the catalog lacks is skipped and logged. Cancelling a queue of packs keeps the ones already committed.

**Remove** (`apps/api/src/offlinePacks/remove.ts`), one transaction: deletes the pack's checklist rows; for species no other pack lists and no user has a `user_species` row for, clears their photo and description columns; deletes the pack record. Species rows, user additions and anything in a collection stay. Their photo files are only collected in the transaction and deleted after it commits, so a rollback leaves every file in place. A file some row still points at by then (another species sharing it, or a pack installed since) is kept. A file left behind by a failed delete or a crash before it is logged and harmless: reference photos are named by species id, so a reinstall overwrites it, and a fresh database relinks it (`apps/api/src/species/relinkReferenceFiles.ts`).

**Offload provinces** removes some provinces' checklist rows for a pack and keeps its photos; reinstalling the pack restores them. **Offload several packs** removes each pack in its own transaction, so it's not atomic across the batch.

## The photo store and withheld photos

Reference photos are stored once each in shard files, with an index of `[shard, offset, length, sha1]` per photo (`apps/api/src/offlinePacks/photoStore.ts`). After a pack install, Lifer works out which photos are missing on disk, merges neighbouring ones into ranges of up to 32 MB, fetches them with retries, checks each photo's SHA-1, and writes each through a `.part` file and rename into `APP_DATA_DIR/reference-*`. Database paths are recorded only after the files are on disk. A photo that fails its check is skipped and retried next time; it never fails the pack.

Some catalog photos can't be redistributed under their license, so the pipeline leaves them out and marks the species `photo_withheld` ([ADR 0010](./decisions/0010-photo-license-policy.md)). `apps/api/src/species/withheldPhotos.ts` fetches those from iNaturalist on the install itself, for species on a downloaded pack's checklists: one at a time, two seconds apart, at most 2000 a day, stopping after repeated failures. It runs at startup and after each pack install, and can be turned off (`fetch_withheld_photos` in `install_settings`, **Settings > Offline Data > Photos packs can't include**). These photos survive catalog updates and are removed with their pack.

## Moving a desktop library to a server

`apps/api/src/settings/migrateToServer.ts`, desktop only. The desktop's API signs in to the server with the user's email and password, then **replays each capture as an ordinary upload**: the photo and its RAW over tus, then `POST /api/uploads` with the species, matched on the server by exact scientific name.

- **What carries over:** the files, the species, and whatever is in the files (EXIF, and the rating and keywords Lifer wrote into managed files). The server re-reads them as it would any upload.
- **What doesn't:** albums, trips, seen and target status, archived and hidden species, tier overrides, checklist additions, cover choices and crops, Other Taxa species the server doesn't have. The collection-state file isn't sent.
- **Progress** is recorded per capture and server in `capture_migrations`: `migrated` only after the server confirms, `failed` to retry on the next run, `skipped` (no usable file) permanently. An interrupted run resumes with the rest.
- **Duplicates:** each upload sends `skipDuplicates=1`, so a photo the server already has (saved before a lost response, or already there) comes back as that photo and is marked migrated, instead of being added twice. Only an exact copy counts: a file changed since (Lifer rewrote its keywords, say) is uploaded again.
- **Deleting the local copy** is a separate button, offered only when the last run finished in this session with nothing failed or skipped and every capture is marked migrated. It deletes the user's captures and `user_species` in one transaction, then the managed files and previews. The file deletion comes after the commit and isn't atomic.

## Recovery files and reimport {#reimport}

Lifer keeps enough in the library to rebuild most of a collection without the database ([ADR 0006](./decisions/0006-database-primary-files-carry-recovery-copy.md)):

- Species, rating and photo tags in each managed file or its XMP sidecar ([Imports and metadata](./imports-and-metadata.md#metadata-lifer-writes)).
- `.lifer/collection-state.json` at the library root: per user (by email), seen species, targets, archived and region-hidden species, tier overrides and checklist additions, all by scientific name and region name or code (`apps/api/src/lib/collectionState.ts`). Written two seconds after a change to any of them.
- `.lifer/albums.json` in photo folders: album membership by album name (`apps/api/src/albums/albumIndex.ts`).
- `.lifer/index.json` in trip destination folders: each imported file's species (`apps/api/src/trips/tripIndex.ts`).

These are written atomically (`apps/api/src/lib/atomicWrite.ts`: a temp file that's `fsync`ed, renamed over the old one, then the folder `fsync`ed, except on Windows), but the collection state is debounced, so a crash or power cut can lose the last few seconds of changes. They're a recovery aid, not a second database: the database always wins, and they're read only to fill an empty database.

**Reimport** (`POST /api/library/reimport`, `apps/api/src/library/reimport.ts`) walks the library or a chosen folder (skipping dot folders, the upload work folder and `APP_DATA_DIR`):

- A file whose hash is already known is left alone, or its path is repaired if it moved.
- A photo a culling app rejected (`apps/api/src/uploads/cullMarks.ts`, read from the photo, its sidecar and a RAW twin with the same stem) is skipped, recovered hidden, or recovered as usual, as the request's `cullMarks` says (`skip` by default). A skipped file is left untouched on disk and counted, not listed.
- A new file's species comes from its keywords, then its file and folder names; an ambiguous or unknown file is listed for the user, not guessed. It's imported with its EXIF, rating, cull marks and the photo tags Lifer wrote into it, marked collected (unless recovered hidden), and added back to its albums by name.
- RAW files attach to an existing JPEG capture with the same name stem and a capture time within one second.
- Finally the collection state is restored, if the database has none for that user.

Trip scans separately read `.lifer/index.json` to restore the species of trip photos.

**What can't be rebuilt from files:** the account, sessions, API keys and share links; settings; trip records; cover choices and card crops; RAW files with no JPEG; photos with no recognisable species; tags on photos Lifer doesn't manage (their files are never written); anything chosen in the database but never written to a file (for example a cover marker on an unmanaged photo). That's why the [backup guide](../install/backup-restore.md) still asks for a database backup.

## Desktop app connected to a server

In server mode the desktop window loads the server's own web app; there's no local copy of the server's data apart from the read-only offline cache below (`apps/desktop/src-tauri/src/lib.rs`, `store.rs`). The app chooses between the server's local and public addresses by Wi-Fi network name. If no address answers, it can fall back to the computer's own local library, which is a separate database and folder: work done there reaches the server only through the migration above, when the user chooses to push it. Nothing merges the two.

**Offline cache** (`apps/desktop/src-tauri/src/offline_cache.rs`, `apps/web/src/lib/offlineCache.ts`): a read-only, one-way copy of the user's collection (names, collected/seen state, 192 px cover JPEGs, at most 3,000 of them) in `<app data>/offline-cache`. The server's web page fills it, since only it holds the session: it fetches `GET /api/collection` and the cover thumbnails, downscales them, and hands them to the shell over IPC; the shell never contacts the server for it. It syncs on page load (unless the last sync was under 2 minutes ago) and every 30 minutes; covers whose URL and crop are unchanged are reused. `owner.json` ties it to one server (the single address, or the local address under URL switching) and one user id; a sync for anyone else wipes it first, and `store::write_config` deletes it whenever the option is off, the mode isn't remote or the server changed. Sign-out clears it from the web app. When the watcher finds no server, the window shows the bundled `offline.html` instead of the local-library fallback if a cache exists, and goes back to the server as soon as it answers. Nothing is ever written back, and edits made on the server while offline simply appear at the next sync.

**Matching on this computer** (`apps/desktop/src-tauri/src/local_inference.rs`, `apps/api/src/species/localInferenceServer.ts`): the app runs an inference-only copy of the API on loopback, with a per-launch bearer token, downloads the same model files the server uses (checked against the server's SHA-256), and sends the image vectors it computes along with each upload. The server accepts them only if they match its own image pipeline version, model versions and the uploaded file's SHA-256, and have the expected shape and norm (`packages/core/src/species/clientVectors.ts`); otherwise it computes its own. It doesn't recompute the vectors to compare, so this protects against version drift, not against a signed-in client sending wrong vectors for its own photos.

## Backups

Lifer has no backup feature. The [backup guide](../install/backup-restore.md) covers `pg_dump` of the database and copying the library, taken at about the same time. Because migrations are forward only ([Database migrations](./database-migrations.md)), an older backup restores into a newer Lifer, but a database a newer Lifer has migrated can't be used by an older one. `packages/data-pipeline/src/scripts/backup.ts` is a maintainer convenience for the development database and library, not part of installs.
