---
title: Imports and metadata
description: How photos get into Lifer, how RAW and JPEG files are paired, where files are filed, and exactly what Lifer reads from and writes to your files.
---

# Imports and metadata

This page follows a photo from the moment Lifer sees it to its place in the library, and lists exactly which metadata Lifer reads from files and which it writes back. Paths are relative to the repository root. For what users see, see [Importing photos](../guides/importing.md) and [Library folders](../guides/library-folders.md).

Every import path ends the same way: the original file is filed into a species folder (or left where it is, if linked), three WebP previews are made under `APP_DATA_DIR`, a `captures_all` row records the file's hash and EXIF fields, and Lifer's species and rating tags are written back to the file in the background, but only to files it manages.

## Import paths

### Upload from the web app or desktop app

Two requests, so the user can review before anything is saved:

1. **`POST /api/uploads/inspect`** (`apps/api/src/uploads/inspect.ts`) reads EXIF, keywords and cull marks, checks for duplicates and suggests species. It writes no database rows. A multipart file is kept in a staging folder and returned as a `stagedId`, so the import doesn't upload it again.
2. **`POST /api/uploads`** (`apps/api/src/uploads/photo.ts`) imports. Its `mode` is `store` (the default: file the file into the library), `link` (leave it where it is, unmanaged; the path must pass the [path allowlist](../security-model.md#file-access)), or `s3` (an object in the configured bucket).

`POST /api/uploads/raw` takes many RAW files at once (two in parallel), and `POST /api/uploads/video` takes MP4 and MOV.

The bytes arrive one of three ways (`apps/api/src/uploads/uploadSource.ts`): a multipart part streamed to a temp file, a `stagedId` from inspect, or the id of a finished **tus** upload. The web app always uses tus (`apps/web/src/lib/tusUpload.ts`): chunks start at 8 MiB and halve, down to 256 KiB, when a proxy refuses one as too large, which is why Lifer works behind proxies with default body limits. The server side (`apps/api/src/lib/tusUploads.ts`, built on `@tus/server` and `@tus/file-store`) hashes each chunk as it's written, ties each upload to its user, and re-hashes the file when an import claims it. Uploads idle for two hours are swept by `lib/maintenance.ts`.

Received files land in an upload work folder (`apps/api/src/lib/uploadWorkDir.ts`): `LIFER_UPLOAD_WORK_DIR` if set, otherwise `APP_DATA_DIR/uploads` when that's on the same drive as the library, otherwise `.lifer-uploads` inside the library. Being on the same drive makes filing a file a rename instead of a copy.

### Trip folders

A trip points at a folder of photos, typically a card dump (`apps/api/src/trips/`). Scanning (`scan.ts`) lists photos whose SHA-256 isn't already a capture, skipping the trip's destination folder and dot files, and reads their cull marks. Importing (`import.ts`, run four files at a time by `jobs.ts`) **copies** each chosen photo, and its RAW twin, into `<trip destination>/<taxon>/<species>/Adjusted/` and `RAW/`. The source folder is never modified. A failed import deletes the copies it made. Each file path is checked to stay inside the trip folder after symlinks are resolved (`resolveWithinTripFolder`).

### Checklists from eBird

`POST /api/imports/ebird-csv` (`apps/api/src/imports/routes.ts`) reads an eBird "My eBird Data" export. It needs only a "Scientific Name" column, matches names exactly against `species.scientific_name`, and marks each match `seen` in `user_species` with `ON CONFLICT DO NOTHING`, so a collected species is never downgraded. It returns the matched, already-seen and unmatched counts. No photos are involved, and Lifer never contacts eBird. The CSV parser is minimal: it doesn't handle commas inside quoted fields.

There's no other life-list import. iNaturalist is the other direction: Lifer sends selected photos to iNaturalist as observations (`apps/api/src/inaturalist/`); it doesn't import from it.

### Reimporting a library from disk

`POST /api/library/reimport` (`apps/api/src/library/routes.ts`, `reimport.ts`) rebuilds captures from files already on disk: the library, a registered drive, or an allowed folder. It's the recovery path when the database is lost; see [State and sync](./state-and-sync.md#reimport). Species come from keywords Lifer wrote earlier, and from the file and folder names. Anything ambiguous is listed for the user to decide, never guessed. Photos a culling app rejected are skipped by default, or recovered hidden or as usual (the `cullMarks` field, as for uploads; [Cull marks](#cull-marks)), and the photo tags Lifer wrote into a file come back with it.

## RAW and JPEG pairing

RAW extensions are listed in `apps/api/src/uploads/rawExtensions.ts` (`.cr2 .cr3 .nef .nrw .arw .raf .rw2 .orf .dng .pef .srw`, and `.tif`/`.tiff` only when the file holds sensor data). Lifer doesn't develop RAW files; it shows the JPEG preview embedded in them (`PreviewImage`, then `JpgFromRaw`, then `ThumbnailImage`, in `apps/api/src/uploads/exif.ts`).

A RAW and a JPEG are one capture with two `originals` rows (`kind = 'raw'` and `'jpeg'`). When a RAW arrives (`findRawRelatedCaptures` in `apps/api/src/uploads/rawMatching.ts`), Lifer looks for a capture with no RAW yet:

1. **Same file name stem**, ignoring a `-2` style suffix, and a capture time within one second. It counts only if exactly one capture matches.
2. Otherwise an **EXIF fingerprint**: strict is SHA-256 of capture time, sub-seconds, camera model and serial number; loose drops the sub-seconds and serial (`exif.ts`). Strict first, then loose.

One match links. Several matches are a collision and nothing links. No match: in a folder import the RAW isn't kept; picked for one species, it's filed into that species' `RAW` folder as an unlinked original (`capture_id` NULL, `species_id` set) that a later JPEG can claim; imported as the main file, it becomes its own capture shown through its embedded preview (`apps/api/src/uploads/raw.ts`).

A JPEG that arrives after its RAW claims the waiting RAW the same way, by stem and time, then by fingerprint (`photo.ts`). Trip imports pair by stem only, case-insensitively, preferring a RAW in the photo's own folder (`trips/import.ts`).

## EXIF, GPS and time

Lifer reads metadata with ExifTool through `exiftool-vendored` (`apps/api/src/uploads/exif.ts`), one ExifTool process per CPU core. It reads `DateTimeOriginal`, GPS latitude and longitude, camera model, lens, focal length, aperture, shutter speed, ISO, rating, and keywords (`Keywords`, `Subject`, `TagsList`, `HierarchicalSubject`, keeping only the last level of a hierarchy).

Capture time is the hard part, because most cameras record local wall-clock time without a zone:

- If ExifTool gives the time a zone (from `OffsetTimeOriginal`, or one `exiftool-vendored` infers from other timestamps or GPS with its default options), Lifer stores that instant.
- Otherwise it reads the wall-clock time as UTC, so the stored value doesn't depend on the server's own time zone.
- The camera's wall-clock time is kept separately and used for file names and the year folder, so a photo taken at 23:30 on 31 December stays in that year whatever zone the server is in. Uploads, trip imports, reimport's "organize" and Reorganize all file by it (Reorganize reads it from the file again).
- A `legacyTakenAt`, the reading older versions made in the server's zone, is computed too, so pairing still finds captures imported before this rule.

Tests in `apps/api/src/uploads/exifTimezone.test.ts` cover the explicit-offset case and server-zone independence. How `exiftool-vendored` ranks its own inference sources isn't tested by Lifer.

Videos use the same reader (`apps/api/src/uploads/video.ts`); their time comes from `DateTimeOriginal` only. Duration comes from FFmpeg.

## Duplicates {#duplicates}

- **Exact:** the SHA-256 of the whole file, computed while it's received (`apps/api/src/lib/stagedUploads.ts`, `tusUploads.ts`, `uploads/fileFingerprint.ts`) and stored as `captures_all.fingerprint` and `originals.content_hash`.
- **Near duplicates:** when there's no exact match, a CLIP image vector with cosine similarity of 0.95 or more to an existing capture (`packages/core/src/species/embeddings.ts`).

Inspect reports either as a possible duplicate and the web app asks whether to import anyway. `POST /api/uploads` imports a duplicate unless the request sets `skipDuplicates=1`, in which case it returns the existing capture. Trip scans don't offer files whose hash is already known. The database doesn't enforce uniqueness (see [Data model](./data-model.md#invariants-to-keep)), because importing the same file twice on purpose is allowed. The EXIF fingerprint is for RAW pairing, not duplicate detection.

## Choosing the species

Nothing is assigned automatically at import. `/api/captures/suggest-species` and inspect only suggest (`apps/api/src/captures/suggest.ts`); the user confirms. Suggestions come from the identification model (BioCLIP 2) when it's downloaded, otherwise CLIP, on the detected animal's crop, pooled across a burst of similar frames, ranked against the region's checklist (or the user's own species and downloaded packs when there's no region), and adjusted for season, vagrancy and local rarity (`packages/core/src/species/embeddings.ts`). A keyword in the file that names exactly one species is put first. See [ADR 0008](./decisions/0008-in-process-onnx-inference.md) for where the models run.

Species are only assigned without the user in recovery: reimport (from keywords and names) and trip scans (from the trip's `.lifer/index.json`).

## Where files go

Store-mode imports file the original under (`apps/api/src/uploads/organizedPath.ts`):

```text
[<location>/][Wildlife <year>/]<Taxon>/<Species folder>/<RAW | Adjusted | Video>/<file>
```

- `<Taxon>` is the group label, such as `Birds` or `Mammals`; Other Taxa use iNaturalist's group, or `Other`.
- The year and location levels are optional per user (`users.organize_originals_by_year`, `organize_originals_by_location`).
- `<Species folder>` follows the user's naming styles (common name, scientific name, ABA or eBird code, or a combination; `apps/api/src/uploads/speciesFolderName.ts`). A common name shared with another species gets the scientific name added. Characters that aren't valid in file names are removed.
- The base is the trip's destination folder for trip imports, a chosen drive's or library root's `Lifer Originals` folder, or the library (`ORIGINALS_DIR`). Trip imports add the year level but never the location one.

Files keep their own names. A clash gets `-2`, `-3` and so on, up to 1000. Files are moved with a hard link and unlink, falling back to an exclusive copy: a move never overwrites (`packages/core/src/lib/safeFs.ts`). See [ADR 0007](./decisions/0007-library-layout-species-folders.md).

A managed original always stays under the base it was filed under (`locateManagedOriginal` in `apps/api/src/uploads/managedFolders.ts`: its trip's destination folder when it's inside it, else its volume's `Lifer Originals` folder for a file on a drive or library root, else the library). When the user changes a photo's species (or a new photo claims an unmatched RAW), only the `<Taxon>/<Species folder>` levels change: the base and any year and location folders above them stay as they are (`moveManagedOriginalToSpeciesFolder`). A file not in that layout is filed under its base with the current settings, and one outside every base Lifer knows, or on a drive that isn't connected, stays put. The move happens before the database changes and is undone if the transaction fails; a file on a volume keeps `volume_id`, with `volume_relative_path` updated; emptied species folders are removed. Unmanaged (linked) files never move. **Reorganize existing photos now** in [Settings > Library](../settings.md#photo-library-organization) (`POST /api/settings/reorganize-originals`) refiles every managed original (hidden ones too, not trashed ones) under its own base with the current naming, year and location settings, skipping files on disconnected drives. Reimport's "organize" is the one path that moves files into the library from elsewhere (`fileIntoMainLibrary` in `apps/api/src/uploads/common.ts`).

## Previews

`generateDerivatives` (`packages/core/src/uploads/image.ts`) decodes each photo once, rotated by its EXIF orientation, and writes three WebP files to `APP_DATA_DIR`: `display/` (2560 px), `medium/` (1024 px) and `thumb/` (400 px), never enlarged. Videos get a poster frame, and an H.264 MP4 under `video-preview/` when the original won't play in a browser. Previews are a cache: deleted with a failed import, and regenerated from the original when missing.

## Metadata Lifer reads

| Read | From | Used for |
|---|---|---|
| Capture time, GPS, camera, lens, exposure | EXIF | Display, search, maps, RAW pairing, year folders. Copied into `captures_all` once. |
| Rating (1 to 5) | `XMP:Rating` in the file, else its sidecar | `captures_all.quality_rating` at import and reimport |
| Keywords | `Keywords`, `Subject`, `TagsList`, `HierarchicalSubject`, and the sidecar | Species suggestion, and species recovery on reimport |
| Cull marks | Rating `-1`, `XMP-xmpDM:Pick` and `Good`, digiKam pick and colour labels, Photo Mechanic tags, Lightroom and Bridge colour labels | Skip, hide or ignore rejects at import (below) |

### Cull marks

Culling apps such as Lightroom, Photo Mechanic and digiKam mark photos as picks or rejects and give them colour labels. `apps/api/src/uploads/cullMarks.ts` normalises those into a verdict (`pick` or `reject`) and a label, merging the file and its sidecar, and a photo with its RAW; a reject anywhere wins. Stored as `captures_all.cull_verdict` and `cull_label` (M130).

At import the user chooses what a reject does: skip it, import it hidden (`hidden_at` set, out of every view until unhidden), or ignore the mark. Uploads default to ignore, trip imports and reimport to skip. Lifer never writes, deletes or moves a file because of a cull mark, and leaves a `-1` rating in place when it has no rating of its own (`apps/api/src/uploads/xmpSidecarSync.ts`). Inspect in the browser sees only the file, since a browser upload carries no sidecar.

## Metadata Lifer writes

Lifer writes its species and rating back to files so the library stays meaningful without Lifer, and so a lost database can be rebuilt ([ADR 0006](./decisions/0006-database-primary-files-carry-recovery-copy.md)). Everything goes through `syncCaptureXmpSidecars` (`apps/api/src/uploads/xmpSidecarSync.ts`) and `writeCaptureMetadata` (`apps/api/src/uploads/exif.ts`).

**Only managed files are written**: originals with `managed = true` and `ref_type = 'path'`. Linked files and S3 objects are never touched.

**Where:** inside JPEG, TIFF, PNG, DNG, WebP, HEIC and HEIF files. For everything else, RAW and video, a `<name>.xmp` sidecar next to the file.

**What:**

| Tag | Value |
|---|---|
| `XMP-dc:Subject` | Common name, scientific name, ABA code and eBird code of each species in the photo, `Lifer:Cover` if it's the species' cover photo, and the photo's own tags ("flight shot") |
| `XMP-lr:HierarchicalSubject` | `Species\|<Taxon>\|<Family>\|<name>`, for example `Species\|Birds\|Accipitridae\|Bald Eagle`, and `Lifer Tags\|<tag>` for each photo tag |
| `XMP-dc:Title` | The species names |
| `IPTC:Keywords`, `IPTC:ObjectName` | The same, embedded files only |
| `XMP-xmp:Rating` | Lifer's 1 to 5 rating; removed when the user clears it |
| `XMP-exif:GPSLatitude`, `GPSLongitude` | Sidecars only |

Keywords from other tools are kept: only Lifer's own (species names and codes, `Lifer:Cover`, anything under `Species|`, and photo tags) are replaced. Photo tags are plain keywords, so other apps show them like any other; the `Lifer Tags|<tag>` entry beside each records that the keyword is Lifer's, so removing, renaming or deleting a tag in Lifer removes it from the file and never a keyword another app added (a `|` in a tag is written as `/` there). A keyword another app added with the same text as a Lifer tag goes with the tag. A write that doesn't carry the tags (a species-only rewrite) leaves them as they are. Reimport reads the `Lifer Tags|` entries back. **Camera fields are never written**: capture time, camera, lens and exposure are not part of the write (`exifMetadata.test.ts` checks this).

**How:** `exiftool -overwrite_original`, one write at a time per file. ExifTool rewrites the file through a temp file and rename, so an interrupted write doesn't leave a half-written photo, but the file's modification time changes, which backup tools see as a change.

**When:** in the background after an upload commits, and after a change of species (including extra species), rating, cover, or tags (including renaming or deleting a tag in Manage tags), after a reorganize, and after a catalog update moves photos to a merged species. A failed write is logged or ignored and never fails the request, so files can lag behind the database. Trip imports and video uploads don't write at import; their files are written at the next change.

## Recovery files in the library

Besides tags, Lifer keeps a few small JSON files in `.lifer` folders, written atomically (`apps/api/src/lib/atomicWrite.ts`: a temp file flushed with `fsync`, renamed over the old one, then the folder flushed too, except on Windows, which can't open a folder for it):

| File | Holds | Written |
|---|---|---|
| `<library>/.lifer/collection-state.json` | Per user (by email): seen species, archived and hidden species, targets, tier overrides, checklist additions. Species by scientific name. | Two seconds after a change to any of these (`apps/api/src/lib/collectionState.ts`) |
| `.lifer/albums.json` in each photo folder, and in the taxon folder above | Which albums each photo is in, by album name | On album add and remove (`apps/api/src/albums/albumIndex.ts`) |
| `<trip destination>/.lifer/index.json` | The species of each imported trip photo, by relative path | After each trip import (`apps/api/src/trips/tripIndex.ts`) |

How they're read back is in [State and sync](./state-and-sync.md#reimport).
