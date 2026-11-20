---
title: Build a companion app
description: How a separate program shows its own page inside the Lifer desktop app and uses your own data through scoped API keys.
slug: /api/plugins
---

# Build a companion app

A companion app is a separate program that people install on their own. In the Lifer desktop app it gets a sidebar item and shows its own page, and it reads and adds to the user's library through the public API with a key the user approved. Lifer never loads, bundles or links the app's code.

Every part is public: the manifest, the launch rules, the page protocol, pairing and the scopes below. There are no private routes.

- Lifer runs the app as its own process and shows a web page the app serves on `127.0.0.1`, inside an iframe.
- The page and Lifer talk through `postMessage` (the host protocol).
- The app uses the [API](./overview.md) with a key, like any integration. Each app is approved once, shows in **Settings > Integrations > Connected apps**, and can be revoked in one click. There the user can also hide its sidebar item, turn off its notices, or remove it (which disconnects and hides it, and leaves the app itself installed).
- A server's web interface never shows companion apps. A server only takes pairings from an app running on another computer.

Lifer is complete without any companion app, and it never contacts an app's maker.

## 1. Tell Lifer the app exists: the manifest

Write one JSON file named `<id>.json` into the plugins folder:

| System  | Folder                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/app.lifer.desktop/plugins/`                                        |
| Windows | `%APPDATA%\app.lifer.desktop\plugins\`                                                            |
| Linux   | `$XDG_DATA_HOME/app.lifer.desktop/plugins/` (default `~/.local/share/app.lifer.desktop/plugins/`) |

Lifer reads the folder at launch and every few seconds after, so installing or removing an app shows up without a restart. A manifest that fails validation is ignored, never shown half-working.

| Field                              | Meaning                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                           | `1`                                                                                                                                                                                                               |
| `id`                               | Reverse-DNS id, for example `com.example.myapp`                                                                                                                                                                   |
| `name`                             | Display name                                                                                                                                                                                                      |
| `publisher`, `homepage`, `support` | Plain https URLs, shown in Connected apps                                                                                                                                                                         |
| `version`                          | Your app's version                                                                                                                                                                                                |
| `executable`                       | Absolute path per system: `{ "darwin": "...", "win32": "...", "linux": "..." }`                                                                                                                                   |
| `protocol`                         | Host protocol versions you speak, for example `[1]`                                                                                                                                                               |
| `page`                             | `{ label, icon, accent, surface }`: the sidebar label, a monochrome SVG path, an accent colour, and `"default"` or `"dark"` for the surface the page wants                                                        |
| `scopes`                           | The API scopes you will ask for when pairing                                                                                                                                                                      |
| `capabilities`                     | Optional host features you use: `pickers`, `notifications`, `imports`, `offersImports`, `background`, `host.preference`. A capability this Lifer doesn't know is skipped and the rest of the manifest still loads |

The first time Lifer launches your app, the user approves the executable. The approval follows the signer (the Team ID on macOS, the certificate's subject and issuer on Windows) and the file's SHA-256 when it is unsigned and on Linux, so a changed path or a swapped file asks again.

## 2. Start and stop: the launch rules

Lifer starts your app the first time its page opens, then keeps it running until Lifer quits. With the `background` capability, Lifer also starts an approved app a few seconds after Lifer itself starts and loads its page out of sight, so it is ready the moment the user opens it; the user can turn this off per app in **Settings > Integrations > Connected apps**. Keep a page that isn't visible idle: wait for work instead of polling.

1. Lifer runs `executable --lifer-host --protocol=1`, with a one-time secret `LIFER_HOST_TICKET` (64 lowercase hex characters) and `LIFER_WATCH_PARENT_PID` (Lifer's process id) in the environment. Standard input, output and error are pipes.
2. Start a web server on `127.0.0.1`, then print one line on standard output once it answers the health check:

   ```text
   LIFER_PLUGIN_READY port=<port> page=<path> pageToken=<token>
   ```

   `page` starts with a single `/`. `pageToken` is 1 to 512 characters from `A-Z a-z 0-9 - _ . ~`. Lifer gives you 30 seconds.

3. Answer `GET /lifer-host/health?nonce=<nonce>` with status 200, `Content-Type: application/json` and `{"proof":"<hex>"}`, where `proof` is the lowercase hex HMAC-SHA256 with the ticket string as the key and the nonce string as the message. This proves the process on that port is the one Lifer launched. Lifer checks right after READY and every 10 seconds while the page is visible. Two failures in a row count as a crash.
4. Exit when your standard input closes or the process named by `LIFER_WATCH_PARENT_PID` is gone (check at least every 2 seconds). Lifer stops anything still running 5 seconds after closing standard input.
5. Exit code 0 means the user closed the app: Lifer shows it as closed and doesn't restart it. Any other exit is a crash and restarts once.

If your app is already running with its own window, the launched process may pass the ticket to the running instance over a channel only the same user can open (a Unix domain socket in a folder only the user can write, or a user-only named pipe on Windows), print READY for it and exit 0. Never pass the ticket over loopback TCP, a file or a command line.

Your app shows no Dock or taskbar icon of its own when Lifer launches it.

## 3. Your page: the host protocol

Lifer shows `page` full-bleed in a sandboxed iframe (`allow-scripts allow-same-origin allow-forms allow-downloads`). The page token is never in the URL: it arrives in the `credential` message, and your page sends it with its own requests to your server.

Every message is `{ lifer: 1, type, id?, payload }`. Check that `event.source` is `window.parent` and ignore unknown types and other versions. A message from your page with an `id` (a string of up to 64 characters) gets exactly one reply, `{ lifer: 1, type: "reply", id, payload: { ok: true, result } | { ok: false, error } }`, where `error` is `not-allowed`, `invalid`, `not-found`, `unsupported`, `failed` or `timeout`.

| Direction     | Type                            | Payload                                                                                                                      |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| page to Lifer | `ready`                         | `{ protocol }`, once the page is up                                                                                          |
| Lifer to page | `credential`                    | `{ token }`, the page token, sent right before every `init`                                                                  |
| Lifer to page | `init`                          | `{ protocol, theme, locale, platform, reservedShortcuts, hostVersion, visible }`                                             |
| Lifer to page | `theme`, `locale`, `visibility` | The theme tokens, language or visibility changed                                                                             |
| page to Lifer | `shortcut`                      | `{ key, code?, meta, ctrl, alt, shift }` for a chord Lifer reserves                                                          |
| page to Lifer | `navigate`                      | `{ to: "species", scientificName }` or `{ to: "gallery", query }`                                                            |
| page to Lifer | `title`                         | `{ text }`, the toolbar title                                                                                                |
| page to Lifer | `pickFolder`, `pickFiles`       | `{ title? }`; needs `pickers`                                                                                                |
| page to Lifer | `reveal`                        | `{ path }`, shows a local path in Finder, Explorer or the file manager                                                       |
| page to Lifer | `openUrl`                       | `{ url }`, https only, opened in the browser                                                                                 |
| page to Lifer | `notify`                        | `{ title, body?, action? }`; needs `notifications`                                                                           |
| page to Lifer | `host.preference.get`           | `{}`, with an `id`; replies `{ openInHost }`; needs `host.preference`                                                        |
| page to Lifer | `host.preference.request`       | `{ openInHost }`, with an `id`; asks the person, replies `{ granted, openInHost }` once they answer; needs `host.preference` |
| Lifer to page | `host.preference.changed`       | `{ openInHost }`, after the person changed it, to a page that used the two above                                             |

Lifer reserves a few chords (the page switchers, search, Settings, Import and the sidebar). `init` lists them: on a match, call `preventDefault()` and send `shortcut`. Escape belongs to your page.

The shared types are in `packages/shared/src/pluginProtocol.ts` in the Lifer repository.

## 4. Get a key: pairing

Keys are ordinary API keys named after your app and carrying only the scopes the user approved. Store yours in the operating system's credential store.

| Where                       | Flow                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, launched by Lifer  | `POST /api/plugins/v1/pair` with `{ ticket, pluginId, scopes }`. The first time, Lifer asks the user to allow it; the reply carries the key. Later launches with the same scopes need no dialog.                                                                                             |
| Desktop, started on its own | `POST /api/plugins/v1/pair-requests` with `{ pluginId, name, scopes }` and show the 6-digit `code` you get back. Lifer shows the same code with Allow and Deny. Poll `GET /api/plugins/v1/pair-requests/:id` until `status` is `approved` and `key` is set. Requests expire after 5 minutes. |
| Server                      | The user chooses **Pair an app** in **Settings > Integrations > Connected apps**, which shows a code valid for 10 minutes. `POST /api/plugins/v1/pair` with `{ code, pluginId, name, scopes }`.                                                                                              |

When the person installs your app from Lifer's own offer page, Lifer lists what the app will be able to do next to the button, and that click is their consent: for 30 minutes, the first launch by Lifer that pairs with those scopes or fewer gets its key without the dialog, once. Asking for more, or pairing an app started on its own, shows the dialog as usual. A waiting allowance shows in **Connected apps**, where the person can cancel it.

Pairing is rate limited to 5 attempts a minute, codes work once, and the desktop API on `127.0.0.1:4310` is what you call on a computer running the app. On a multi-user server each person pairs their own account and gets their own data. A desktop that is linked to a server keeps apps paired with its own local API.

## 5. Scopes and routes

| Scope            | Route                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userdata.read`  | `GET /api/userdata/v1/species`                                              | The species the user marked or photographed: `scientificName`, `state` (`photographed` or `seen`), `isTarget`, `firstCollected`, `lastPhotographed`, `photoCount`, `bestRating`, `coverPhotoId`, `updatedAt`, plus removed marks with `deletedAt`. Page with `cursor`, then pass the last `updatedAt` as `since`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `userdata.read`  | `GET /api/userdata/v1/name-display`                                         | How the user wants species named: `{ main: "common" or "scientific", also: ["other", "aba", "ebird"] }`, the default when never set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `userdata.read`  | `GET /api/userdata/v1/photos/:id/display`                                   | The display image of one of the user's own photos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `userdata.read`  | `GET /api/userdata/v1/species/:id/featured`                                 | A species' featured photo: `{ photo: { photoId, chosenByUser, cardCrop: { x, y, size }, rating, flag, label } or null, needsBetterPhoto }`. `cardCrop` is in percent of the photo, `flag` is `pick` or `reject`. 404 when the user has no mark for the species.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `userdata.read`  | `POST /api/userdata/v1/species/:id/similar-photos`                          | Body `{ model, vector, limit? }`: a 768-number image embedding and the model it came from (`clip-vit-l14-v2`, Lifer's own; any other answers 400). Answers `{ model, items: [{ photoId, similarity, rating, flag, label, takenAt, featured }] }`: the user's photos of that species closest to the image, closest first, 10 by default and at most 50. Reads only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `userdata.read`  | `GET /api/userdata/v1/photos/:id/thumb`                                     | The thumbnail of one of the user's own photos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `userdata.read`  | `GET /api/userdata/v1/species/:id/photos`                                   | Query `limit` (1 to 200, default 50). Answers `{ items: [{ photoId, captureId, thumbnailUrl, rating, flag, label, takenAt, featured }] }`: the user's photos of that species, highest rating first, then newest. `thumbnailUrl` works with the same key. Hidden and trashed photos are left out; 404 for an unknown species.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `userdata.write` | `PATCH /api/userdata/v1/photos/:id`                                         | Any of `rating` (1 to 5), `flag` (`pick` or `reject`) and `label` (a colour label: `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `gray`, `black`, `white`) on one of the user's photos. `null` clears one; a field left out stays as it is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `userdata.write` | `PUT /api/userdata/v1/species/:id/featured`                                 | Body `{ photoId }`: makes one of the user's photos of that species its featured photo (403 for any other photo). Lifer frames a fresh default crop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `userdata.write` | `PUT /api/userdata/v1/species/:id/card-crop`                                | Body `{ x, y, size }` in percent of the photo: the crop of the species' featured photo. 404 when it has none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `userdata.write` | `PUT` and `DELETE /api/userdata/v1/species/:id/needs-better-photo`          | Sets or clears the "Needs a better photo" mark. Lifer shows it on the species page and as a Collection filter, and it syncs to the user's phone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `opendata.read`  | `GET /api/opendata/v1/regions`                                              | The regions the user has installed in Lifer: `{ regions: [{ id, name, countryCode, parentId, bounds, speciesCount }] }`. A country counts when one of its packs is downloaded, and so do its provinces that have a list of their own. `bounds` is `{ minLat, minLon, maxLat, maxLon }` around the region's outline, or null.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `opendata.read`  | `GET /api/opendata/v1/regions/at?lat=&lon=`                                 | The installed regions that contain a point, most specific first (a province before its country), in the same shape. Empty when none is installed there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `opendata.read`  | `GET /api/opendata/v1/regions/:id/checklist`                                | A region's species list: `{ regionId, name, items: [{ scientificName, commonName, taxonClass, ebirdCode, tier, isVagrant, sensitiveByDefault }] }`. 404 for an unknown region.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `opendata.read`  | `GET /api/opendata/v1/regions/tree`                                         | Every region in the catalog, installed or not, for browsing and searching: `{ regions: [{ id, name, parentId, countryCode, aliases, hasChildren, hasChecklist, installed }] }`. Any region with `hasChecklist` answers `/regions/:id/checklist`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `opendata.read`  | `POST /api/opendata/v1/species/rank`                                        | Species ranked for a photo by Lifer's own matching. Body `{ model, regionId, vectors, takenAt?, limit? }`: `model` must be `clip-vit-l14-v2` (else 409), `vectors` holds 1 to 4 L2-normalised 768-number CLIP ViT-L/14 image vectors of one subject (its crop, and the whole photo when the crop is unsure), `regionId` limits the ranking to that region's list. Answers `{ model, suggestions: [{ scientificName, commonName, score, matchPercent, confident }] }`. Reference photos take part only under CC0, the Public Domain Mark or CC BY; the requesting user's own photos of their own species take part too (their data, used locally for them, never another user's), and there is no tier or seasonality weighting, so callers weigh abundance themselves. A species with no open reference photo is ranked by its name. `score` only means something relative to the other candidates. |
| `opendata.read`  | `POST /api/opendata/v1/species/rank-batch`                                  | The same ranking for up to 16 subjects in one request. Body `{ model, regionId, limit?, items: [{ vectors, takenAt? }] }`. Answers `{ model, results: [{ suggestions }] }` in the order of `items`, each exactly what `species/rank` answers for that item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `opendata.read`  | `POST /api/opendata/v1/species/names`                                       | Lifer's names for scientific names. Body `{ scientificNames }` (up to 2000). Answers `{ names: [{ scientificName, canonicalScientificName, commonName, ebirdCode, abaCode }] }`, resolving superseded scientific names through Lifer's synonyms (`canonicalScientificName` is the current one). Names Lifer doesn't know are left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `imports.write`  | `POST /api/imports/v1/folders`                                              | Desktop only. Imports a folder of photos in the background. Ratings, picks, labels and species keywords in the files' XMP are read, and photos Lifer already has are skipped. `mode` is `in-place` or `copy`; Lifer only leaves files in place inside a folder or drive it already knows, and says which it did in `mode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `imports.write`  | `GET /api/imports/v1/jobs/:id`                                              | Progress of that import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `imports.write`  | `POST /api/imports/v1/species-lookup`                                       | Body `{ "scientificNames": ["Larus argentatus", ...] }` (1 to 500). Answers `{ "matches": [{ "name", "speciesId", "scientificName", "match": "exact" or "synonym" }], "unmatched": [names] }`. Case-insensitive; exact current names and superseded names only, and nothing else from the catalog. Use the `speciesId` in an upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `imports.write`  | `POST /api/uploads` and resumable uploads (`/api/uploads/tus`), on a server | New photos only. Multipart fields: `speciesId`, `file` (or `uploadId` from a resumable upload), optional `rawFile` (or `rawUploadId`), and optional `xmpFile` (or `xmpUploadId`), the XMP sidecar of the file or its RAW. Its rating, pick or reject, colour label and keywords are applied as for a sidecar on disk. Send `skipDuplicates=1` to make re-sends safe. The `201` answer is `{ captureId, photoId, hidden, sha256, rawSha256? }`: `sha256` is the hex SHA-256 of the stored file's bytes and `rawSha256` that of the RAW sent with it, so you can verify the transfer. A duplicate answers `200` with `{ captureId, photoId, duplicate: true, sha256 }`.                                                                                                                                                                                                                               |

The full list, with fields, is in `GET /api/openapi.json`.

### Open inside Lifer

Desktop only. A paired app's key can use these whatever scopes it holds, including keys paired before they existed. The preference is off until the person says yes; your app can only ask. They can change it any time in **Settings > Integrations > Connected apps**. Each app may make 10 of these calls a minute.

| Route                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/plugins/v1/host-preference`          | `{ openInHost }`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/plugins/v1/host-preference/request` | Body `{ openInHost }`. Lifer asks "Open inside Lifer from now on?" (or the reverse) and answers `{ granted, openInHost }` once the person answers. Not now, or no answer in 5 minutes, changes nothing. Asking for what's already set answers at once.                                                                                                                                                                                                          |
| `POST /api/plugins/v1/host/open`               | Body `{ pluginId }`, your own id, once `openInHost` is on (else 403). Lifer comes forward and shows your page, then answers `{ ok: true }`. Otherwise `{ ok: false, reason }`: `busy` (a Lifer dialog is waiting for the person, or this app is already opening), `not_ready` (Lifer didn't show it within 30 seconds) or `no_frame` (this Lifer window can't show an app, for example while it shows a Lifer server). Keep your own window until `ok` is true. |

### Writes are logged and undoable

Every `userdata.write` call answers `{ ok, changeId }`. Lifer records each change under your app's name in **Settings > Integrations > Connected apps**, where the user can undo any of them; `changeId` is null when the call changed nothing. Each app may make up to 600 changes a minute for each user; past that, Lifer answers 429 with `Retry-After`. An app paired before it asked for `userdata.write` gets the consent dialog again the first time it asks for it.

### What a companion app never gets

`userdata.read` covers the user's own marks and photos and never returns rarity tiers, seasonality, descriptions or reference photos. `opendata.read` returns only the species lists of regions the user installed, and nothing else from the catalog. Scientific names come back as facts, so you can match species with your own taxonomy. A key can't create or revoke keys. `userdata.write` sets only the marks listed above: it can't delete, move or re-file photos, change a photo's species, or change settings.

## 6. Offer past work to bring in

An app with the `offersImports` capability can answer `GET /lifer-host/imports` on its own server with a list of past work: `[{ "id", "name", "date", "fileCount" }]`. Lifer lists it in **Settings > Library** as "Bring in your work from your app". When the user chooses one, Lifer calls `POST /lifer-host/imports/export` with `{ "id" }`, and your app writes that work to a new folder (photos with their XMP) and answers `{ "folder": "/absolute/path" }`. Lifer then imports that folder with the same folder import as above, so the files' own marks win and Lifer's recognition only fills gaps.

## 7. The example app

The Lifer repository has a complete companion app in about 200 lines of Node.js with no dependencies: `e2e/fixtures/example-plugin/` (`plugin.mjs` and the `page.html` it serves). Lifer's own tests run it end to end, so it always matches this page. Add it to your Lifer with `node plugin.mjs --install` (macOS and Linux; on Windows `executable` must be a real program, so wrap it in your own launcher).

The manifest it writes:

```json
{
  "schema": 1,
  "id": "com.example.lifer-example",
  "name": "Example companion",
  "publisher": "https://example.com",
  "homepage": "https://example.com/lifer-example",
  "support": "https://example.com/support",
  "version": "1.0.0",
  "executable": { "darwin": "/path/to/plugin.mjs", "linux": "/path/to/plugin.mjs", "win32": "..." },
  "protocol": [1],
  "page": { "label": "Example", "icon": "M4 4h16v16H4z", "accent": "#2f7d5b", "surface": "default" },
  "scopes": ["userdata.read", "imports.write"],
  "capabilities": ["pickers", "notifications"]
}
```

Launched with `--lifer-host`, it answers the health check, prints READY, then pairs:

```js
const ticket = process.env.LIFER_HOST_TICKET;
const pageToken = randomBytes(24).toString("base64url");

// GET /lifer-host/health?nonce=...
send(res, 200, { proof: createHmac("sha256", ticket).update(nonce).digest("hex") });

server.listen(0, "127.0.0.1", () => {
  console.log(`LIFER_PLUGIN_READY port=${server.address().port} page=/ pageToken=${pageToken}`);
  // Waits the first time, until the user answers Lifer's dialog.
  fetch("http://127.0.0.1:4310/api/plugins/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "x-lifer-client": "1" },
    body: JSON.stringify({ ticket, pluginId: "com.example.lifer-example", scopes: ["userdata.read", "imports.write"] }),
  });
});

// Leave with Lifer.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
```

With the key it reads `GET /api/userdata/v1/species` (sent as `x-api-key`, following `nextCursor`) and imports a folder with `POST /api/imports/v1/folders`, then polls `GET /api/imports/v1/jobs/:id` until `running` is false.

Its page learns Lifer's origin from the `credential` message, and checks every later message against it:

```js
let host = null;
let token = null;
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || msg.lifer !== 1) return;
  if (msg.type === "credential") {
    host = event.origin;
    token = msg.payload.token; // sent as a header on the page's requests to its own server
    return;
  }
  if (event.origin !== host) return;
  if (msg.type === "init") applyTheme(msg.payload.theme);
});
// `ready` carries nothing secret, so it can go out before Lifer's origin is known.
window.parent.postMessage({ lifer: 1, type: "ready", payload: { protocol: 1 } }, "*");

// A request with an id gets one reply; this one opens Lifer's folder picker.
window.parent.postMessage({ lifer: 1, type: "pickFolder", id: "r1", payload: { title: "Choose photos" } }, host);
```

## Privacy

Lifer adds no network calls for companion apps and keeps no usage counts about them. Discovery is local. A running app may make its own network calls, described by its maker, and Lifer can't see or limit them.
