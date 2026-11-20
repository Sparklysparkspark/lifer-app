# Lifer mobile companion: implementation plan

> **Calibration (2026-10-22):** effort figures in this plan are conventional engineering time. Lifer's
> measured pace is far faster for coding: about 176,000 lines (desktop, server, web, species matching
> and a 134,000-species catalogue) in roughly six effective weeks. Expect coding work to take a fraction
> of these estimates. Real-world time does not compress: maintainer reviews and decisions, beta periods,
> store review, real-device and real-card testing, and model labelling.

Status: planned, nothing built. Drafted 2026-10-22. Builds on `mobile-app.md` (the agreed idea),
`mobile-app-research.md` (what people ask for) and `desktop-server-sync.md` (the sync the phone
depends on). Mobile work starts after the desktop 1.0. Lifer database migrations this plan
needs are pre-approved (maintainer, 2026-10-23): claim the next number and list each in the report. The
phone's own on-device database is not a Lifer migration, but its schema is still reviewed.

Models: each work package names who builds it. Opus 5.5 builds sync, security, pairing, the offline
store, the on-device model, background tasks and store submission. Sonnet 5.5 builds screens. Haiku
5.5 builds chores. Every package gets an Opus 5.5 review against its acceptance criteria,
`ux-rules.md`, the mobile rules below and screenshots before hand-back. Workers read only their own
package and the sections it links to.

## Why

People want their archive in the field: "have I photographed this?", their life list with their own
photos, targets near them, and their best shots ready to show, even with no signal. Today the phone
only gets the server's web app in a browser, and desktop-only users get nothing. The companion app
fixes that without moving the archive onto the phone.

## What it is and isn't

- **A companion and field app.** Life list, targets, seen list, checklists for chosen regions, a
  showcase set, a thumbnail cache, a small species ID model, "Is this a lifer?", sightings with GPS,
  trip mode, your targets in the region, search, safe sharing.
- **Not the archive.** RAW import, full recognition runs, region downloads, archive health and every
  other heavy job stay on the desktop or server. The phone can ask for them, never run them.
- **Out of scope:** camera-roll backup, editing or developing photos, rating workflows, free-text
  field notes, an identification review queue, GPX or track logs, collectible cards, points, badges,
  streaks or leaderboards, a live point-and-collect camera, maps with detailed tiles.

## Principles

1. **Offline first.** Every screen opens from the phone's own store. The network only fills in and
   drains the queue. Nothing ever waits on a hub.
2. **Lifer data syncs by itself, all the time.** Lists, sightings, edits, targets and photos added
   on the phone sync automatically. Server users sync whenever there is a connection. Desktop-only
   users sync on the home Wi-Fi. Away from home, changes queue and drain on return without asking.
3. **No camera-roll backup.** Photos enter Lifer only three ways: added one at a time, an opt-in
   watched "Lifer" album, or opt-in suggestions the user confirms. Nothing uploads unasked.
4. **One hub.** The phone syncs with exactly one Lifer: the server when the library lives on one,
   otherwise the desktop. A desktop linked to a server hands the phone to the server.
5. **Lifer never phones home.** No analytics, no tracking, no crash SDKs, no third-party network
   calls. Store privacy labels say "no data collected". The only outside calls are ones the user
   starts (iNaturalist upload through the hub).
6. **Locations stay private.** Anything shared from the phone loses its location by default, and
   always for sensitive species.
7. **Mobile first.** Designed for one hand and a small screen, never the desktop UI shrunk. Same
   tokens, voice and `ux-rules.md`, plus the mobile rules below.
8. **An archive companion, not a game.** Plain records and the user's own photos. Store name
   "Lifer Wildlife Archive".
9. **Zero config.** Pair by scanning one QR code or signing in. No addresses, ports, certificates
   or settings to type.

## How it fits together

```
Desktop-only user, home Wi-Fi

  Phone app --mDNS finds _lifer-companion._tcp--> Desktop shell (Tauri)
     |                                              |
     +--TLS 1.3, certificate pinned from the QR--> LAN listener (Rust, in the shell)
                 device key in each request          | route allowlist, forwards to
                                                     v
                                     Lifer local API 127.0.0.1 (desktop gate, device scopes)
                                     embedded Postgres (kept alive by the tray helper)

Server user, anywhere

  Phone app --HTTPS + device key--> Lifer server (same companion routes)

Desktop linked to a server: the phone pairs with the server; the desktop's Connect phone page says so
and shows the server's QR.
```

The phone speaks one protocol to either hub: the companion routes below, under ordinary scoped keys
in `api_keys`.

## Technology (NEEDS MAINTAINER APPROVAL)

Recommendation: **React Native with Expo** in `apps/mobile` in this monorepo, sharing TypeScript from
`packages/shared` (types, taxonomy order, naming, keyword and synonym matching once extracted, ID
model versions), the i18next ICU setup and the design tokens. Native navigation, gestures, the system
photo picker, SQLite, Keychain and Keystore, and background tasks are first-class there. ONNX models
run through `onnxruntime-react-native` (Core ML on iOS, NNAPI or XNNPACK on Android), so the model
format matches the desktop's.

`packages/core` is Node-only (pg, onnxruntime-node, node:path) and is not imported by the phone.
Pure functions the phone needs move to `packages/shared` (A-12).

Before committing, P-00 builds the same two screens in Expo and in Tauri mobile and measures them.
Every package below assumes Expo. Decided 2026-10-25: Expo, without the comparison prototype.

## What the phone needs from the sync foundation

The sync foundation is planned inside Lifer 1.0 (`desktop-server-sync.md`) and is not re-planned
here. The phone needs these exact pieces from it. Items marked built exist today.

| # | Need | Why the phone needs it | State |
|---|---|---|---|
| F1 | Instance id on `GET /health` | The phone knows its hub by id, whatever address answers | Built |
| F2 | `(updated_at, id)` change cursor that never skips a row, with tombstones | Delta pulls survive long imports and deletions | Built for captures and species marks |
| F3 | The same feed for albums, album membership, trips, tags, ratings, cover photos and species corrections | Showcase (favourites, covers), trip mode, search by tag | Not built |
| F4 | Version-checked writes for species marks ("newest edit wins against the version last seen") | The phone marks seen and targets offline | Not built (marks have no version check) |
| F5 | Idempotent new-photo push, deduplicated by fingerprint, with resumable upload | Retries from a flaky phone never duplicate | Built for the desktop push; must accept a device key |
| F6 | The change feed served by the desktop's own API in desktop mode, over local and mirror rows | The desktop is the hub for desktop-only users | To confirm |
| F7 | Stable derivatives per capture: thumb and a full-screen display size, with ETag | Thumbnail cache and showcase | Thumb and medium exist; display size to confirm |
| F8 | Sync of the settings that change what the phone shows: naming preference, sensitive-species list and geoprivacy defaults, chosen regions | Same names and privacy rules on the phone | Not built |
| F9 | Edits to mirrored rows on a linked desktop are pushed | Phone edits that reach the server are not overwritten by a desktop | Not built |

F3, F4, F6 and F8 block milestone M3. F9 blocks nothing on the phone but matters for people with both
a desktop and a server.

## Connection and pairing

### Desktop-only

1. Settings > Connect phone on the desktop shows **Connect a phone**: a QR code in the shared Modal
   with the same code as 6 digits under it (shown as "482 913"), valid for 5 minutes.
2. The QR holds `{ v: 1, kind: "desktop", instanceId, addresses: [ip:port...], certSha256, code }`.
3. Scanning: the phone connects over TLS 1.3 to one of the addresses, pins `certSha256`, and calls
   `POST /api/companion/v1/pair` with `{ code, deviceName, platform }`. The reply carries a device key.
   Typing: the person types only the 6 digits. The phone browses Bonjour/NSD for
   `_lifer-companion._tcp` and, for each Lifer found, runs a key exchange keyed by the code
   (CPace, draft-irtf-cfrg-cpace, ristretto255 and SHA-512, in `packages/shared/src/companionPake.ts`):
   `POST /api/companion/v1/pair/start` with `{ sid, ya }` over a TLS session that accepts any
   certificate and reports the one it saw; the hub answers `{ session, yb, tagB }`, where `tagB`
   binds the hub's own certificate fingerprint. The phone accepts only if `tagB` checks out against
   the certificate it saw, then sends `POST /api/companion/v1/pair/finish` with `{ session, tagA,
   deviceName, platform }` pinned to that certificate, and gets its key. The code never crosses the
   network, so a man in the middle with another certificate fails and has nothing to test guesses
   against offline: each run is one online guess.
4. Guessing: every wrong code and every key-exchange run spends one guess from a budget of 5 shared by
   all clients; spending it burns every live code (the person shows a new one). On a desktop, with
   one live code, that is at most 5 in a million per code shown, on top of 3 tries a minute per LAN
   address at the listener and 5 a minute per address at the API.
5. The key lives in the iOS Keychain or Android Keystore. The desktop stores only its hash, as for
   every API key. No second confirmation: scanning the screen is the consent (`ux-rules.md` D2).
6. Afterwards the phone finds the desktop by mDNS (`_lifer-companion._tcp`, TXT record carrying the
   instance id only) and falls back to the last known addresses. A changed IP is found again by
   instance id; a changed certificate needs a re-pair.

The desktop shell generates the self-signed certificate once (stored in the app data folder, private
key readable only by the user), and starts the LAN listener only while at least one phone is paired.

### Server

- Sign in on the phone with the server's address, username and password (creates a device key, same
  route with a session instead of a code), scan the QR from the server's Settings > Connect phone, or
  type the server's address once (one field, no key) with the 6 digits. The code goes to
  `POST /api/companion/v1/pair` over the server's TLS. A server can have several live codes (one
  per user); the shared guess budget still burns them all after 5 wrong guesses, which also means
  anyone who can reach the server can stop code pairing for everyone by guessing (sign-in still works).
- Public HTTPS uses the system trust store. A plain-HTTP server on the local network is allowed only
  on private addresses, the same rule as the desktop link key.

### Later options

- **Tailscale:** the LAN listener already answers on any interface the user allows, so a Tailscale
  address works once listed in the QR. Documented later, no code beyond listing it.
- **Sync bundle in iCloud Drive or Dropbox:** a later design, not in this plan.

## Sync behaviour

- **Lifer data** (marks, targets, sightings, edits, trips, settings in F8): pulled and pushed
  automatically. Server users on any connection. Desktop-only users whenever the desktop is found on
  the local network.
- **Photo uploads and media downloads:** follow the upload settings.
  - **Wi-Fi only:** on by default.
  - **Only while charging:** off by default.
  - **Resume after interruptions:** always; resumable uploads continue from the last byte.
- **When it runs:** on launch, on returning to the foreground, on pull to refresh, when the hub is
  found, and in the OS's background windows (P-09). iOS gives short and unpredictable windows, so
  every step is small, resumable and safe to stop at any point.
- **Conflicts:** the foundation's rule (F4, F5). The phone never compares clocks.
- **Status:** one calm line, "Synced 2 min ago" or "12 changes waiting for your Lifer on home Wi-Fi",
  never a blocking banner.

### How photos get into Lifer

1. **One at a time.** From Identify or a species page: the system photo picker (no library
   permission needed), the camera (a back-of-camera or digiscoped shot), or the share sheet from
   another app.
2. **Watched "Lifer" album (opt-in).** Anything the user puts in an album named "Lifer" in Photos
   (iOS) or a "Lifer" album folder (Android) uploads automatically. Turning it on asks for access to
   photos at that moment, with the reason in plain words.
3. **Suggestions (opt-in).** An on-device detector looks at new camera-roll photos and proposes the
   ones with animals. Nothing uploads until the user confirms each one or a group. The detector runs
   only on the phone and never sends a photo anywhere to decide.

People who already back up their camera roll with Immich are pointed to Lifer's server-side Immich
integration (desktop task #25), which pulls animal photos from Immich, instead of a second phone
backup. The phone's Settings shows that as one line with a link to the docs, only for server users.

## Offline content and storage

| What | Where on the phone | Size guide | Rule |
|---|---|---|---|
| Life list, targets, seen list, sightings, trips | SQLite | about 2 MB for 5,000 species | Always kept |
| Region checklists chosen before a trip | SQLite | about 1 to 4 MB per country | Kept until removed |
| Showcase: the best photo per species (its cover photo) plus the Favourites album, at full screen size (about 2048 px long edge) | App support folder, excluded from cloud backup | about 600 KB each; 1,000 species is about 600 MB | Kept; the user sees its size and can limit it to favourites |
| Thumbnails of the whole library (about 400 px) | Caches folder | about 30 KB each; 60,000 photos is about 1.8 GB | Under the user's cap (default 1 GB), least recently viewed evicted first |
| Species ID model and region vectors | App support folder | see the model section | Kept |
| Photos added on the phone | Outbox | original size | Deleted from the outbox once the hub confirms |

Download order: showcase, then cover thumbnails of photographed species, then trip-region species,
then everything else by date. A full disk pauses downloads with one plain notice, never a crash.

## On-device species ID model

### Size and choice

The desktop's BioCLIP 2 (ViT-L/14) is about 1.2 GB at full precision and about 300 MB as int8, too
large and slow for a phone. Candidates, measured in P-14:

| Candidate | Image encoder size (int8, approx.) | Licence | Notes |
|---|---|---|---|
| BioCLIP (v1, ViT-B/16) | about 90 MB | MIT (code and weights) | Recommended start: same family as desktop, 512-dimension vectors |
| BioCLIP 2 (ViT-L/14) int8 | about 300 MB | MIT | Accuracy ceiling for the comparison only |
| A small student distilled from BioCLIP 2 (ViT-S size) | about 25 MB | ours, MIT weights | Later, if v1 is too slow on low-end Android |

Target budgets: under 1.5 s per photo on a three-year-old mid-range Android, under 0.5 s on a recent
iPhone, peak memory under 400 MB.

### Reference vectors

- Vectors come from the catalog's per-gallery-photo reference images, computed with the mobile
  model and its own version string (`MOBILE_ID_MODEL_VERSION`). Per-gallery-photo vectors are kept,
  never collapsed to one average per species, because they made suggestions good.
- Stored as int8, 512 dimensions, about 512 bytes each. About 20 per species: 3,000 species in a
  region is about 30 MB.
- Matching is restricted to the region's checklist (from the photo's location or the phone's), with
  the same keyword and synonym rules the desktop uses.
- Computed by one parameterised, resumable data-pipeline command that only processes what changed
  (A-10). Published with the next catalog republish, which the maintainer approves first.

### Where the model comes from

The model ships inside the app (about 90 MB), so Identify works the first time a region syncs, with no
download from anyone. Region vectors come from the hub with the checklist bundle. The hub downloads
them from Lifer's own catalog store, the same way it gets packs today.

### Licence notes

- BioCLIP and BioCLIP 2 weights and code are MIT. Their training images carry many licences; the
  weights' licence is what governs distribution. Ship the model card and attribution in About.
- Reference vectors come from catalog photos under their own licences; they ship as they do in
  region packs today, with the attribution page.
- The desktop's subject crop uses `yolov8n.onnx` (Ultralytics, AGPL). Third-party AGPL code can't be
  covered by Lifer's App Store exception, so it **must not ship in the iOS app**. The phone starts
  with a user crop (pinch a box around the animal, prefilled to the centre). If P-14 shows a
  detector is needed, use a permissively licensed one (open question 6).
- The suggestions detector (photos with animals) uses Apple's Vision framework on iOS (a system
  framework) and an Apache or MIT licensed classifier on Android. Google ML Kit is not used: it is a
  proprietary SDK.
- The licence audit in P-01 checks every dependency in the iOS build is MIT, BSD, Apache, ISC or
  similar.

## Mobile-first interface

- **Bottom tab bar, five tabs:**
  - Home: targets near here, recent photos, trip progress, sync line
  - Life list
  - Identify
  - Trips
  - Search
  Settings opens from Home's top bar.
- **One-handed:** primary actions in the lower third, bottom sheets instead of centred modals,
  swipe between photos, pull to refresh, long press for actions with a visible alternative.
- **Native per platform:** iOS HIG and Material 3 conventions, system share sheet, photo picker,
  haptics, back gestures, Android predictive back.
- **Field use:** big type, a high-contrast "Sunlight" appearance, works with gloves, the fastest path
  to "Is this a lifer?" is two taps from launch.
- **No game look:** species appear as list rows and photo tiles, never collectible cards.

### Mobile rules (added to `ux-rules.md` as section 16 by P-04)

| ID | Rule | Check |
|---|---|---|
| MR1 | Touch targets at least 44 pt on iOS and 48 dp on Android, including list rows, chips and close buttons. | E2E: walk every screen, assert hit boxes |
| MR2 | The primary action sits in the lower third of the screen, reachable by one thumb. | VISUAL |
| MR3 | Bottom sheets for choices and details; system alerts only for destructive confirmations. | LINT: no centred custom modal |
| MR4 | Offline is a calm state, never an error: one sync line, what's on the phone, what's waiting. | E2E in airplane mode |
| MR5 | Every screen opens from the local store at once; the network only fills in. | E2E: time to ready marker under 150 ms on the large fixture |
| MR6 | Sunlight appearance reaches 7:1 contrast for text and 4.5:1 for controls. | Contrast test over token pairs |
| MR7 | Dynamic Type and Android font scale up to the largest accessibility size without clipping or overlap. | Screenshot sweep at largest size |
| MR8 | Back (button, edge swipe, Android back) returns to the exact previous state, scroll included. | E2E |
| MR9 | Haptics only to confirm an action (photo added, sighting logged); never celebration or reward. | VISUAL |
| MR10 | Ask for a permission only at the moment it's needed, say why in plain words, and keep working if refused. | E2E with each permission denied |
| MR11 | Never read the whole photo library unless watched album or suggestions are on; the picker needs no access. | Code review |
| MR12 | Gestures always have a visible button alternative (swipe to delete has a menu item). | VISUAL |
| MR13 | Respect safe areas, notches, the Dynamic Island, the Android navigation bar and keyboard insets. | Screenshot sweep |
| MR14 | Cellular and battery settings are honoured exactly; no surprise downloads. | E2E with Wi-Fi only on and a cellular profile |

## Desktop and server additions (Lifer repo)

These ship in the Lifer desktop and server, after the sync foundation. Packages A-01 to A-13 below.

| Route or piece | Scope | Purpose |
|---|---|---|
| `POST /api/companion/v1/pair` | public (code or session) | Exchange a QR or typed server code, or a signed-in session, for a device key |
| `POST /api/companion/v1/pair/start`, `POST /api/companion/v1/pair/finish` | public (key exchange) | Typed pairing with a computer: CPace keyed by the 6-digit code, then a device key |
| `GET /api/companion/v1/devices`, `DELETE /api/companion/v1/devices/:id` | session | Settings > Connect phone list and revoke |
| `GET /api/companion/v1/snapshot` | `companion` | First full copy: marks, targets, sightings, trips, albums, covers, settings in F8 |
| Existing `GET /sync/changes`, `GET /sync/user-species` | `companion` added | Deltas after the snapshot |
| `GET /api/companion/v1/showcase` | `companion` | Ids and ETags of the showcase set |
| Existing image routes with `size=thumb|display` | `photos.read` | Media cache |
| `GET /api/companion/v1/regions/:id/bundle` | `companion` | Compact checklist bundle (A-08) |
| `GET /api/companion/v1/model/vectors?region=` | `companion` | Mobile reference vectors with checksum |
| Existing resumable upload routes | `photos.write` | New photos from the phone |
| `POST /api/companion/v1/push` | `companion` | Marks, targets, sightings, tags, favourites, iNaturalist send requests, with versions |
| Existing gallery search | `gallery.read` | Whole-archive photo search when the hub is reachable |

Device keys carry `companion`, `photos.read`, `photos.write`, `gallery.read` and `species.read`, and
nothing else. Keys are ordinary `api_keys` rows named after the device, so no migration for keys.

## Maintainer additions (2026-10-25), all 1.0

- **Standalone mode (no Lifer needed).** The app works on its own for people who only want to tick off
  species: pick regions, download their checklists straight from the public catalog release (the same
  files the desktop downloads, only when the person asks), mark seen and targets, all on the phone.
  Pairing with a desktop or server later merges the phone's marks into that library (newest edit wins,
  same rules as sync) and the app becomes a normal companion. No account, no tracking.
- **Photos from RAW-only species.** The phone never decodes RAW. The hub renders a display-size JPEG
  (about 2048 px long edge) from the RAW for the showcase and thumbnails, as it does today.
- **Full resolution on demand.** A photo's "View full size" asks the hub for a full-resolution JPEG
  render (of the RAW or original), streamed and cached briefly, never kept in the showcase. It works
  wherever the hub is reachable: a server through the person's own forwarding or reverse proxy (HTTPS)
  from anywhere, a desktop on the same Wi-Fi. Offline, the display-size copy is shown with a plain note.
- **Photos tab (replaces the Search tab).** Showing wildlife photos to people while out is a main reason
  to use the app, so the fifth tab is **Photos**: the whole library as a fast scrolling grid by date
  (from the thumbnail cache, newest first, with month headings and a scrubber), and search at the top
  of it. Typing "swans" finds every photo of a swan species at once, offline, from species names and
  synonyms on the phone; when the hub is reachable the same box also uses its full photo search
  (descriptions, places, tags). Tap a photo for full screen, swipe between photos, pinch to zoom, "View
  full size", and the system share sheet (with the sensitive-species and location rules). Species
  search stays in Life list. Tabs become: Home, Life list, Identify, Trips, Photos.
- **Offline context search (on by default).** After pairing, the phone downloads "Smart search offline" by
  itself (on Wi-Fi, honouring the cellular setting; size shown in Settings, which can remove it). It puts
  the desktop's own CLIP ViT-L/14 text encoder on the phone (only the text half: about 250 MB at fp16)
  plus each photo's existing image vector from the hub (768 numbers per photo, about 90 MB for 60,000
  photos at fp16, synced like other changes). The phone embeds the query and ranks locally, with the
  same query parsing as the desktop (packages/shared), so "swans in flight" works in airplane mode.
  Size shown before download; Settings can offload it (search falls back to the hub, then names).
  Runtime: onnxruntime-react-native (MIT).
- **Phone-only users (no Lifer hub), search and Identify (2026-10-26).**
  - Checklist-only use (no photos in the app): species-name search only; no model download.
  - With photos added in the app: the first added photo or first Identify downloads the CLIP ViT-L/14
    image AND text encoders (about 600 MB at fp16) from the public model host, on Wi-Fi, size shown,
    removable in Settings. The phone computes each added photo's vector itself (about 1 s each, in the
    background with a progress line for big batches) and searches locally with the shared query parsing.
  - Identify uses the same image encoder against the chosen regions' species reference vectors (from the
    public catalog), replacing the separate small species-ID model: one model, not two.
  - Pairing later uploads the phone's photos, merges marks, switches to the hub's vectors and offers to
    drop the image encoder.
- **Preconfigured, no manual setup (2026-10-26).** On pairing the phone mirrors the hub's installed
  region packs automatically and follows later changes; phone-only users pick regions in a first-run
  step that suggests their current region. Collection defaults to seen and photographed first, like the
  desktop. Uncollected species show the desktop's reference photos (synced from the hub; from the public
  catalog for phone-only users), never a placeholder when a photo exists.

### Built for the maintainer's iPhone testing (2026-10-26)

- **Albums.** Two causes: the membership feeds named a mirrored capture by the server's id (`remote_id`) while the
  capture feed names it by this install's id, so a desktop linked to a server sent members the phone could not match;
  and a smart album has rules, not member rows, so it arrived empty. A device key now gets membership by the
  capture's own id (`phoneAlbumCaptures`, `phoneAlbumExclusions` in `sync/library.ts`), and `GET
  /api/companion/v1/albums/smart` returns each smart album's current photos with its exclusions already applied,
  which the phone stores as the album's members at every sync (so it needs no exclusions feed or rules engine).
- **Regions.** Every sync mirrors `preferences.regions` (fetch, refresh when the hub's pack signature changes,
  remove when the hub removed it); `src/sync/regionMirror.ts`. A hub region with no matching region row (`regionId`
  null) is not mirrored. Phone-only users get a first-run "Which regions?" step (suggest my region asks for location
  only on its button, then the country is looked up with the system geocoder and matched to the catalog's names).
- **Collection** opens photographed first, then seen, by name, grouped (the desktop pins Photographed first).
- **Reference photos.** `GET /api/companion/v1/reference/:name[/thumb|/display]` (name = scientific name with
  characters outside letters, digits and "-" as "_"); the phone caches them as thumbnails under `ref~name` and shows
  them on cards, rows and the species page with the desktop's credit line.
  **TODO (phone-only users):** no reference photos until a public source exists: the catalog release ships names only.
  Needs the catalog's reference photo URLs and credits added to the public pack index, then fetched per visible card.

## Build status and running on a phone (2026-10-25)

Built so far in `apps/mobile`: P-03 (Expo SDK 58 app, five empty tabs, i18next ICU, checks wired into CI;
the CI native debug builds are not added yet), a first slice of P-04 (theme plus Sunlight with a contrast
test, Button, ListRow, EmptyState, Screen, Banner, Spinner, TextField, `check:ui` lint, section 16 in
`ux-rules.md`) and the pairing flow: code to pairing with pinned TLS and a secure-store device key
(`src/connection/`), the Pair screen (scan, or type the 6 digits; a server adds its address), the connected screen with the
hub kind and address and Disconnect, and plain messages for every failure. Screens are render tested
with `@testing-library/react-native` under jest (`jest-expo`); pure logic stays under vitest.
Typed pairing finds the computer with `modules/local-pairing` (our own Expo module: NWBrowser on
iOS under the existing `NSBonjourServices` entry and local network prompt, NsdManager on Android,
which needs no extra permission), which also supplies secure random bytes for the key exchange,
since Hermes has no `crypto.getRandomValues`. Not built yet: server sign-in, P-05 onwards.

QR scanning: iPhone uses expo-camera (Apple's scanner). Android uses `modules/qr-scanner`, our own
small view over ZXing core 3.5.4 (Apache-2.0) and CameraX 1.6.0 (Apache-2.0), offline. expo-camera is
configured with `barcodeScannerEnabled: false` plus `plugins/withNoMlKit.js`, so no `com.google.mlkit`
or Play Services scanner code ships. After a prebuild, `npm run check:android -w mobile` fails if any is
in the Android release classpath. Typed entry: only the 6 digits for a computer, found on the Wi-Fi;
a server adds its address. The computer's certificate is never trusted on first sight: the key
exchange proves it before it is pinned.

Native modules (`pinned-fetch`, `qr-scanner`, `local-pairing`): the first two compiled in the iOS
Simulator build before typed pairing; the `local-pairing` module and the capture mode added to
`pinned-fetch` have not been compiled yet. The Kotlin modules have not been compiled (no JDK or
Android SDK on the build machine).

Run on a plugged-in phone with no paid account (from the repo root, after `npx -y npm@11 install`):

- **iPhone** (free Apple ID in Xcode, Settings > Privacy > Developer Mode on): `npm run ios -w mobile`.
  The first run generates `apps/mobile/ios`; open its workspace once in Xcode, pick your Apple ID under
  Signing, then rerun. Free-account builds expire after 7 days.
- **Android** (Developer options and USB debugging on): `npm run android -w mobile`.
- Afterwards the dev server alone is `npm start -w mobile`.
- Checks: `npm test -w mobile`, `npm run check:mobile`, `npm run typecheck -w mobile`, `npm run check:android -w mobile`.

## Work packages

Standing rules for every package (paste the briefing below into each worker's prompt):

```
Standing rules for this package:
- Never commit, branch or stash. The maintainer owns all commits.
- No em dashes anywhere: UI copy, code comments, docs. Short why-comments only.
- Any desktop or server change that touches the database needs the maintainer's explicit approval
  per migration file before you write it. Propose, then stop.
- Never write to the Docker `lifer` database. Tests use `lifer_test`. The desktop app runs its own
  embedded Postgres; don't verify app state through docker-compose.
- Design for extremes: 0, 1 and 200,000 photos; 5,000 species; 200-character names; 50 trips; a
  full disk; no network; a hub that vanishes mid-sync.
- Never block the user: long work runs in the background with progress where the item lives.
- Zero config: nothing to type that Lifer can find, pick or default.
- UI work: house components and design tokens only, `ux-rules.md` plus the mobile rules (MR1 to
  MR14), and a screenshot-based HIG review on iOS and Android (light, dark, Sunlight, smallest and
  largest phone, largest text size, extreme data) before reporting done. List the rules checked.
- Accessibility: VoiceOver, TalkBack and Dynamic Type work on every screen you touch.
- Privacy: no analytics, tracking, crash SDKs or third-party network calls. Location never leaves
  in anything shared, and never for sensitive species.
- Lockfile changes only with `npx -y npm@11`. New dependencies need the maintainer's approval and
  must be MIT, BSD, Apache, ISC or similar.
- Targeted edits only: other sessions may own uncommitted changes. Don't rebuild the desktop dev
  app while others are editing apps/web or apps/api.
- Read only your package and the plan sections it links to. Report what you changed, what you
  checked, and what you did not check.
```

### Lifer repo packages

### A-01 Device keys and the companion scope

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria before hand-back.
- **Goal:** phones get their own revocable keys with exactly the scopes they need.
- **Scope in:** `companion` in `API_KEY_SCOPES` (not offered on the API keys page), a `DEVICE_KEY_SCOPES`
  constant next to `DESKTOP_LINK_SCOPES`, key creation helper, device list and revoke routes. **Out:**
  pairing flows (A-02), UI (A-06).
- **Files:** `apps/api/src/auth/apiKeyRoutes.ts`, `apps/api/src/companion/devices.ts` (new),
  `apps/api/src/companion/routes.ts` (new), `apps/api/src/apiRoutes.ts`.
- **Depends on:** sync foundation F1.
- **Contracts:** "Desktop and server additions" table; keys are `api_keys` rows, no migration.
- **Steps:** add the scope; reuse key hashing from `apiKeys.ts`; device name and platform go in the
  key's name; list filters keys carrying `companion`.
- **Tests:** integration on `lifer_test`: create, list, revoke, a revoked key gets 401, other users'
  devices refused, a device key gets 401 on routes outside its scopes.
- **Acceptance:** a device key reads `GET /sync/user-species` and nothing it isn't scoped for.
- **UX checks:** none (no UI).
- **Risks:** scope creep onto existing routes; keep the list explicit.
- **Parallel with:** A-03, A-05, A-08, A-10, A-12, A-13.

### A-02 Pairing codes and the QR payload

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** pair a phone by QR on desktop and server, or by sign-in on a server.
- **Scope in:** one-time 5-minute 6-digit codes from a CSPRNG held in memory, unique among live codes,
  QR payload v1, `POST /api/companion/v1/pair` with a code or a session, the typed key exchange
  (`pair/start`, `pair/finish`), rate limit 5 per minute per address, single use, and a shared budget
  of 5 guesses per live period that burns every live code when spent. **Out:** the TLS listener (A-03).
- **Files:** `apps/api/src/companion/pairing.ts` (new), `apps/api/src/companion/routes.ts`,
  `apps/api/src/auth/publicRoutes.ts`, `packages/shared/src/companionPairing.ts` (new, payload type),
  `packages/shared/src/companionPake.ts` (new, CPace on `@noble/curves` and `@noble/hashes`).
- **Depends on:** A-01.
- **Contracts:** "Connection and pairing"; payload `{ v, kind, instanceId, addresses, certSha256?, code }`.
- **Steps:** mint and expire codes; the desktop asks the shell for addresses and the certificate
  fingerprint through a command; the server's payload omits `certSha256`.
- **Tests:** expiry, reuse, wrong code, rate limit, guess budget, payload round trip, session pairing on
  a server, the CPace test vectors from the draft, key exchange round trip and a man in the middle.
- **Acceptance:** a test client pairs once with a fresh code and never with a used or expired one.
- **UX checks:** none.
- **Risks:** QR codes photographed and reused; single use plus 5-minute expiry covers it. Guessing 6
  digits; the shared guess budget covers it, at the cost of letting a guesser burn live codes.
- **Parallel with:** A-03, A-05, A-08.

### A-03 Desktop LAN listener, certificate and discovery

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** a phone on the same network reaches the desktop safely.
- **Scope in:** self-signed certificate generated once, TLS 1.3 listener in the shell (rustls, already
  a dependency through reqwest), a route allowlist that forwards only companion routes to the loopback
  API without forwarded headers, mDNS advertisement, start only while a phone is paired, stop on
  unpair. **Out:** the gate rule (A-04).
- **Files:** `apps/desktop/src-tauri/src/companion_listener.rs` (new), `src/lib.rs`, `src/store.rs`
  (certificate path, paired flag), `permissions/app-commands.toml`, `capabilities/default.json`,
  `Cargo.toml` (an mDNS crate and a certificate generator, approval needed).
- **Depends on:** A-01.
- **Contracts:** "How it fits together"; allowlist equals the routes in the additions table.
- **Steps:** generate the certificate and key with user-only permissions; bind to the LAN interfaces
  on a fixed preferred port with fallback; forward the phone's device key only, never the local credential, so every
  request is checked against the device key by the A-04 gate rule (pair-codes and devices stay off the
  allowlist); advertise `_lifer-companion._tcp` with the instance id only.
- **Tests:** Rust tests for the allowlist (refused paths, path traversal, oversized bodies), the
  certificate fingerprint, start and stop with pairing state; a manual test from a second machine.
- **Acceptance:** from another computer on the network, only the allowlisted routes answer, and only
  with a device key; nothing listens when no phone is paired.
- **UX checks:** the OS firewall prompt on macOS and Windows appears once, with Lifer's name.
- **Risks:** corporate and guest Wi-Fi block mDNS and client-to-client traffic; the phone falls back
  to stored addresses and says plainly it can't see the desktop on this network.
- **Parallel with:** A-02, A-05, A-08, A-10.

### A-04 Desktop gate admits device keys

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** device keys work on companion routes in desktop mode, nothing else changes.
- **Scope in:** gate rule like the plugin plan's L-07: an `x-api-key` passes only when the matched
  route requires a device scope; `requireScope` then checks it. **Out:** plugin scopes (shared rule if
  both land; whichever lands second extends the other's list).
- **Files:** `apps/api/src/auth/desktopGate.ts`, `apps/api/src/auth/session.ts`,
  `apps/api/src/auth/desktopMode.test.ts`.
- **Depends on:** A-01.
- **Contracts:** "How it fits together".
- **Steps:** read the route's scope from the static route metadata; never from the request.
- **Tests:** device key on a companion route passes, on any other route 401; launch credential paths
  unchanged; Host and forwarded-header guards unchanged.
- **Acceptance:** every existing desktop-mode test passes unchanged.
- **UX checks:** none.
- **Risks:** dynamically scoped routes; keep the rule to static metadata.
- **Parallel with:** A-02, A-03, A-05.

### A-05 Menu bar and tray helper

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** sync keeps working while the desktop window is closed.
- **Scope in:** closing the window keeps the shell, API and embedded Postgres running when "Keep
  syncing with your phone when Lifer is closed" is on (default on once a phone is paired); a menu bar
  icon on macOS and a tray icon on Windows and Linux with "Phone synced 2 min ago", Open Lifer, Pause
  syncing, Quit; optional Start at login. **Out:** any other background job.
- **Files:** `apps/desktop/src-tauri/src/tray.rs` (new), `src/lib.rs` (close handling next to the API
  shutdown), `src/store.rs`, `src/menu.rs`, `tauri.conf.json`.
- **Depends on:** A-03.
- **Contracts:** quitting from the tray stops everything cleanly (X6).
- **Steps:** use Tauri's tray API; reuse the API restart logic the shell already has; a Linux desktop
  without a tray area falls back to keeping the window minimised.
- **Tests:** manual on all three systems: close window, phone syncs, quit from tray leaves no process;
  Rust tests for the setting.
- **Acceptance:** with the window closed for an hour, a phone change reaches the desktop library.
- **UX checks:** X1, X4, X6, W3; HIG screenshots of the menu in light and dark on each system.
- **Risks:** users who expect close to quit; the first close after pairing shows one notice saying
  Lifer keeps syncing in the menu bar, with a link to turn it off.
- **Parallel with:** A-06, A-07, A-08.

### A-06 Settings > Connect phone (desktop and server)

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** pair, see and revoke phones.
- **Scope in:** a Connect phone settings group: Connect a phone (QR in the shared Modal with the 6-digit
  code under it, a countdown and a fresh code button), each phone with last synced and Revoke, the keep-syncing switch on desktop,
  and the "Your phone connects to your server" state on a linked desktop. **Out:** routes.
- **Files:** `apps/web/src/pages/settings/PhonesSettings.tsx` (new), `pages/settings/groups.ts`,
  `apps/web/src/locales/en.json`, a QR renderer (a small MIT library, approval needed).
- **Depends on:** A-01, A-02, A-05.
- **Contracts:** grouped panel with divided rows, label left, control right (L3).
- **Steps:** Revoke confirms (destructive); everything else applies at once.
- **Tests:** web unit tests for states; e2e: pair stub client, list shows it, revoke removes it.
- **Acceptance:** a phone revoked here gets 401 on its next request.
- **UX checks:** C1, C2, L3, L5, W3, W5, W8, D2, M3, S6, A1; HIG review light and dark; extremes: 20
  phones, a 60-character device name.
- **Risks:** none notable.
- **Parallel with:** A-07, A-08, A-09.

### A-07 Companion read routes

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** everything the phone reads, in as few calls as possible.
- **Scope in:** `GET /api/companion/v1/snapshot` (paged, gzip), `companion` accepted on the existing
  change feeds, `GET /api/companion/v1/showcase`, `size=display` on the image route if F7 lacks it.
  **Out:** bundles (A-08), writes (A-09).
- **Files:** `apps/api/src/companion/snapshot.ts` (new), `apps/api/src/companion/routes.ts`,
  `apps/api/src/companion/responses.ts` (new), `apps/api/src/sync/routes.ts` (scope list),
  `apps/api/src/integrations/openapi.ts`.
- **Depends on:** A-01, sync foundation F2, F3, F7, F8.
- **Contracts:** additions table; the snapshot returns a cursor so deltas start exactly after it.
- **Steps:** reuse the feed's cursor rule; names follow the user's naming preference; sensitive flags
  ride along with each species.
- **Tests:** integration on `lifer_test` with the large fixture: snapshot plus deltas equals the
  library; a write during the snapshot is not lost; other users' data never appears.
- **Acceptance:** a 200,000-photo library snapshots in under 30 s on the desktop and under 20 MB
  compressed (photos as ids, not files).
- **UX checks:** none.
- **Risks:** response size; page at 2,000 rows.
- **Parallel with:** A-08, A-09, A-10.

### A-08 Region checklist bundle

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** one compact download per region holding what the phone needs offline.
- **Scope in:** `GET /api/companion/v1/regions/:id/bundle`: species ids, scientific and common names,
  synonyms and codes, taxa group, rarity, weekly seasonality, sensitive flag, the vernacular region
  tree (country, group, province), simplified subdivision outlines for "where am I", and the catalog
  version. A SQLite file the phone attaches. **Out:** reference vectors (A-11), photos.
- **Files:** `apps/api/src/companion/regionBundle.ts` (new), `apps/api/src/companion/routes.ts`,
  `packages/shared/src/regionBundleFormat.ts` (new, schema and version).
- **Depends on:** A-01.
- **Contracts:** bundle format v1, documented in the shared file; cached by catalog version with ETag.
- **Steps:** build from the installed packs only (A2: only what exists); simplify outlines to a
  tolerance that keeps province lookups correct; build once per catalog version and cache.
- **Tests:** a bundle round trip; outline lookups for known points near borders; size per country.
- **Acceptance:** Canada's bundle is under 5 MB and answers "which province is this point in" for a
  set of border test points.
- **UX checks:** none.
- **Risks:** large countries with many subdivisions; measure the United States and Russia.
- **Parallel with:** A-07, A-09, A-10.

### A-09 Companion write routes

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the phone's queued changes land safely, once.
- **Scope in:** `POST /api/companion/v1/push` for marks, targets, sightings, tags, favourites and
  iNaturalist send requests, each with the version last seen; new photos through the resumable
  upload routes with fingerprint dedup and the phone's species choice. **Out:** iNaturalist sending
  itself (the existing iNaturalist routes do it).
- **Files:** `apps/api/src/companion/push.ts` (new), `apps/api/src/companion/routes.ts`, reuse
  `apps/api/src/sync/push.ts` rules and `apps/api/src/uploads/`.
- **Depends on:** A-01, F4, F5; the sightings storage decision (open question 3) and its approved
  migration.
- **Contracts:** each item gets `applied`, `conflict` (with the hub's copy) or `rejected` (with a
  plain reason); the same request twice changes nothing.
- **Steps:** apply in one transaction per batch of 100; photos from the phone keep their EXIF time
  and location in the library (privacy applies when sharing, not when archiving).
- **Tests:** integration on `lifer_test`: replay, conflict, deleted-on-hub, unknown species,
  sensitive species, a photo uploaded twice.
- **Acceptance:** a batch replayed after a dropped reply produces exactly one of everything.
- **UX checks:** none.
- **Risks:** sightings need a migration; nothing about sightings is written before approval.
- **Parallel with:** A-07, A-08, A-10.

### A-10 Mobile reference vectors in the data pipeline

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** catalog reference vectors for the mobile model.
- **Scope in:** one parameterised, resumable command that computes mobile-model vectors for catalog
  gallery photos, skips what's already computed for the current version, and writes them with
  `MOBILE_ID_MODEL_VERSION`. **Out:** publishing (maintainer-approved catalog republish).
- **Files:** `packages/data-pipeline/python/` (a new export and embed step beside
  `export_id_model.py`), `packages/shared/src/idModel.ts` (the new version constant).
- **Depends on:** P-14 (model choice).
- **Contracts:** per-gallery-photo vectors, int8, preprocessing matching the phone's (user crop
  modelled as a padded centre crop of the catalog's subject box).
- **Steps:** export the encoder to ONNX; run on the pipeline machine; record checksums.
- **Tests:** a rerun computes nothing; a vector computed on the pipeline equals the phone runtime's
  for the same input within tolerance (shared fixture with P-15).
- **Acceptance:** one command produces the full vector set; an interrupted run resumes.
- **UX checks:** none.
- **Risks:** preprocessing drift between Python and the phone; the shared fixture catches it.
- **Parallel with:** A-07, A-08, A-09.

### A-11 Hub serves mobile vectors

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the hub fetches the mobile vectors for its installed regions and serves them to phones.
- **Scope in:** download alongside the region packs once a phone is paired, `GET
  /api/companion/v1/model/vectors?region=` with checksum and ETag. **Out:** computing vectors.
- **Files:** `apps/api/src/companion/vectors.ts` (new), reuse the pack download code in
  `apps/api/src/offlinePacks/`.
- **Depends on:** A-10 published, A-01.
- **Contracts:** additions table.
- **Steps:** follow the existing pack download path; nothing downloads until a phone is paired.
- **Tests:** integration: served bytes match the checksum; a region not installed returns 404.
- **Acceptance:** a paired phone gets vectors for every installed region.
- **UX checks:** the download shows in the desktop's progress tray like any pack (C6, F2).
- **Risks:** none notable.
- **Parallel with:** A-06, A-12.

### A-12 Shared pure logic for the phone

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the phone uses the same matching and naming rules as desktop (Q4).
- **Scope in:** move pure functions the phone needs (keyword and synonym species matching, search
  tokenising, taxonomic order, naming preference, sensitive-species rules) into `packages/shared`,
  re-exported from their old paths. **Out:** behaviour changes.
- **Files:** `apps/api/src/species/matchByKeywords.ts`, `apps/api/src/gallery/searchTaxonSynonyms.ts`,
  `packages/core/src/species/sensitiveSpecies.ts`, `packages/shared/src/` (new modules).
- **Depends on:** none.
- **Contracts:** no Node imports in `packages/shared`.
- **Steps:** move, re-export, run every existing test unchanged.
- **Tests:** existing suites; a lint that `packages/shared` imports no `node:` module.
- **Acceptance:** all API and web tests pass with no edits beyond imports.
- **UX checks:** none.
- **Risks:** other sessions editing these files; coordinate first.
- **Parallel with:** every A package.

### A-13 Design tokens for the phone

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** one source of colours, radii, spacing and type for web and phone.
- **Scope in:** a script that reads `apps/web/src/theme.css` and writes `packages/shared/src/designTokens.ts`
  (light and dark), plus a check that fails when they drift. **Out:** changing any token.
- **Files:** `scripts/export-design-tokens.mjs` (new), `packages/shared/src/designTokens.ts` (generated),
  root `package.json` (check script).
- **Depends on:** none.
- **Contracts:** the Sunlight appearance is phone-only and lives in `apps/mobile`.
- **Steps:** parse custom properties; emit numbers for spacing and radii.
- **Tests:** the drift check; a unit test over a sample of theme.css.
- **Acceptance:** changing a token in theme.css and not regenerating fails the check.
- **UX checks:** none.
- **Risks:** none.
- **Parallel with:** every A package.

### Phone app packages

### P-00 Stack prototype: Expo against Tauri mobile (DECIDED 2026-10-25: Expo, prototype skipped)

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** evidence for the stack decision.
- **Scope in:** in a scratch folder outside the repo, the same two screens in both stacks: a life list
  of 5,000 rows with thumbnails from SQLite, and a photo picker into an ONNX inference call. Measure
  cold start, scroll frame drops, memory, inference time, app size, background task support, photo
  library access, and how native each feels. **Out:** anything kept.
- **Files:** none in the repo; a short results table added to this plan.
- **Depends on:** none.
- **Contracts:** same devices, same data, release builds.
- **Steps:** build, measure on one iPhone and one mid-range Android, record numbers and screenshots.
- **Tests:** the measurements themselves.
- **Acceptance:** the maintainer decides with the numbers in front of them.
- **UX checks:** screenshots of both, side by side, for the maintainer.
- **Risks:** Tauri mobile's background and photo library plugins may be immature; record it plainly.
- **Parallel with:** P-01, P-02, P-14.

### P-01 Licence exception, contributor sign-off and licence audit

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the iOS app can be distributed lawfully.
- **Scope in:** a draft AGPL section 7 additional permission allowing distribution through app stores
  whose terms add restrictions, added while the maintainer is the only author; contributor sign-off
  (DCO) or a CLA stating contributions are under the licence with that permission; a licence audit
  script over the mobile dependency tree that fails on GPL, AGPL, LGPL in static builds and
  proprietary SDKs. **Out:** the lawyer's review (maintainer).
- **Files:** drafts for `LICENSE-APP-STORE-EXCEPTION.md` and `CONTRIBUTING.md` changes, presented to
  the maintainer before writing; `apps/mobile/scripts/check-licences.mjs` (new).
- **Depends on:** none.
- **Contracts:** "Licence notes" in the model section.
- **Steps:** draft wording from known precedents; list every author in git history to confirm sole
  authorship; flag yolov8n and any other AGPL asset.
- **Tests:** the audit script against the current tree.
- **Acceptance:** the maintainer has wording for the lawyer and the audit passes.
- **UX checks:** none.
- **Risks:** any outside contribution before the exception lands needs that author's agreement.
- **Parallel with:** P-00, P-02, P-14.

### P-02 Accounts, names and trademark checks

- **Model:** Haiku 5.5 prepares it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** everything the maintainer must do themselves, as a checklist with links.
- **Scope in:** Apple Developer Program ($99 a year, also signs and notarizes the desktop app),
  Google Play Console ($25 once, identity verification), individual or organisation (D-U-N-S),
  seller name equals the account's legal name, bundle id `app.lifer.mobile`, the store name "Lifer
  Wildlife Archive", searches of the UK IPO, USPTO and EUIPO registers for "Lifer" in classes 9 and
  42, and a note on the two existing "Lifer" apps. **Out:** filing anything.
- **Files:** a checklist returned to the maintainer (not committed).
- **Depends on:** none.
- **Contracts:** none.
- **Steps:** gather the official links and the current requirements; mark what needs the maintainer.
- **Tests:** none.
- **Acceptance:** the maintainer can complete every step from the checklist.
- **UX checks:** none.
- **Risks:** a conflicting registration; store names are checked before M5.
- **Parallel with:** P-00, P-01.

### P-03 App scaffold, CI and checks

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** an empty app that builds, lints and tests on both platforms.
- **Scope in:** `apps/mobile` Expo app in the workspace, TypeScript strict, React Navigation with the
  five tabs as empty screens, i18next with ICU and `apps/mobile/src/locales/en.json`, imports from
  `packages/shared`, `check:em-dashes`, `check:i18n` and the licence audit wired to `apps/mobile`, CI
  jobs building a debug iOS app on a macOS runner and an Android app on Linux, using local builds
  (no cloud build service). **Out:** any feature.
- **Files:** `apps/mobile/` (new), root `package.json` workspaces, `.github/workflows/ci.yml`.
- **Depends on:** P-00 decision.
- **Contracts:** no network call at launch.
- **Steps:** create, prebuild, add scripts, add CI.
- **Tests:** a smoke test that the tab bar renders; CI green.
- **Acceptance:** both apps launch on a simulator and an emulator from CI artifacts.
- **UX checks:** none.
- **Risks:** monorepo hoisting with Metro; follow Expo's monorepo guide.
- **Parallel with:** P-04, P-05.

### P-04 Mobile design system and mobile rules

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the house components every phone screen is built from.
- **Scope in:** tokens from A-13 plus a Sunlight appearance; a type scale on Dynamic Type and font
  scale; Button, IconButton, ListRow, SectionHeader, BottomSheet, SearchField, SegmentedControl,
  Switch, Chip, EmptyState, Toast with Undo, ProgressBar, PhotoTile, SpeciesRow, SyncLine, OfflineNote;
  platform-specific variants where HIG and Material differ; a lint banning raw colours and raw
  touchables outside the components; section 16 (mobile rules) in `ux-rules.md`. **Out:** screens.
- **Files:** `apps/mobile/src/ui/` (new), `apps/mobile/src/theme/` (new), `apps/mobile/eslint` rules,
  `docs/plans/ux-rules.md` (append section 16).
- **Depends on:** P-03, A-13.
- **Contracts:** "Mobile rules"; every component has an accessible name, role and state.
- **Steps:** build each with a story screen in a dev-only gallery; check contrast for every token
  pair including Sunlight.
- **Tests:** unit tests for each component; contrast test; the gallery screenshotted.
- **Acceptance:** the gallery passes MR1, MR6, MR7 and MR13 in screenshots on both platforms.
- **UX checks:** C1, C2, C5, T1, T2, T6, Y1 to Y3, MR1 to MR13; HIG and Material review.
- **Risks:** lookalike components appearing later; the lint blocks them.
- **Parallel with:** P-05, P-06.

### P-05 Offline store

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the phone's own database, fast at every size.
- **Scope in:** SQLite schema (species, marks, targets, sightings, captures metadata, albums,
  trips, region bundles attached, outbox, cursors, file index, settings), versioned on-device
  migrations, FTS5 index for search, a repository layer the screens use, WAL mode, a storage summary.
  **Out:** network.
- **Files:** `apps/mobile/src/store/` (new).
- **Depends on:** P-03, A-08 format.
- **Contracts:** screens never wait on the network; every read under 50 ms on the large fixture.
- **Steps:** design the schema from the snapshot and feed shapes; indexes for every list sort.
- **Tests:** unit tests on a 200,000-photo and 5,000-species fixture; migration from each earlier
  version; a crash mid-write leaves a consistent database.
- **Acceptance:** life list sorts and filters on the fixture in under 50 ms on a mid-range Android.
- **UX checks:** none.
- **Risks:** FTS tokenising must match A-12's rules; share the tokenizer.
- **Parallel with:** P-04, P-06.

### P-06 Pairing, discovery and the secure channel

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the phone connects to its hub safely with one scan, or by typing only 6 digits.
- **Scope in:** QR scanning, payload v1 validation, TLS with the pinned certificate fingerprint
  (a small native module on each platform: URLSession delegate on iOS, a custom trust manager on
  Android), typed pairing (6 digits, Bonjour/NSD discovery in `modules/local-pairing`, the CPace key
  exchange that proves the certificate before it is pinned), the key in Keychain or Keystore, mDNS
  discovery with the iOS local network permission and Bonjour service entry, fallback addresses, server sign-in, re-pair and unpair, hub identity by
  instance id. **Out:** sync (P-07).
- **Files:** `apps/mobile/src/connection/` (new), `apps/mobile/modules/pinned-fetch/` (new native module),
  `apps/mobile/modules/local-pairing/` (new native module).
- **Depends on:** P-03, A-02, A-03.
- **Contracts:** "Connection and pairing"; a wrong fingerprint fails closed with a plain message.
- **Steps:** pin to the exact certificate hash, never trust on first use; no plain HTTP except a
  server on a private address.
- **Tests:** unit tests for payload parsing; integration against a test listener with right, wrong
  and changed certificates; manual on both platforms with the permission denied.
- **Acceptance:** pairing takes one scan or 6 typed digits; a man-in-the-middle with another
  certificate is refused, and never learns the code.
- **UX checks:** MR10, S1, N5 for the permission and failure screens (built in P-10).
- **Risks:** Android private DNS and Wi-Fi isolation; iOS local network permission wording.
- **Parallel with:** P-04, P-05, P-14.

### P-07 Sync engine and outbox

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** automatic two-way sync that survives anything.
- **Scope in:** snapshot then deltas, tombstones, an outbox of typed changes with versions, push in
  batches with idempotency, conflict handling (take the hub's copy, keep a local edit not yet pushed),
  backoff with jitter, hub switching by instance id, upload settings honoured, a status model for the
  sync line. **Out:** background scheduling (P-09), media (P-08).
- **Files:** `apps/mobile/src/sync/` (new).
- **Depends on:** P-05, P-06, A-07, A-09.
- **Contracts:** "Sync behaviour"; every step resumable from its last committed row.
- **Steps:** a single sync loop with a lock; each phase commits its cursor in the same transaction
  as the rows.
- **Tests:** against a fake hub and against the real API in desktop mode on `lifer_test`: dropped
  replies, duplicate replies, hub restart mid-page, a deletion of something edited on the phone,
  clock skew of a day, two phones editing the same mark.
- **Acceptance:** after 1,000 random fault injections the phone and hub agree exactly.
- **UX checks:** none here (the sync line is in P-11).
- **Risks:** foundation items F3 and F4 slipping; the engine treats feed types as pluggable so they
  can land later.
- **Parallel with:** P-08, P-10, P-12.

### P-08 Media cache: thumbnails and showcase

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** photos on screen at once, within the user's storage limits.
- **Scope in:** download queue in the documented order, showcase pinned at display size and excluded
  from cloud backup, thumbnails in caches under the cap with least-recently-viewed eviction, ETag
  revalidation, low-disk pause, memory-safe image decoding for fast scrolling. **Out:** uploads.
- **Files:** `apps/mobile/src/media/` (new).
- **Depends on:** P-05, P-07.
- **Contracts:** "Offline content and storage"; a missing image shows the species' fallback (S4).
- **Steps:** a priority queue with 4 to 6 parallel downloads; never refetch a valid file.
- **Tests:** cap honoured on the large fixture; eviction order; showcase survives a cache purge;
  airplane mode mid-download resumes.
- **Acceptance:** with 60,000 photos and a 1 GB cap, scrolling the life list never shows a blank tile
  for a photographed species.
- **UX checks:** P2, P4, S4, MR14.
- **Risks:** iOS purging caches under pressure; thumbnails refill, showcase never purged.
- **Parallel with:** P-10, P-11, P-12.

### P-09 Background sync and uploads

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** sync and uploads continue without the app open, inside each OS's limits.
- **Scope in:** iOS: background app refresh tasks for short sync steps, processing tasks (optionally
  only while charging) for longer drains, background URL sessions for photo uploads that continue
  after the app is suspended; Android: WorkManager with network, Wi-Fi and charging constraints,
  foreground service only for an upload the user just started. Wi-Fi only and only while charging
  honoured everywhere. **Out:** watched album detection (P-17).
- **Files:** `apps/mobile/src/background/` (new), native config in `app.json` plugins.
- **Depends on:** P-07, P-08.
- **Contracts:** each background run does a bounded slice and checkpoints; uploads resume by byte.
- **Steps:** register tasks; design for iOS never running them (foreground sync is the guarantee).
- **Tests:** real devices: kill the app mid-upload, reboot, low power mode, Android Doze and
  manufacturer battery savers (Samsung, Xiaomi), airplane mode toggles.
- **Acceptance:** a 50-photo upload started on Wi-Fi finishes with the app in the background on both
  platforms; nothing uploads on cellular while Wi-Fi only is on.
- **UX checks:** MR14, F2.
- **Risks:** iOS gives no timing guarantee; the sync line says when the last sync was, never promises.
- **Parallel with:** P-15, P-16.

### P-10 Onboarding and connection screens

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** from install to a filled life list with one scan.
- **Scope in:** a one-screen welcome (what Lifer is in one sentence), "Connect to your Lifer" with
  two choices (scan the code on your computer, or sign in to your server), the scanner, plain failure
  states (can't see your computer on this network, code expired), choose what to keep offline (regions
  picked from the hub's installed ones, storage cap), the sample library option (P-27). **Out:** the
  tabs.
- **Files:** `apps/mobile/src/screens/onboarding/` (new), `apps/mobile/src/locales/en.json`.
- **Depends on:** P-04, P-06.
- **Contracts:** every step has Back (N5); permissions only when the step needs them (MR10).
- **Steps:** prefill the storage cap from free space; skip region choice when the hub has one region.
- **Tests:** e2e (Maestro) for both paths, denied camera permission, expired code.
- **Acceptance:** a new user pairs and sees their life list in under a minute on a 5,000-species
  library.
- **UX checks:** N5, W3, W5, W8, D1, D3, S1, S6, MR1 to MR13; HIG and Material review.
- **Risks:** users who don't know where the desktop's Connect phone page is; the screen shows a picture of it.
- **Parallel with:** P-11, P-12.

### P-11 Home tab

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** a "today" view: what's near, what's new, how the trip is going.
- **Scope in:** targets near here (top few, from P-20's logic), recent photos, the active trip's
  progress, the sync line, the settings entry. **Out:** the targets logic itself (P-20).
- **Files:** `apps/mobile/src/screens/home/` (new).
- **Depends on:** P-04, P-05, P-07.
- **Contracts:** opens instantly from the store (MR5); empty states give the one next step.
- **Steps:** each section hides when it has nothing (A1).
- **Tests:** e2e with empty, minimal and extreme fixtures; no location permission.
- **Acceptance:** with location denied, Home still works and offers to pick a place.
- **UX checks:** A1, S6, L5, MR2, MR4, MR5, T5; HIG and Material review.
- **Risks:** too much on one screen; keep three sections at most.
- **Parallel with:** P-12, P-13.

### P-12 Life list tab

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the life list illustrated with the user's own photos.
- **Scope in:** photographed, seen and "still need a photo" views, sort by taxonomic order, name or
  date, group by taxa group, filter by region, the user's naming preference, a virtualised list with
  thumbnails. **Out:** species page (P-13).
- **Files:** `apps/mobile/src/screens/lifeList/` (new).
- **Depends on:** P-04, P-05, P-08.
- **Contracts:** counts agree with rows (U1); names never clip (S8).
- **Steps:** view choices persist (N3); back keeps scroll (MR8).
- **Tests:** e2e on the extreme fixture: fast scroll, sort change under 100 ms, long names at the
  largest text size.
- **Acceptance:** 5,000 species scroll at 60 fps on a mid-range Android.
- **UX checks:** C3, N1, N3, P3, S7, S8, U1, U4, MR5, MR7, MR8; HIG and Material review.
- **Risks:** none notable.
- **Parallel with:** P-13, P-19.

### P-13 Species page and photo viewer

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** one species: your photos, your record, fast full-screen viewing.
- **Scope in:** species header (names, rarity in the region, seen and photographed dates), your
  photos grid, full-screen viewer with swipe, pinch zoom and the showcase copy used first, mark seen,
  target toggle, favourite, tags edit, share (P-22), "compare with this" from Identify. **Out:** rating
  workflows.
- **Files:** `apps/mobile/src/screens/species/` (new), `apps/mobile/src/screens/viewer/` (new).
- **Depends on:** P-04, P-05, P-08.
- **Contracts:** viewer never shows a black frame (P2); frame fixed size (L9).
- **Steps:** the viewer loads showcase, then display, then thumbnail as placeholder.
- **Tests:** e2e: open, swipe 50 photos, airplane mode, a missing file.
- **Acceptance:** a showcase photo opens full screen in under 100 ms in airplane mode.
- **UX checks:** P1, P2, P4, L9, T3, S4, S5, F3, MR8, MR12; HIG and Material review.
- **Risks:** memory with large images; decode at screen size.
- **Parallel with:** P-12, P-19, P-21.

### P-14 Mobile ID model choice and evaluation

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** pick the on-device model with numbers.
- **Scope in:** export the candidates to ONNX int8, an evaluation set of held-out photos from the
  maintainer's library and catalog photos across taxa groups (including back-of-camera and
  digiscoped shots), top-1 and top-5 within the regional checklist against desktop BioCLIP 2, with
  and without a user crop; speed and memory on real devices. **Out:** shipping code.
- **Files:** `packages/data-pipeline/python/` evaluation script (new); results added to this plan.
- **Depends on:** none (P-00 not needed: ONNX either way).
- **Contracts:** "On-device species ID model".
- **Steps:** run the evaluation; recommend one model; state the accuracy gap honestly.
- **Tests:** the evaluation itself, reproducible from one command.
- **Acceptance:** the maintainer approves a model with known accuracy, size and speed.
- **UX checks:** none.
- **Risks:** back-of-camera shots (moire, glare) score badly; record it per shot type.
- **Parallel with:** P-00, P-01, P-03 to P-06.

### P-15 On-device model runtime

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** identify a photo on the phone, offline, matching the pipeline's vectors.
- **Scope in:** `onnxruntime-react-native` with Core ML and NNAPI or XNNPACK, preprocessing identical
  to A-10, int8 vector search over the region's vectors restricted to the checklist, location from the
  photo's EXIF or the phone (when allowed), seasonality as a tie-break only, results with confidence
  bands in words, model loaded lazily and released under memory pressure. **Out:** UI.
- **Files:** `apps/mobile/src/identify/` (new), the model asset in `apps/mobile/assets/models/`.
- **Depends on:** P-14, A-10, A-11, P-05.
- **Contracts:** the shared fixture from A-10 matches within tolerance.
- **Steps:** run inference off the UI thread; cache the loaded vectors per region.
- **Tests:** parity fixture; speed and memory budgets on the device matrix; a photo with no location.
- **Acceptance:** meets the budgets in "Size and choice" and the evaluation's accuracy.
- **UX checks:** none.
- **Risks:** Core ML conversion of some ops; fall back to the CPU provider.
- **Parallel with:** P-09, P-16 (UI against a stub), P-19.

### P-16 Identify tab and adding photos one at a time

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** "Is this a lifer?" in two taps, and the photo into Lifer only if wanted.
- **Scope in:** pick from the system photo picker, take a photo (back of camera, digiscope), receive
  from the share sheet; crop box; the result sheet: top suggestions with your status for each
  ("New for your life list", "Seen, no photo yet", "Photographed, 12 photos") and your best photo
  beside it to compare; choose the species; "Add to Lifer" (queued with the chosen species) or just
  "Mark as seen"; never auto-adds. **Out:** watched album and suggestions.
- **Files:** `apps/mobile/src/screens/identify/` (new).
- **Depends on:** P-04, P-15, P-07.
- **Contracts:** works fully offline; the add goes to the outbox.
- **Steps:** the picker needs no library permission; a camera shot is not saved to the camera roll
  unless the user chooses.
- **Tests:** e2e: offline identify, add, then sync; no suggestion confident; picker cancel.
- **Acceptance:** in airplane mode, picking a photo shows suggestions with the life-list status in
  under 2 s on a mid-range Android.
- **UX checks:** D3, D5, F1, S5, W8, W11, MR2, MR3, MR9, MR10, T5 (no celebration); HIG and Material review.
- **Risks:** users reading a suggestion as certain; confident wording only above the evaluated bar.
- **Parallel with:** P-17, P-19, P-20.

### P-17 Watched "Lifer" album

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** photos the user puts in a "Lifer" album upload by themselves.
- **Scope in:** opt-in switch, creating the album if missing, detecting new items (photo library
  change observer while running, a check in each background window), queueing them with species from
  the on-device model as an unconfirmed suggestion, honouring upload settings, never re-uploading a
  photo already sent. **Out:** suggestions from the whole camera roll (P-18).
- **Files:** `apps/mobile/src/watchedAlbum/` (new), a small native module if the library lacks album
  change events.
- **Depends on:** P-09, P-15.
- **Contracts:** "How photos get into Lifer" item 2; with limited photo access, only photos the user
  shared with Lifer are seen, and the screen says so.
- **Steps:** track sent assets by local id and fingerprint.
- **Tests:** real devices: add 1, 100 and 1,000 photos to the album; remove one before upload; limited
  access; the album renamed.
- **Acceptance:** a photo added to the album reaches the hub on the next Wi-Fi sync without opening
  Lifer's Identify screen.
- **UX checks:** MR10, MR11, F2, F3.
- **Risks:** Android has no shared album concept; use a "Lifer" folder in the device's Pictures.
- **Parallel with:** P-18, P-20.

### P-18 Animal photo suggestions from the camera roll

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** Lifer proposes new camera-roll photos with animals; the user confirms before anything uploads.
- **Scope in:** opt-in switch; an on-device detector over new photos since it was turned on (Vision on
  iOS, a permissively licensed classifier on Android), in small background batches; a "Suggested for
  Lifer" list grouped by day, confirm one, a group or dismiss; confirmed photos go through the same
  path as P-16. **Out:** scanning photos taken before it was turned on, unless the user picks a start
  date.
- **Files:** `apps/mobile/src/suggestions/` (new), a native module per platform.
- **Depends on:** P-09, P-15, P-17.
- **Contracts:** nothing leaves the phone to decide; nothing uploads without a confirm.
- **Steps:** process only new assets; checkpoint the last asset seen; skip screenshots and videos.
- **Tests:** precision on a sample camera roll (pets, zoo, back-of-camera, plain landscapes); battery
  use over a day; 20,000-photo roll with a start date.
- **Acceptance:** at least 9 of 10 suggestions contain an animal on the sample roll, and the battery
  cost is under 2% a day.
- **UX checks:** D2, D5, F3, MR10, MR11, S7; HIG and Material review of the list.
- **Risks:** pets flood suggestions; a "never suggest pets" switch if the evaluation shows it.
- **Parallel with:** P-20, P-21.

### P-19 Sightings with GPS

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** log "I saw this, here, now" in seconds, offline.
- **Scope in:** log from a species page, Identify or Trips: species, time, place from the phone's
  location (when-in-use permission only), accuracy, optional count; sensitive species stored obscured
  to the hub's rule; edit and delete with Undo; shows on the species page and trip. **Out:** free-text
  notes, track logs.
- **Files:** `apps/mobile/src/screens/sighting/` (new).
- **Depends on:** P-05, P-07, open question 3 decided and A-09.
- **Contracts:** a sighting marks the species seen; it syncs automatically.
- **Steps:** place name from the region bundle (province, nearest named place), never a map tile call.
- **Tests:** e2e offline log then sync; location denied (pick a place instead); poor accuracy.
- **Acceptance:** logging a sighting takes three taps from a species page.
- **UX checks:** D1, D7, F1, F3, MR2, MR3, MR9, MR10; HIG and Material review.
- **Risks:** blocked until the storage decision and its migration are approved.
- **Parallel with:** P-16, P-20, P-21.

### P-20 Trips tab, trip mode and your targets in the region

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** prepare a trip at home, use it offline in the field.
- **Scope in:** trips list from the hub; start a trip: pick regions (fetches their bundles and vectors
  from the hub while home), set targets; trip mode: targets not yet seen or photographed, ordered by
  this week's seasonality, the trip's sightings and photos, progress as plain counts; your targets in the region from the bundles on the phone, with no location use
  ("Targets near you" was dropped 2026-10-26: location-based likelihood is too sparse to meet expectations). **Out:** detailed maps.
- **Files:** `apps/mobile/src/screens/trips/` (new), `apps/mobile/src/targets/` (new).
- **Depends on:** P-05, P-07, A-08, F3.
- **Contracts:** "before you go" downloads show size first and run in the background.
- **Steps:** targets logic shared with Home; a region not downloaded says so with one action.
- **Tests:** e2e: plan at home, airplane mode, targets shown, sighting logged, sync on return.
- **Acceptance:** in airplane mode in a downloaded region, your targets in the region appear in under 1 s.
- **UX checks:** S6, S9, F2, F4, U1, A2, MR4, MR5; HIG and Material review; extremes: 3,000 targets,
  50 trips.
- **Risks:** location near borders; outline lookups from A-08.
- **Parallel with:** P-21, P-22.

### P-21 Search tab

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** find any species or your photos fast, offline first.
- **Scope in:** live, prefix-aware search over species names, synonyms and codes in the life list and
  downloaded checklists, and over your photos by species, tag, place and trip (FTS); "Search all
  photos in your Lifer" runs the hub's photo search when reachable, labelled as such; recent
  searches. English only, like desktop. **Out:** an on-device text encoder.
- **Files:** `apps/mobile/src/screens/search/` (new).
- **Depends on:** P-05, A-12.
- **Contracts:** Q1 to Q4: same rules as desktop, AND across terms, no "closest" filler.
- **Steps:** run the desktop's golden query table against the phone's search.
- **Tests:** the golden queries; offline; hub unreachable mid-query.
- **Acceptance:** golden queries return the same species sets as desktop.
- **UX checks:** Q1 to Q4, W10, S6, S9, MR4; HIG and Material review.
- **Risks:** none notable.
- **Parallel with:** P-20, P-22.

### P-22 Sharing and location privacy

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** nothing shared from the phone reveals where it was taken unless the user says so.
- **Scope in:** share from viewer and species page through the system share sheet with a fresh copy
  whose GPS, place and maker notes are removed; "Include location" off by default and unavailable
  for sensitive species; the same rules for anything else that leaves the phone. **Out:** the hub's
  share links (already strip sensitive places).
- **Files:** `apps/mobile/src/share/` (new), a native re-encode helper if needed.
- **Depends on:** P-13, F8 (sensitive list).
- **Contracts:** principle 6; uses A-12's sensitive-species rules.
- **Steps:** strip by re-encoding, not by editing tags in place; verify the output in tests.
- **Tests:** shared files checked with an EXIF reader for GPS, XMP location and maker notes on both
  platforms; a sensitive species with Include location on is still stripped.
- **Acceptance:** no shared file from any path carries a location unless allowed.
- **UX checks:** W3, W5, D2, MR3.
- **Risks:** HEIC and maker notes holding GPS; re-encode covers them.
- **Parallel with:** P-21, P-23.

### P-23 iNaturalist upload (DROPPED 2026-10-25: the iNaturalist app already does this well; Lifer's iNaturalist upload stays on the desktop and server)

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** send a photo to iNaturalist from the phone.
- **Scope in:** "Send to iNaturalist" on a photo; the request is queued and the hub sends it with its
  existing iNaturalist link; sensitive species go with obscured geoprivacy; status per photo (waiting
  for your Lifer, sent, failed with a plain reason). **Out:** OAuth on the phone (open question 5).
- **Files:** `apps/mobile/src/screens/inat/` (new).
- **Depends on:** A-09, the hub's iNaturalist integration being live (it ships dark until
  iNaturalist approves Lifer's app registration).
- **Contracts:** never sent without the user pressing Send.
- **Steps:** hide the action when the hub has no iNaturalist link, with one line on how to link it.
- **Tests:** e2e with a stubbed hub; offline queue; failure reasons.
- **Acceptance:** a photo sent while offline reaches iNaturalist after the next sync with the hub.
- **UX checks:** A1, F1, F2, S1, W8; HIG and Material review.
- **Risks:** depends on iNaturalist's approval timeline.
- **Parallel with:** P-22, P-24.

### P-24 Settings, storage and upload settings

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the few choices that matter, in one place.
- **Scope in:** your Lifer (hub name, last sync, unpair), uploads (Wi-Fi only, only while charging,
  watched album, suggestions), storage (cap slider, what uses space, showcase scope, clear thumbnails),
  offline regions, appearance (system, light, dark, Sunlight), names (common or scientific), the
  Immich line for server users, privacy statement, About with licences and model attribution.
  **Out:** anything the hub owns.
- **Files:** `apps/mobile/src/screens/settings/` (new).
- **Depends on:** P-04, P-08, P-09.
- **Contracts:** grouped rows, label left, control right (L3); changes apply at once.
- **Steps:** unpair confirms and says what stays on the phone.
- **Tests:** e2e for each setting's effect.
- **Acceptance:** turning Wi-Fi only off and on changes upload behaviour within one sync.
- **UX checks:** L3, W3, W5, W6, D2, F3, MR14; HIG and Material review.
- **Risks:** settings creep; keep to this list.
- **Parallel with:** P-23, P-25.

### P-25 Accessibility pass

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** every screen works with VoiceOver, TalkBack, Dynamic Type and reduced motion.
- **Scope in:** labels, roles, order and grouping; photo descriptions from species and date; the
  largest text sizes; reduced motion; Switch Control and keyboard on iPad; contrast in all
  appearances. **Out:** new features.
- **Files:** screens under `apps/mobile/src/screens/`.
- **Depends on:** P-10 to P-24.
- **Contracts:** MR1, MR6, MR7, Y1 to Y3.
- **Steps:** walk each flow with the screen reader on both platforms; fix in shared components first.
- **Tests:** automated accessibility checks in e2e; recorded manual walkthroughs.
- **Acceptance:** identify, log a sighting and show a showcase photo, done with eyes closed on both
  platforms.
- **UX checks:** Y1 to Y3, MR1, MR6, MR7.
- **Risks:** none notable.
- **Parallel with:** P-26, P-27.

### P-26 Test harness: fixtures, devices and network faults

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** the testing strategy below, runnable.
- **Scope in:** large and extreme fixtures for the phone store and a seeded `lifer_test` hub, Maestro
  flows for the main journeys (new dev dependency, approval needed), a fault proxy script between phone
  and hub (drops, delays, resets, truncation), the device matrix as a checklist, screenshot capture
  for HIG reviews. **Out:** feature tests owned by packages.
- **Files:** `apps/mobile/e2e/` (new), `apps/mobile/scripts/` (new).
- **Depends on:** P-03; grows with every package.
- **Contracts:** never touches the Docker `lifer` database.
- **Steps:** reuse the web extreme seed where possible.
- **Tests:** the harness runs in CI on simulator and emulator.
- **Acceptance:** one command produces the screenshot set for a HIG review.
- **UX checks:** none.
- **Risks:** simulator-only coverage; real devices are a manual step each milestone.
- **Parallel with:** every P package from P-05 on.

### P-27 Sample library

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** look around without a desktop or server, and give App Review something to test.
- **Scope in:** a small bundled library (about 60 species, CC0 or CC BY photos with attribution, one
  region bundle and its vectors), "Look around with a sample library" on the connect screen, a clear
  "Sample library" label, and Remove sample. **Out:** a demo server.
- **Files:** `apps/mobile/assets/sample/` (new), `apps/mobile/src/sample/` (new).
- **Depends on:** P-05, P-10, P-15.
- **Contracts:** sample data never syncs to a hub.
- **Steps:** pick photos with clean licences; record attribution.
- **Tests:** e2e: sample mode, identify, remove, then pair.
- **Acceptance:** every tab works in sample mode in airplane mode.
- **UX checks:** W3, W5, A1.
- **Risks:** app size; keep the sample under 20 MB.
- **Parallel with:** P-25, P-28.

### P-28 Beta builds: TestFlight and Play testing

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** signed builds in testers' hands.
- **Scope in:** iOS signing with the Developer account, TestFlight internal then external testing
  (external needs a beta review); Android upload key and Play App Signing, internal testing, then a
  closed test (new personal accounts need at least 12 testers for 14 days before production access);
  release build scripts run locally or on CI; tester notes. **Out:** production release.
- **Files:** `apps/mobile/scripts/release-*.sh` (new), `.github/workflows/release.yml` (mobile jobs,
  manual trigger only).
- **Depends on:** P-02 accounts, M4 exit.
- **Contracts:** no crash or analytics SDK; feedback through TestFlight and Play's own channels.
- **Steps:** keep signing secrets in CI secrets and the maintainer's keychain, never in the repo.
- **Tests:** install from each channel on the device matrix.
- **Acceptance:** 12 or more testers on each platform for 14 days with no data loss reported.
- **UX checks:** none.
- **Risks:** beta review rejections over needing a desktop; the sample library covers it.
- **Parallel with:** P-29, P-31.

### P-29 Store listings and assets

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** plain, honest listings.
- **Scope in:** name "Lifer Wildlife Archive", subtitle and description in plain words framed as an
  archive companion ("identify the photos you took"), screenshots for each required device size
  from the sample library, app icon per platform mask, keywords, support and privacy URLs. **Out:**
  any game, card, badge or ranking language.
- **Files:** `apps/mobile/store/` (new).
- **Depends on:** P-27, the trademark checks in P-02.
- **Contracts:** principle 8; W1 to W5 apply to store copy.
- **Steps:** draft, maintainer approves copy.
- **Tests:** `check:em-dashes` over the store text.
- **Acceptance:** the maintainer approves every string and screenshot.
- **UX checks:** W1 to W6, T6.
- **Risks:** confusion with the two other "Lifer" apps; lead with "Wildlife Archive".
- **Parallel with:** P-28, P-31.

### P-30 Store submission and review

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** live in both stores.
- **Scope in:** the steps in "Store submission" below, review notes, answering review questions,
  phased release. **Out:** later updates.
- **Files:** `apps/mobile/store/` (submission notes).
- **Depends on:** P-01 exception in place and lawyer-checked, P-28 exit, P-29.
- **Contracts:** privacy labels "no data collected"; Data safety "no data collected or shared".
- **Steps:** follow the checklist; record every answer given to the stores.
- **Tests:** none beyond the beta.
- **Acceptance:** both apps approved and released to all chosen countries.
- **UX checks:** none.
- **Risks:** App Review guideline 2.1 (needs a working demo) and 4.2 (minimum functionality); the
  sample library and the review note answer both.
- **Parallel with:** P-31.

### P-31 Docs

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it before hand-back.
- **Goal:** users and contributors can use and build the phone app.
- **Scope in:** user docs (pair, what's kept offline, uploads and the three ways photos get in,
  privacy, Immich users), the privacy page line for the phone, contributor docs for `apps/mobile`.
  **Out:** old versions or upgrade notes.
- **Files:** `docs/docs/mobile/` (new), the privacy page, `docs/docs/contributing/mobile.md` (new).
- **Depends on:** features settled.
- **Contracts:** this plan.
- **Steps:** house style; screenshots from the sample library.
- **Tests:** `check:em-dashes`, docs build.
- **Acceptance:** a new user pairs a phone from the docs alone.
- **UX checks:** W1, W3, W6.
- **Risks:** none.
- **Parallel with:** P-28 to P-30.

## Order

```
Decide:      P-00, P-01, P-02, P-14                     (parallel)
Lifer repo:  A-12, A-13 --> A-01 --> A-02, A-03, A-04 --> A-05 --> A-06
                             \--> A-07, A-08, A-09 (after foundation F2 to F8)
             P-14 --> A-10 --> A-11
Phone:       P-03 --> P-04, P-05, P-06 --> P-07 --> P-08 --> P-09
             P-10 to P-13, P-21, P-24 once P-04 and P-05 exist
             P-15 --> P-16 --> P-17 --> P-18
             P-19, P-20 after A-09 and F3, F4
             P-22, P-23 --> P-25 --> P-27 --> P-28 --> P-29 --> P-30
             P-26 grows from P-05 on; P-31 last
```

## Effort

Worker-days per package, before review (reviews add about a fifth).

| Package | Days | Package | Days | Package | Days |
|---|---|---|---|---|---|
| A-01 | 2 | P-00 | 5 | P-16 | 4 |
| A-02 | 3 | P-01 | 2 | P-17 | 3 |
| A-03 | 5 | P-02 | 1 | P-18 | 5 |
| A-04 | 1 | P-03 | 3 | P-19 | 3 |
| A-05 | 4 | P-04 | 5 | P-20 | 5 |
| A-06 | 3 | P-05 | 5 | P-21 | 3 |
| A-07 | 3 | P-06 | 5 | P-22 | 3 |
| A-08 | 4 | P-07 | 6 | P-23 | 3 |
| A-09 | 4 | P-08 | 4 | P-24 | 3 |
| A-10 | 4 | P-09 | 5 | P-25 | 3 |
| A-11 | 1 | P-10 | 3 | P-26 | 4 |
| A-12 | 2 | P-11 | 3 | P-27 | 2 |
| A-13 | 1 | P-12 | 4 | P-28 | 3 |
| | | P-13 | 4 | P-29 | 2 |
| | | P-14 | 5 | P-30 | 3 |
| | | P-15 | 5 | P-31 | 2 |

Total: 37 days for the Lifer repo, 116 for the phone, about 153 worker-days. With packages run in
parallel and the maintainer reviewing, about 5 to 6 months of calendar time, plus store review waits.

## Milestones

| Milestone | Packages | Calendar | Exit criteria the maintainer can test |
|---|---|---|---|
| M0 Decide | P-00, P-01, P-02, P-14 | 2 weeks | Both prototypes run on your phone and you pick a stack; licence wording is with a lawyer; accounts open; trademark searches done; a mobile model chosen with its accuracy, size and speed in front of you. |
| M1 Hub ready | A-01 to A-13 (after sync foundation F2 to F8) | 3 weeks | On the desktop, Settings > Connect phone shows a QR; a test client on another computer pairs with it and reads your life list; nothing else on the API answers it; close the window and the tray keeps it answering; Revoke cuts it off at once. |
| M2 Read-only companion | P-03 to P-08, P-10 to P-13, P-21, P-24 | 5 weeks | Install a dev build, scan the QR, see your life list with your photos; turn on airplane mode and browse it, search it, and open showcase photos full screen with no wait; the thumbnail cache stays under the cap you set. |
| M3 Field app | P-09, P-15 to P-20 | 5 weeks | In airplane mode in a park: photograph the back of your camera, get "Is this a lifer?", add it, log a sighting with GPS, see your targets in trip mode; back on home Wi-Fi it all reaches the desktop by itself; a photo dropped in the "Lifer" album uploads without opening Identify; suggestions propose animal photos and nothing uploads until you confirm. |
| M4 Share, iNaturalist, accessibility | P-22, P-23, P-25, P-27 | 2 weeks | A shared photo has no location in an EXIF reader, and a sensitive species never does; a photo sent to iNaturalist from the phone arrives after sync; the main flows work with VoiceOver and TalkBack and at the largest text size; sample library works with no hub. |
| M5 Beta | P-26, P-28 | 4 weeks | TestFlight and Play closed testing with 12 or more testers each for 14 days; no data loss; the device matrix and fault tests pass. |
| M6 Store release | P-29, P-30, P-31 | 2 weeks plus review | Both stores approve "Lifer Wildlife Archive" with "no data collected" labels; you install it from each store and pair it. |

## Testing strategy

- **Unit:** store, sync engine, matching and privacy stripping against fakes, in CI.
- **Integration:** the phone's sync engine against the real API in desktop mode and server mode on
  `lifer_test`, never the Docker `lifer` database.
- **End to end:** Maestro flows on simulator and emulator in CI for pairing, browse, identify, add,
  sighting, trip, share, settings, sample library.
- **Real devices, each milestone:** the oldest iPhone the chosen iOS minimum supports, a current
  iPhone, a small iPhone, an iPad, a low-end Android with 3 to 4 GB of RAM, a Pixel, a Samsung (strict
  battery saver), and one other manufacturer with aggressive background limits.
- **Offline and flaky network:** airplane mode at every step; iOS Network Link Conditioner and the
  Android emulator's network profiles; a fault proxy between phone and hub that drops, delays,
  resets and truncates; the hub restarting mid-page; the desktop's IP changing; a guest network that
  blocks client-to-client traffic; captive portals.
- **Large libraries:** 200,000 photos, 5,000 species, 200-character names, 50 trips, 3,000 targets, a
  full disk, a 1 GB cap filled.
- **Background:** app killed mid-upload, reboot, low power mode, Doze, background refresh turned off.
- **Battery and data:** a day of normal use with suggestions on; data used on cellular with Wi-Fi only
  on must be only the small sync calls.
- **Privacy:** a network capture of a full session shows only the hub (and iNaturalist through the
  hub); every shared file checked for location.
- **Two phones and a desktop:** concurrent edits to the same species converge.
- **HIG review:** screenshots of every screen on iOS and Android, light, dark and Sunlight, smallest
  and largest phone, largest text size, extreme data.

## Store submission

1. Confirm the App Store exception is in the licence, the lawyer has checked it, and the licence
   audit passes.
2. Confirm the trademark searches and the store name "Lifer Wildlife Archive" in both stores.
3. App Store Connect: create the app with bundle id `app.lifer.mobile`, seller name from the account.
4. Privacy: the nutrition label "Data Not Collected"; a privacy policy URL saying Lifer collects
   nothing and talks only to the user's own Lifer.
5. Export compliance: the app uses only standard encryption (TLS); answer the questions accordingly
   and record the answer.
6. Age rating questionnaire; category Photo and Video or Reference (open question 13).
7. Permission strings in plain words: camera, photos (for watched album and suggestions only),
   location when in use, local network.
8. Review notes: what the app is, that it pairs with the user's own Lifer, and how to try it with the
   sample library with no account.
9. Screenshots for each required size; app preview optional.
10. Submit the build from TestFlight; answer review questions; phased release.
11. Play Console: create the app, Data safety form "no data collected or shared", content rating,
    target audience, the current target API level Play requires, the 12-tester 14-day closed test
    completed, production access requested.
12. Play: app signing by Google Play with an upload key; release to production in stages.
13. After release: keep the review notes, answers and signing details in the maintainer's records.

## Risks

- **Sync foundation timing.** F3, F4, F6 and F8 must land in or after 1.0 before M3.
- **iOS background limits.** Sync can't be promised in the background; foreground sync is the
  guarantee and the sync line is honest about the last sync.
- **Local network quirks.** mDNS blocked on many networks; stored addresses and plain messages.
- **Third-party licences.** One GPL or AGPL dependency blocks iOS distribution; the audit runs in CI.
- **Model accuracy on phone shots.** Back-of-camera and digiscoped photos are hard; the wording
  stays honest about confidence.
- **App Review.** An app that needs a computer to work; the sample library and review notes.
- **Name confusion.** Two existing "Lifer" apps; the store name leads with "Wildlife Archive".

## Open questions

1. **Stack (NEEDS MAINTAINER APPROVAL).** Expo or Tauri mobile? Recommendation: Expo, confirmed by
   P-00's numbers.
2. **Where the code lives.** Recommendation: `apps/mobile` in this monorepo, so shared logic and
   checks stay one place.
3. **Sightings storage.** A new `sightings` table that syncs with `updated_at` and tombstones, or
   dated seen marks on `user_species`? Recommendation: a new table (migration needs approval), shown
   on the desktop species page too, since one species has many sightings.
4. **Mobile model.** BioCLIP v1 int8 (about 90 MB) or a distilled BioCLIP 2 student? Recommendation:
   BioCLIP v1 for the first release if P-14 shows top-5 within 5 points of desktop; distil later.
5. **iNaturalist from the phone.** Through the hub, or direct OAuth on the phone? Recommendation:
   through the hub for the first release: one link, no tokens on phones. Direct later if desktop-only
   users ask for field uploads.
6. **Subject crop.** User crop box only, or a permissively licensed detector? Recommendation: user
   crop first; add a detector only if P-14 shows a clear gain, and never `yolov8n` on iOS.
7. **Android suggestions detector.** Which permissively licensed animal classifier? Recommendation:
   choose in P-14 from Apache or MIT models; no Google ML Kit.
8. **Model in the app or from the hub.** Recommendation: in the app (about 90 MB), so Identify works
   at once and the sample library works for App Review.
9. **Maps.** Recommendation: no map in the first release; place names from region bundles, which
   keeps map data off the phone.
10. **Seller identity.** Individual or organisation account? Recommendation: decide before M5, since
    the seller name shows in both stores and is slow to change.
11. **Contributor sign-off.** DCO or CLA? Recommendation: DCO with a sign-off line that names the App
    Store exception, if the lawyer agrees it suffices; otherwise a short CLA.
12. **Minimum OS versions.** Recommendation: the oldest iOS and Android versions the chosen Expo SDK
    supports at the time, checked against the model runtime.
13. **Store category.** Photo and Video, or Reference? Recommendation: Photo and Video, which matches
    "archive companion".
14. **Editing on the phone.** Recommendation: seen, target, favourite, species and tags only; no
    ratings or picks, which research shows few want on a phone.
15. **Showcase definition.** Recommendation: each species' cover photo plus the Favourites album,
    with a switch to keep only favourites when space is short.
16. **Media over cellular.** Recommendation: Lifer data on any network (server users), photos and
    thumbnails under the Wi-Fi only setting, which is on by default.
17. **Tablets.** Recommendation: run the phone layout with a comfortable maximum width on iPad and
    Android tablets in the first release; a tablet layout later.
18. **Desktop linked to a server.** Recommendation: the phone pairs with the server; the desktop's
    Connect phone page says so and shows the server's code.

## Build status update (2026-10-25, offline library)

Built in `apps/mobile`, all tested (vitest for the store, sync, media cache, search and layout; jest render
tests for every screen) and compiled and run in the iOS Simulator (light and dark):

- Offline store (expo-sqlite, migrations, `src/store`): marks, targets, sightings, trips, albums, captures,
  region checklists, cursors, outbox, media index. Screens read only from it.
- Sync engine (`src/sync`): cursor pulls for captures, albums, trips, saved spots, album membership, marks and
  preferences; version-checked mark push with conflict handling (hub copy wins; a standalone list meeting a
  library for the first time merges: stronger state, targets kept); retry and backoff; foreground sync on open,
  on return and on pull to refresh; one calm sync line.
- Media cache (`src/media`): thumbnails under a cap (default 1 GB, least recently used out), showcase (covers and
  the Favourites album at 2048 px, excluded from iCloud backup), full size on demand kept an hour, Wi-Fi only
  honoured through a native metered-connection check in the pinned-fetch module, which also streams binary
  downloads for desktop hubs.
- Tabs: Home, Life list, Identify, Trips, Photos; species page, trip mode, viewer, region checklists, Settings,
  first-run Welcome, standalone mode.

Not done or stubbed: background sync (expo-background-task and expo-task-manager are approved but not installed);
Android pinch zoom in the viewer (iPhone uses the platform scroll view); standalone checklists carry scientific
names only (the pack archives need a gzip and tar reader, fflate MIT, not installed) so sha256 checks on pack
archives are not used; sightings and trips started on the phone stay on the phone (the hub has no route for them);
the Kotlin changes are uncompiled; smart album rules (album-exclusions feed) are not pulled; on-device
recognition is not built (Identify says so and offers name search).

## Build status update (2026-10-26, offline smart search, paired mode)

Built in `apps/mobile/src/search` (unit and render tested; see the numbers in the last section's report):

- **Tokenizer** (`clipTokenizer.ts`): CLIP byte-level BPE read from the hub's `tokenizer.json`, tested against token
  ids the hub's own tokenizer produced (`testdata/`). A text over 77 tokens loses its end token, as on the hub.
- **Model download** (`modelDownload.ts`, `modelFs.ts`): after each sync the phone reads `/companion/v1/model/text`,
  downloads the encoder and tokenizer in 8 MB ranges (resumable, SHA-256 checked, Wi-Fi only honoured, kept in app
  documents and out of backup) and re-downloads only a file whose hash changed. On by default (`settings.smartSearch`);
  Settings shows the size and a Remove button, and Remove falls back to hub search, then names. The pinned-fetch
  native `download` now keeps a 206 answer as well as a 200 (iOS and Android), so a desktop hub can be ranged.
- **Vectors** (`vectorStore.ts`): the vector feed is pulled into `capture_vectors` (migration 2, one 1,536 byte blob
  per capture, multi-row inserts, removed captures dropped, cursor stored with each page, cleared and re-pulled when
  the hub's image model changes). Ranking reads them from one flat in-memory index (about 92 MB for 60,000 photos).
- **Search** (`localSearch.ts`, `smartSearch.ts`): the Photos tab embeds the query on the phone and ranks with the
  shared `parseSearchQuery`, `rankSearch` and `makePictureScorer` over rows built from the synced captures; the hub is
  asked only when local search is not ready. The phone has no scene readings, camera, sun position, taxon order,
  region tree or species aliases, so those parts of the query stay quiet until the feeds carry them.
- **Phone-only users** (`phoneOnly.ts`): checklist-only users download nothing. `PHONE_MODEL_HOST` and
  `REFERENCE_VECTOR_HOST` are null (TODO); until set, Identify and Settings say "Smart search will be available once
  downloads are set up" and name search keeps working. `computePhotoVectors` is the background loop (one photo at a
  time, progress line) waiting for an image encoder. Still to build with the host: the image encoder download, image
  preprocessing (resize to 224, CLIP normalisation) and Identify against region reference vectors.
