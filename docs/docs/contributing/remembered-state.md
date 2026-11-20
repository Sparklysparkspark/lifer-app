---
id: remembered-state
title: Remembered state
description: Everything Lifer remembers between visits, what happens when the thing it points at is gone, and the test that proves it.
---

# Remembered state

Lifer remembers choices (a region, an export folder, a filter) as an id or a path. Each one can outlive the thing it points at: the region's pack is removed, the folder is on an unplugged drive, the tag was deleted. The rule for every row below is the same: the app quietly falls back to a sensible default, and never blanks a page or shows an error for a choice the user made earlier.

When you add something that is remembered, add a row and a test.

## Browser storage (the web app)

| Remembered                         | Key                                                      | When it points at nothing                                                                                                      | Test                                                |
| ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Last region                        | `lifer:lastRegionId`                                     | The region picker clears it; the Collection moves to a downloaded country on the same continent, then any, then the continent. | `RegionBrowser.test.tsx`, `restoreFallback.test.ts` |
| Recent regions                     | `lifer:recentRegions`                                    | Damaged entries read as none; regions the picker can't reach are skipped.                                                      | `RegionBrowser.test.tsx`                            |
| Last editor                        | `lifer:lastEditor`                                       | An editor that is no longer installed is just not first.                                                                       | `useOpenInEditors.test.ts`                          |
| Hidden apps                        | `lifer:hiddenApps`                                       | An unknown or removed app id hides nothing.                                                                                    | `pluginsHidden.test.ts`                             |
| Stats: include RAW photos          | `lifer:stats.includeRaw`                                 | Nothing to point at; unreadable storage reads as on.                                                                           | `StatsPage.test.tsx`                                |
| Album and portfolio export folders | `lifer:albumExportFolder`, `lifer:portfolioExportFolder` | The folder picker opens at the top level.                                                                                      | `FolderPicker.test.tsx`                             |

## Saved in the library

| Remembered                           | Where                                        | When it points at nothing                                                                                                       | Test                              |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Smart album rules and pinned filters | `albums.rules`, the `pinned_filters` setting | A tag, region, trip or album that is gone matches nothing; the album and the albums list still load.                            | `smartAlbums.integration.test.ts` |
| Smart rule naming a region or tag    | `albums.rules` (`regionId`, `tag`)           | A removed region or a deleted tag matches nothing; the album, its species and the albums list still open.                       | `smartAlbums.integration.test.ts` |
| Album and trip covers                | `albums.cover_photo_id`, `trips.cover_capture_id` | A cover photo in the Trash gives way to the newest photo in the album, without the old crop; emptying the Trash repoints it. | `routes.integration.test.ts` (albums), `trash.integration.test.ts` |
| Trip folders                         | `trips.source_folder`, `trips.destination_folder` | A missing or unplugged folder still lists and opens the trip; a scan finds nothing new and marks its photos missing, not gone, so they come back when the drive does. | `routes.integration.test.ts` (trips), `walkFiles.test.ts` |
| Companion app manifests and approvals | `<app data>/plugins/*.json`, `plugin-approvals.json` | A removed manifest drops the app on the next scan; a broken one is skipped and logged once; a changed or missing app file asks again or says it is missing. | `plugins.rs` tests |
| Watched folders                      | `library/watchedFolders.ts`                  | A missing or unplugged folder is skipped quietly and checked again later.                                                       | `watchedFolders.test.ts`          |
| Saved spots                          | `saved_spots`                                | A deleted spot leaves a tombstone so sync removes it everywhere.                                                                | `savedSpots.integration.test.ts`  |
| Server link                          | `sync/serverLink.ts`                         | An address that answers as another server is skipped, and the key goes only to the server that proves it holds the link secret. | `serverLink.test.ts`              |
