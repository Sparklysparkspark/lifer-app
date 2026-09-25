# Lifer API

A self-hosted Lifer server exposes an HTTP API so you can build your own integrations: show a
life-list counter in Home Assistant, post new lifers to a chat, generate a portfolio site, script
imports, mirror your library into another tool, or back up your originals.

- **Machine-readable description:** `GET /api/openapi.json` on your server (OpenAPI 3.1). Load it
  into Swagger UI, Postman, or a client generator.
- **This guide:** conventions, the integration endpoints, and ready-to-adapt recipes.

The desktop app doesn't offer API keys; this is for server (Docker) installs.

## Authentication

Create a key under **Settings > API keys**, choosing only the permissions (scopes) it needs. The key
is shown once. Send it on every request as the `x-api-key` header:

```sh
curl -H "x-api-key: $LIFER_KEY" http://lifer.local:4000/api/life-list/summary
```

A request with no key, or a key without the route's scope, gets `401`. Keep keys server-side: a key
is as good as your login for whatever it's allowed to do.

| Scope | Allows |
|---|---|
| `photos.read` | The photo feed (`GET /captures`) and image files: thumbnails, display images, originals, RAWs, videos |
| `photos.write` | Importing photos (`POST /uploads`) and editing them: species, extra species, rating, tags, capture time, location |
| `collection.read` | The life list and its summary counts |
| `gallery.read` | The gallery listing and content search |
| `species.read` | Species search and details, reference photos |
| `stats.read` | Statistics, including the life list as CSV |
| `trips.read` | Trips and their photos |
| `album.read` / `album.write` | Reading and managing albums |
| `share.read` / `share.write` | Reading, creating and revoking album share links |

## Conventions

- **Base path:** everything is under `/api`, e.g. `http://lifer.local:4000/api/captures`.
- **JSON** in and out, except file downloads and `POST /uploads` (multipart).
- **Errors** are `{ "error": "message" }` with a 4xx/5xx status.
- **Image links** in responses are paths on the server (like `/api/photos/<id>/thumb`); prefix your
  server URL and send the key.
- **IDs** are UUIDs. Species IDs are the same on every Lifer install.
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
| `limit` | Page size, 1-500 (default 100) |
| `speciesId` | Only photos showing this species |
| `includeDeleted=1` | Include photos in the trash, with `deletedAt` set |

```json
{
  "items": [
    {
      "captureId": "…", "photoId": "…",
      "speciesId": "…", "scientificName": "Aix galericulata", "commonName": "Mandarin Duck", "taxonClass": "aves",
      "additionalSpecies": [],
      "takenAt": "2025-04-12T09:31:05.000Z", "createdAt": "…", "updatedAt": "2026-09-25T18:02:11.482193Z", "deletedAt": null,
      "lat": 49.28, "lon": -123.12, "regionId": "…", "regionName": "British Columbia", "locationLabel": "Stanley Park",
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

**Syncing pattern:** request pages until `nextCursor` is `null`, remembering the last item's
`updatedAt`. Next run, pass it as `since`. Photos deleted permanently (emptied from the trash) just
stop appearing; if you mirror deletions, pass `includeDeleted=1` to see trashed photos, and do an
occasional full pass to catch permanent deletions.

### `GET /api/life-list` (collection.read)

One row per species you've photographed, oldest first: `speciesId`, names, `taxonClass`, `family`,
`firstCollected`, `lastPhotographed`, `photoCount`, `bestRating`, and `coverImage` (your chosen
species photo). `?taxonClass=aves,mammalia` filters; `?include=seen` adds species marked seen
without a photo (`status: "seen"`).

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

Region IDs are the same on every install; find one in the Lifer UI (the region page URL) or in any
photo's `regionId`.

### Image files (photos.read)

`/api/photos/{photoId}/thumb` (400px), `/medium` (1,024px) and `/display` (2,560px) as WebP, `/original` (the full JPEG/PNG; add
`?download=1` for a download filename), `/original-raw`, `/video` (supports Range requests). An
original on a drive that isn't connected returns `409`.

### `POST /api/uploads` (photos.write): importing

`multipart/form-data` with:

| Field | |
|---|---|
| `file` | Required. JPEG or PNG (or a RAW on its own) |
| `rawFile` | Optional RAW belonging to `file` |
| `speciesId` | Required. Look it up with `GET /api/species?q=mallard` (species.read) |
| `regionId`, `locationLabel`, `albumId`, `tripId` | Optional |
| `skipDuplicates` | `1` to return the existing photo (`200`, `"duplicate": true`) when you already have this exact file, instead of importing it again. Use this in any script that might resend files |

Capture time, GPS, camera details and the **star rating** are read from the file itself, so ratings
set in Lightroom, digiKam or a culling tool come along. Returns `201` with `captureId` and `photoId`.

### `POST /api/uploads/inspect` (photos.write): checking before importing

Send the `file` (and optionally `regionId`) to learn whether you already have it (`possibleDuplicate`,
exact or near-identical) and, with a region, the likely species (`suggestions`). The server keeps
the file for two hours and returns a `stagedId`: import it with `POST /api/uploads` sending
`stagedId`, `fileName` and `fileType` instead of `file`, so it doesn't go over the network twice.
A `410` means the kept copy has expired; send the file instead.

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

Everything else (gallery, species, stats, trips, albums, shares) is listed with its parameters in
`/api/openapi.json`.

## Recipes

These are starting points, in Python 3 with the `requests` package. Set `LIFER` to your server URL
and `LIFER_KEY` to a key with the scopes noted.

```python
import os, requests
LIFER = os.environ["LIFER"].rstrip("/")          # e.g. http://lifer.local:4000
H = {"x-api-key": os.environ["LIFER_KEY"]}

def lifer_captures(since=None):
    """Yields every photo changed after `since` (all photos when None)."""
    params = {"limit": 500, **({"since": since} if since else {})}
    while True:
        page = requests.get(f"{LIFER}/api/captures", headers=H, params=params, timeout=60).json()
        yield from page["items"]
        if not page["nextCursor"]:
            return
        params = {"limit": 500, "cursor": page["nextCursor"]}
```

### Using Lifer alongside Immich (no API needed)

Point an Immich external library at the same folder Lifer stores your photos in. Lifer writes each
photo's species into the file itself (as keywords, with a `Species|Birds|<family>|<name>`
hierarchy, plus the star rating), so Immich, Lightroom and digiKam pick them up from the files; no
sync script required. Keep Lifer as the one making species changes, since it rewrites those
keywords when a photo's species changes.

### Life-list counter in Home Assistant (collection.read)

```yaml
# configuration.yaml
rest:
  - resource: http://lifer.local:4000/api/life-list/summary
    headers:
      x-api-key: !secret lifer_api_key
    scan_interval: 1800
    sensor:
      - name: Lifer species
        unique_id: lifer_species
        value_template: "{{ value_json.photographedSpecies }}"
        json_attributes:
          - newThisYear
          - photos
          - byTaxonClass
          - latestLifer
```

Add `?regionId=<id>` to the resource for "212 of 661 BC species". The same JSON works for a desk
display, a website badge (have a server-side script fetch it, since the key must stay private), or a
Stream Deck.

### Post new lifers to Discord (collection.read, photos.read)

```python
STATE = pathlib.Path("last-lifer.txt")
summary = requests.get(f"{LIFER}/api/life-list/summary", headers=H, timeout=60).json()
lifer = summary["latestLifer"]
if lifer and (not STATE.exists() or STATE.read_text() != lifer["speciesId"]):
    files = {}
    if lifer["coverImage"]:
        img = requests.get(LIFER + lifer["coverImage"], headers=H, timeout=60).content
        files = {"file": ("lifer.webp", img, "image/webp")}
    text = f"New lifer #{summary['photographedSpecies']}: {lifer['commonName']} ({lifer['scientificName']})"
    requests.post(os.environ["DISCORD_WEBHOOK"], data={"content": text}, files=files, timeout=60)
    STATE.write_text(lifer["speciesId"])
```

Swap the webhook call for Mastodon, Slack or Telegram; run it every few minutes.

### Portfolio site: one photo per species (collection.read, photos.read)

```python
out = pathlib.Path("site"); (out / "img").mkdir(parents=True, exist_ok=True)
rows = []
for s in requests.get(f"{LIFER}/api/life-list", headers=H, timeout=60).json()["species"]:
    if not s["coverImage"]:
        continue
    (out / "img" / f"{s['speciesId']}.webp").write_bytes(requests.get(LIFER + s["coverImage"], headers=H, timeout=60).content)
    rows.append(f"<figure><img src='img/{s['speciesId']}.webp' loading='lazy'><figcaption>{s['commonName'] or ''} <i>{s['scientificName']}</i></figcaption></figure>")
(out / "index.html").write_text(f"<h1>{len(rows)} species</h1>" + "".join(rows))
```

Publish the `site` folder anywhere; nothing in it needs the key.

### Import from a folder, a Lightroom export or a culling tool (photos.write, species.read)

```sh
SPECIES=$(curl -s -H "x-api-key: $LIFER_KEY" "$LIFER/api/species?q=Mandarin%20Duck" | jq -r '.results[0].id')
curl -s -H "x-api-key: $LIFER_KEY" \
  -F "file=@IMG_4411.jpg" -F "rawFile=@IMG_4411.CR3" \
  -F "speciesId=$SPECIES" -F "skipDuplicates=1" \
  "$LIFER/api/uploads"
```

Star ratings in the files come through, so photos rated in SuperPicky or Lightroom arrive rated.
`skipDuplicates=1` makes re-running a folder safe.

### Back up your originals (photos.read)

```python
root = pathlib.Path("lifer-backup")
for p in lifer_captures():
    for kind, route in (("jpeg", "original"), ("raw", "original-raw")):
        o = p["originals"][kind]
        if not o or p["deletedAt"]:
            continue
        dest = root / (p["commonName"] or p["scientificName"]) / o["fileName"]
        if dest.exists() and dest.stat().st_size == o["sizeBytes"]:
            continue
        r = requests.get(f"{LIFER}/api/photos/{p['photoId']}/{route}", headers=H, timeout=600)
        if r.status_code == 200:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(r.content)
```

Save the last item's `updatedAt` and pass it as `since` next time to make later runs incremental. For just the life
list, `GET /api/stats/export.csv` (stats.read) is a CSV.

## Changes to this API

Routes and fields documented here are meant to stay stable; additions are backwards compatible.
Anything that has to change is noted in `CHANGELOG.md`.
