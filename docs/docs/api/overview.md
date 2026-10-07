---
title: API overview
description: Build your own integrations against a Lifer server with API keys.
slug: /api/overview
---


# Lifer API

A self-hosted Lifer server exposes an HTTP API so you can build your own integrations, like: show a
life-list counter in Home Assistant, post new lifers to a chat, generate a portfolio site, script
imports, mirror your library into another tool, back up your originals, and more.

- **Machine-readable description:** `GET /api/openapi.json` on your server (OpenAPI 3.1). Load it
  into Swagger UI, Postman, or a client generator.
- **This guide:** authentication, conventions and the integration endpoints.

The desktop app doesn't offer API keys; this is for server (Docker) installs. See [Install with Docker](../install/docker.md) if you don't have a server yet.

## Authentication

Create a key under **Settings > Account > API keys** (the **Manage API keys** button), choosing only the permissions (scopes) it needs. The key
is shown once. Send it on every request as the `x-api-key` header:

```sh
curl -H "x-api-key: $LIFER_KEY" http://lifer.local:4000/api/life-list/summary
```

A request with no key, an unknown key, or a key without the route's scope gets `401` with `{"error": "Not authenticated"}` (the three look the same on purpose). A key can't create or revoke other keys; only you, signed in, can. Keep keys server-side: a key
is as good as your login for whatever it's allowed to do.

**Use a key, not the login cookie.** The web app itself signs in with a session cookie, and the
server only accepts cookie-based writes (anything other than `GET`, `HEAD` or `OPTIONS`) that carry
the header `x-lifer-client: 1` and come from Lifer's own site. Anything else gets
`403 Cross-site request blocked`. This is what stops other websites from making changes with your
login. Requests with `x-api-key` skip this check entirely, so scripts using a key don't need the
extra header.

| Scope | Allows |
|---|---|
| `photos.read` | The photo feed (`GET /captures`) and image files: thumbnails, display images, originals, RAWs, videos |
| `photos.write` | Importing photos (`POST /uploads`, [resumable uploads](#large-files)) and editing them: species, extra species, rating, tags, capture time, location |
| `collection.read` | The life list and its summary counts, and the species you added to checklists yourself |
| `collection.write` | Adding species to region checklists yourself, and removing them again |
| `gallery.read` | The gallery listing and content search |
| `species.read` | Species search and details, reference photos |
| `stats.read` | Statistics, including the life list as CSV |
| `trips.read` | Trips and their photos |
| `album.read` / `album.write` | Reading and managing albums |
| `share.read` / `share.write` | Reading, creating and revoking album share links |

## Conventions

- **Base path:** everything is under `/api`, e.g. `http://lifer.local:4000/api/captures`.
- **JSON** in and out, except file downloads, `POST /uploads` and `POST /uploads/inspect` (multipart), and [resumable uploads](#large-files).
- **Errors** are `{ "error": "message", "code": "reason" }` with a 4xx/5xx status. `error` is written for a person; `code` is only there on some errors, as a stable reason your script can check. A 5xx says only `Internal server error`, with the details in the server log.
- **Input is checked** against each route's schema (the same one `/api/openapi.json` shows), after the key and before the route does anything. A query parameter, path parameter or JSON body that doesn't match (a wrong type, a missing or unknown field, a number out of range, a malformed id) gets `400` with `"code": "invalid_request"` and an `error` naming the field, like `Invalid body: rating must be <= 5`. Some routes answer `404` for a malformed id instead, the same as for an unknown id. An empty query parameter (`?regionId=`) counts as not given.
- **Image links** in responses are paths on the server (like `/api/photos/<id>/thumb`); prefix your
  server URL and send the key.
- **IDs** are UUIDs. Look species and region IDs up on the server you're talking to (for example with `GET /api/species?q=`) rather than copying them from another install: they usually match between installs, but aren't guaranteed to. To match species across installs, use `scientificName`.
- **Times** are ISO 8601. `updatedAt` on photos carries full microsecond precision; pass it back
  unchanged.
- **No rate limits**, but be kind to your server: poll summaries every few minutes at most, and use
  `since` for syncing instead of re-reading everything.

## The integration endpoints

### `GET /api/captures` (photos.read): the photo feed

Every photo in your library, ordered by when it last changed. Built for syncing.

| Query | Meaning |
|---|---|
| `since` | Only photos changed after this time: new photos, and changes to species, rating, tags, location, capture time, or moving to/from the trash |
| `cursor` | The previous page's `nextCursor` |
| `limit` | Page size, 1-500 (default 100). Larger values are capped at 500 |
| `speciesId` | Only photos showing this species |
| `includeDeleted=1` | Include photos in the trash, with `deletedAt` set (`0`, the default, leaves them out) |

```json
{
  "items": [
    {
      "captureId": "…", "photoId": "…",
      "speciesId": "…", "scientificName": "Aix galericulata", "commonName": "Mandarin Duck", "taxonClass": "aves",
      "additionalSpecies": [],
      "takenAt": "2025-04-12T09:31:05.000Z", "createdAt": "…", "updatedAt": "2026-09-25T18:02:11.482193Z", "deletedAt": null,
      "lat": 49.28, "lon": -123.12, "regionId": "…", "regionName": "British Columbia", "locationLabel": "Stanley Park", "tripId": null,
      "camera": { "model": "EOS R5", "lens": "RF100-500mm", "focalLengthMm": 500, "aperture": 7.1, "shutter": "1/1000", "iso": 800 },
      "rating": 4, "tags": ["courtship"], "kind": "image", "width": 2048, "height": 1365,
      "originals": {
        "jpeg": { "fileName": "IMG_4411.jpg", "sizeBytes": 8123456, "sha256": "…" },
        "raw": { "fileName": "IMG_4411.CR3", "sizeBytes": 41234567, "sha256": "…" },
        "video": null
      },
      "images": { "thumb": "/api/photos/…/thumb", "display": "/api/photos/…/display", "original": "/api/photos/…/original" }
    }
  ],
  "nextCursor": "…"
}
```

`images` is `null` for the rare photo with no current image file, and any of `originals.jpeg`, `raw` or `video` is `null` when the photo doesn't have that kind of file.

**Syncing pattern:** request pages until `nextCursor` is `null`, remembering the last item's
`updatedAt`. Next run, pass it as `since`. Photos deleted permanently (emptied from the trash) just
stop appearing; if you mirror deletions, pass `includeDeleted=1` to see trashed photos, and do an
occasional full pass to catch permanent deletions.

### `GET /api/life-list` (collection.read)

One row per species you've photographed, oldest first: `speciesId`, names, `taxonClass`, `family`,
`status` (`photographed` or `seen`), `firstCollected`, `lastPhotographed`, `photoCount`, `bestRating`,
`coverPhotoId` and `coverImage` (your chosen species photo). `?taxonClass=aves,mammalia` filters;
`?include=seen` adds species marked seen without a photo (`status: "seen"`).

### `GET /api/life-list/summary` (collection.read)

Cheap enough to poll. `?regionId=` adds progress on that region's checklist.

```json
{
  "photographedSpecies": 412, "seenOnlySpecies": 9, "photos": 18230, "newThisYear": 37,
  "byTaxonClass": { "aves": 301, "mammalia": 64, "squamata": 22 },
  "latestLifer": { "speciesId": "…", "commonName": "Bohemian Waxwing", "scientificName": "Bombycilla garrulus",
                   "firstCollected": "2026-09-20", "coverImage": "/api/photos/…/display" },
  "region": { "regionId": "…", "name": "British Columbia", "photographed": 212, "checklistSize": 661 }
}
```

Find a region ID in the Lifer UI (the region page URL) or in any photo's `regionId`. An unknown
region returns `404`.

### Checklist additions (collection.read, collection.write)

Put a species on a country's, province's or sea zone's checklist yourself, for example a species you
imported by hand that you also found in another province. Your additions are kept apart from the
catalog's own checklists, so catalog updates and offline packs never remove them, and removing one
never removes anything the catalog lists. Species imported by hand from iNaturalist are stored the
same way, as the importing user's additions.

| Request | |
|---|---|
| `PUT /api/regions/{regionId}/checklist-additions/{speciesId}` | Adds it (collection.write). No body. Safe to repeat: a second call answers `200` with `"added": false` |
| `DELETE /api/regions/{regionId}/checklist-additions/{speciesId}` | Removes your addition (collection.write). `404` with `"code": "not_added"` if you hadn't added it there |
| `GET /api/regions/{id}/checklist-additions` | The species you added to this region (collection.read) |
| `GET /api/sea-zones` | Every sea zone, with its ID and name (collection.read) |
| `PUT /api/sea-zones/{seaZoneId}/checklist-additions/{speciesId}` | Adds it to a sea zone's checklist (collection.write). No body. Safe to repeat |
| `DELETE /api/sea-zones/{seaZoneId}/checklist-additions/{speciesId}` | Removes your addition (collection.write). `404` with `"code": "not_added"` if you hadn't added it there |
| `GET /api/sea-zones/{id}/checklist-additions` | The species you added to this sea zone (collection.read) |
| `GET /api/species/{id}/checklist-additions` | The regions (`items`) and sea zones (`seaZones`) you added this species to (collection.read) |

```json
{ "ok": true, "added": true, "alreadyOnChecklist": false }
```

`alreadyOnChecklist` is `true` when the catalog already lists the species there. World and the
continents have no checklist of their own, so adding to one answers `400` with
`"code": "no_checklist"`. An addition to a province also shows on its country's checklist. A sea
zone has no page of its own: its additions show on a coastal region's checklist when that zone is
selected as nearby water. Each entry in `seaZones` carries a `nearRegionId`, a region that offers
the zone, or `null`.

### Image files (photos.read)

`/api/photos/{photoId}/thumb` (400px wide), `/medium` (1,024px) and `/display` (2,560px) as WebP, `/original` (the original file as imported; add
`?download=1` for a download filename), `/original-raw`, `/video` (supports Range requests). An
original on a drive that isn't connected returns `409`.

### `POST /api/uploads` (photos.write): importing

`multipart/form-data` with:

| Field | |
|---|---|
| `file` | The photo: JPEG, PNG, WebP, TIFF or HEIC (or a RAW on its own). Or send `uploadId` instead (see [Uploading large files](#large-files)) |
| `rawFile` | Optional RAW belonging to `file`. Or `rawUploadId` for a RAW sent as a resumable upload |
| `speciesId` | Required. Look it up with `GET /api/species?q=mallard` (species.read) |
| `regionId`, `locationLabel`, `albumId`, `tripId` | Optional |
| `skipDuplicates` | `1` to return the existing photo (`200`, `"duplicate": true`) when you already have this exact file, instead of importing it again. Use this in any script that might resend files |
| `cullMarks` | What to do with a photo a culling app rejected: `ignore` (the default) imports it, `skip` answers `200` with `"skipped": "rejected"` and imports nothing, `hide` imports it hidden (`"hidden": true`). See [Culling with other apps](../guides/culling-with-other-apps.md) |

Capture time, GPS, camera details and the **star rating** are read from the file itself, so ratings
set in Lightroom, digiKam or a culling tool come along, and so do a culling app's pick or reject
flag and colour label. Returns `201` with `captureId` and `photoId`.

### `POST /api/uploads/inspect` (photos.write): checking before importing

Send the `file` (and optionally `regionId`) to learn whether you already have it (`possibleDuplicate`,
exact or near-identical) and, with a region, the likely species (`suggestions`). `cull` says what a
culling app marked in the file: `{ "verdict": "reject", "label": "red" }` (either can be `null`). The server keeps
the file for two hours and returns a `stagedId`: import it with `POST /api/uploads` sending
`stagedId`, `fileName` and `fileType` instead of `file`, so it doesn't go over the network twice.
A `410` means the kept copy has expired; send the file instead.

To check a file you sent as a [resumable upload](#large-files), send `uploadId` instead of `file`, then import it with the same `uploadId`.

### Uploading large files (photos.write) {#large-files}

A multipart `POST /api/uploads` sends the whole file in one request, which is fine for most photos but can fail on a big RAW or video: a reverse proxy may refuse the request's size, and a dropped connection means starting over. For those, use a resumable upload. Lifer speaks [tus 1.0](https://tus.io/protocols/resumable-upload), an open standard with ready-made clients for most languages (like `tus-js-client` or `tuspy`) that handle the pieces, retries and resuming for you.

1. **Create the upload:** `POST /api/uploads/tus` with `Tus-Resumable: 1.0.0`, `Upload-Length` (the file size in bytes) and `Upload-Metadata` carrying `filename` and `filetype` (each value base64 encoded). The answer is `201` with a `Location` like `/api/uploads/tus/{id}`. That last part, `{id}`, is your `uploadId`.
2. **Send the bytes:** `PATCH` the `Location` with `Content-Type: application/offset+octet-stream` and `Upload-Offset`, in pieces of about 8 MB. If a connection drops, `HEAD` the same URL to read `Upload-Offset` and carry on from there. `DELETE` cancels.
3. **Import it:** `POST /api/uploads` with `uploadId` in place of `file` (and `rawUploadId` in place of `rawFile`), or check it first with `POST /api/uploads/inspect`.

```sh
FILE=IMG_4411.jpg
LOCATION=$(curl -si -X POST http://lifer.local:4000/api/uploads/tus \
  -H "x-api-key: $LIFER_KEY" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(wc -c < "$FILE" | tr -d ' ')" \
  -H "Upload-Metadata: filename $(printf %s "$FILE" | base64),filetype $(printf image/jpeg | base64)" \
  | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r')

# One PATCH for a small file; a tus client splits big ones into pieces.
curl -X PATCH "http://lifer.local:4000$LOCATION" -H "x-api-key: $LIFER_KEY" \
  -H "Tus-Resumable: 1.0.0" -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" --data-binary @"$FILE"

curl -X POST http://lifer.local:4000/api/uploads -H "x-api-key: $LIFER_KEY" \
  -F uploadId="${LOCATION##*/}" -F speciesId="$SPECIES_ID"
```

Uploads belong to the key's user. A finished upload waits 2 hours for its import, and an unfinished one is removed 2 hours after its last piece. Status codes to expect:

| Status | Meaning |
|---|---|
| `404` | No such upload, or it belongs to someone else |
| `409` | The `Upload-Offset` doesn't match the server's (ask with `HEAD`), or the upload is already being imported by another request |
| `410` | The upload expired or was already imported. Send the file again |
| `413` | The file is over the server's `MAX_UPLOAD_BYTES` (no limit unless the server sets one), or a proxy refused a piece as too large: send smaller pieces |

### Editing photos (photos.write)

| Request | Body |
|---|---|
| `PATCH /api/captures/{id}/reassign` | `{ "speciesId": "…" }` changes the species |
| `POST /api/captures/{id}/species` | `{ "speciesId": "…" }` adds another species in the same photo |
| `DELETE /api/captures/{id}/species/{speciesId}` | removes an additional species |
| `PATCH /api/captures/{id}/rating` | `{ "rating": 1-5 }`, or `null` to clear |
| `PATCH /api/captures/{id}/tags` | `{ "tags": ["…"] }` replaces the tags |
| `PATCH /api/captures/{id}/taken-at` | `{ "takenAt": "ISO time" }` |
| `PATCH /api/captures/{id}/region` | `{ "regionId": "…", "locationLabel": "…" }` (either or both) |

Changes are also written into the photo's own metadata (or its RAW sidecar) where Lifer manages the
file, so Lightroom and digiKam see them too.

### `GET /api/gallery` (gallery.read): browsing with filters

The same filtered list the Gallery page shows. Filters include `taxa`, `regionId`, `dateFrom`,
`dateTo`, `tag`, `tripId`, `albumId`, `onlyTopRated=1`, `onlyVideo=1`, `hidden=1` (only the photos
imported hidden because a culling app rejected them) and `sort` (`newest`, `oldest`, `ratingHigh`,
`ratingLow`). Each item has `cullVerdict` and `cullLabel`, what a culling app marked it at import.

Without `limit`, it returns every matching photo at once as `{ "items": [...] }`. With `limit`
(1-500), it returns one page plus `nextCursor` (`null` on the last page), and the first page also
has `total`, the number of matching photos. Pass `nextCursor` back as `cursor` with the same filters
and `sort`. For syncing, `GET /api/captures` is the better fit.

### `GET /api/species` (species.read): finding a species

`?q=` searches common and scientific names, old names, codes, genus and family, ignoring accents.
Add `regionId` to rank species on that region's checklist higher. It returns
a `results` list whose items have `id`, `scientific_name` and `common_name` (note the underscores
here), best match first.

Everything else (the rest of gallery and species, stats, trips, albums, shares) is listed with its
parameters in `/api/openapi.json`.

## Changes to this API

Routes and fields documented here are meant to stay stable; additions are backwards compatible.
Anything that has to change is noted in the [changelog](https://github.com/Sparklysparkspark/lifer-app/blob/main/CHANGELOG.md).
