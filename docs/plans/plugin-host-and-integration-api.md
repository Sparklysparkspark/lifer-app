# Plugin host and integration API
**Reviewer model (maintainer, 2026-10-23):** Opus 5.5 reviews security, data and storage, engine and shell process code, models and accuracy, and anything that writes files; Sonnet 5.5 reviews docs, check scripts, wording, simple UI and test-only packages. This overrides the per-package review tag.

> **Calibration (2026-10-22):** effort figures in this plan are conventional engineering time. Lifer's
> measured pace is far faster for coding: about 176,000 lines (desktop, server, web, species matching
> and a 134,000-species catalogue) in roughly six effective weeks. Expect coding work to take a fraction
> of these estimates. Real-world time does not compress: maintainer reviews and decisions, beta periods,
> store review, real-device and real-card testing, and model labelling.

Status: planned, nothing built. Drafted 2026-10-22. Lifer migrations this plan needs are pre-approved
(maintainer, 2026-10-23): claim the next number from the coordinator and list each in the report.


Models: each work package below names who builds it (Opus 5.5 for protocol, security and lifecycle;
Sonnet 5.5 for the rest), and every package gets an Opus 5.5 review before hand-back. Helpers read only
their own package and the sections it links to.

## Why

Lifer should be able to host companion apps that people install separately, without Lifer ever
loading their code or giving them more than the user's own data. A companion app runs as its own
process, shows its screen on a page inside Lifer's desktop window, and talks to Lifer only through a
small public API that any third party could use. Each app stays fully usable on its own.

Out of scope: a plugin store, plugins running inside Lifer's process, plugins in the server's web
interface or a browser.

## Principles

1. **Separate works.** A plugin is its own program and download. Lifer never bundles, loads or links
   plugin code. The page Lifer shows is served by the plugin's own process, like a website.
2. **One public surface.** Plugins use the documented host protocol and the public HTTP API with
   ordinary scoped keys. No private endpoints, no reading Lifer's database or files.
3. **The user's own data only.** The plugin scopes cover the user's life list, targets, seen
   species, their own photos and importing. Catalog data (regional checklists, rarity, seasonality,
   reference photos and vectors, descriptions) is never served under these scopes, enforced by the
   scope and by tests, not by convention. One exception: reference vectors whose source photos are
   CC0 or CC BY, served with their attribution under their own scope.
4. **Nothing leaves the computer unasked.** Lifer adds no network calls for plugins. Discovery is
   local. Installing an offered plugin is a download the user starts, after Lifer says what it
   downloads and from where. Links use plain URLs with no referral tags or identifiers. Lifer keeps
   no usage counts about plugins.
5. **The user is in charge.** Every plugin is approved once before it can read anything, shows in
   Settings > Connected apps, can be revoked in one click, and its sidebar page can be hidden.
   Offers for apps that aren't installed can be turned off too.
6. **Desktop only.** The plugin page and any offer exist only in the desktop app. A server's web
   interface and browser installs never show them. Servers do take API pairings from plugins
   running on another computer.
7. **Lifer is complete without plugins.** No feature of Lifer moves into a plugin, and no Lifer
   screen nags about one.
8. **Maintainer-written.** The plugin host stays maintainer-written unless a contributor agreement
   is in place.

## How it fits together

```
Desktop, plugin opened from Lifer's sidebar

  Lifer shell (Tauri) --launches--> plugin process (its own executable)
        |                                   |
  Lifer window (webview)                    | serves its page on 127.0.0.1:<port>
    Plugin page: <iframe src=plugin page> <-+  (host protocol over postMessage)
        |
  Lifer local API 127.0.0.1:4310 <--HTTP + API key (plugin scopes)-- plugin process

Server, plugin on another computer

  plugin process --HTTPS + API key (plugin scopes)--> Lifer server
  (paired once with a code from the server's Settings > Connected apps)
```

## Components

### 1. Plugin manifest and discovery

A plugin registers itself by writing one JSON manifest into a per-user folder, the same pattern
browsers use for native messaging hosts:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/app.lifer.desktop/plugins/` |
| Windows | `%APPDATA%\app.lifer.desktop\plugins\` |
| Linux | `$XDG_DATA_HOME/app.lifer.desktop/plugins/` (default `~/.local/share/...`) |

Manifest (`<id>.json`, schema version 1):

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `id` | Reverse-DNS id, e.g. `com.example.app` |
| `name` | Display name |
| `publisher`, `homepage`, `support` | Plain https URLs, shown in Connected apps |
| `version` | The plugin's version |
| `executable` | Absolute path per OS (`darwin`, `win32`, `linux`) |
| `protocol` | Host protocol versions it speaks, e.g. `[1]` |
| `page` | `{ label, icon, accent, surface }`: sidebar label, a monochrome SVG path, an accent colour token value, and `surface` `"default"` or `"dark"` (the page asks for the dark surface) |
| `scopes` | API scopes it will ask for at pairing |
| `capabilities` | Optional host features it uses: `pickers`, `notifications`, `imports`, `offersImports` |

Lifer reads the folder at launch and watches it, so installing or removing a plugin shows up without a
restart. A manifest that fails validation is ignored and logged, never shown half-working. The user
approves each plugin's executable path the first time it is launched; a changed path asks again.
The approval is pinned to the signer: the Team ID on macOS; on Windows the leaf certificate's subject
and issuer (not its thumbprint, so a renewal from the same issuer doesn't ask again); the file's
SHA-256 when unsigned and on Linux.

### 2. Launch and lifecycle

- Lifer starts the plugin the first time its page opens (or at Lifer's launch when the user turned on
  "Start with Lifer" for that app), then keeps it running until Lifer quits, so later visits are
  instant.
- Launch: `executable --lifer-host --protocol=1`, with a one-time host ticket in the
  `LIFER_HOST_TICKET` environment variable. The plugin answers on stdout with one line,
  `LIFER_PLUGIN_READY port=<port> page=<path> pageToken=<token>`, the same pattern as Lifer's local
  inference sidecar (`LIFER_INFERENCE_PORT=`). Timeout 30 s, then the page shows a plain error with
  Retry.
- If the plugin is already running (its own window open), the launched process may hand Lifer's
  ticket to the running instance, print the READY line for it and exit 0. Lifer then watches health
  instead of owning the process.
- Stop: Lifer closes the plugin's stdin when it quits, gives it 5 s, then stops the process it
  launched. The launched process must also exit when Lifer's process is gone (`LIFER_WATCH_PARENT_PID`),
  and on Linux Lifer sets `PR_SET_PDEATHSIG` so a force quit leaves no orphan.
- Health: a challenge only the launched process can answer, right after READY and every 10 s while
  the page is visible. A crash (non-zero exit or two failed checks) restarts once automatically; after
  that the page says it stopped and offers Restart. A clean exit (code 0) Lifer didn't ask for means
  the user closed the app: no restart.
- The exact rules are the process contract in section 4.
- A plugin launched by Lifer shows no Dock or taskbar icon of its own (the plugin's job; documented).

### 3. The plugin page

- A sidebar item under the main areas, using the manifest's label and icon, ordered after Lifer's
  own pages. ⌘1 to ⌘9 keep switching Lifer's pages.
- Route `/apps/:id`. The page is a full-bleed sandboxed iframe of the plugin's page URL (no
  `pageToken` in it; the token arrives as the `credential` message), with `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"` and no
  top navigation. While it starts: the shared loader. On failure: the shared EmptyState with the reason
  in plain words and Retry.
- `surface: "dark"` switches the content area to the dark token set with a short cross-fade (none
  with reduced motion). Whether the sidebar dims with it is decided by prototype.
- The shell allows navigation to registered plugin origins (`security.rs`, `on_navigation`), and the
  local API's CSP gains `frame-src` for those origins only. `frame-ancestors` stays `'none'` for
  Lifer's own pages.
- Persistent frames (decided 2026-10-23): each started app's frame is mounted once in the layout
  (`components/PluginFrames.tsx`) and hidden while its page isn't on screen, so the app keeps its
  state between visits; Lifer sends `visibility` on each show and hide. A frame unloads only when its
  app stops (or relaunches, which reloads it).
- Linked server (decided by AD-2 in the companion plan): when the window shows a linked server's
  https pages, no http loopback frame is attempted; the app opens in its own window instead. Today the
  shell's plugin commands answer only Lifer's own pages and `usePlugins` is empty off the local
  library, so a linked window shows no app items and no broken frame. Left to build: a shell command
  `plugin_open_window(id)` that starts the app if needed and opens its page in a new Tauri window
  (same navigation allowlist, the token delivered by the same `credential` message from a small
  bundled host page that frames it, never in the URL), trusted from the configured server's pages;
  then the app items show in a linked window and `/apps/:id` there shows "Opens in its own window"
  with an Open button.
- CSP: `frame-src` allows `http://127.0.0.1:*` in desktop mode rather than each running app's
  port. Accepted (2026-10-23): the shell's `is_plugin_origin` navigation check refuses any port Lifer
  didn't start, and the page token only ever reaches the registered origin through `credential`.

### 4. Host protocol (postMessage, version 1)

Every message is `{ lifer: 1, type, id?, payload }`. Lifer checks `event.origin` against the plugin's
registered origin and the iframe's `contentWindow`; the plugin checks the parent's origin and that
`event.source` is `window.parent`. Unknown types and other versions are ignored. Any plugin message
with an `id` (a string of up to 64 characters) gets exactly one `reply`:
`{ lifer: 1, type: "reply", id, payload: { ok: true, result } | { ok: false, error } }`, where `error`
is `not-allowed` (capability missing or turned off), `invalid` (a known type with a bad payload),
`not-found`, `unsupported`, `failed` or `timeout`. Replies come within 30 s, except the pickers, which
wait for the user. Lifer always posts with the plugin's origin as `targetOrigin`, never `*`.

| Direction | Type | Payload | Meaning |
|---|---|---|---|
| plugin to host | `ready` | `{ protocol }` | Page is up; host sends `init` |
| host to plugin | `credential` | `{ token }` | The `pageToken` from the READY line. Sent right before every `init`, so only after a valid `ready` from the framed window at the plugin's origin, and again after a reload. The only secret in the protocol |
| host to plugin | `init` | `{ protocol, theme, locale, platform, reservedShortcuts, hostVersion, visible }` | Sent after every `ready` (a reloaded page gets it again). `theme` is `{ mode, tokens }`; `platform` is `macos`, `windows` or `linux` |
| host to plugin | `theme` | `{ mode, tokens }` | Theme changed. `tokens` maps CSS custom properties (`--color-canvas`...) to values, as they apply where the frame sits (so a dark surface reads as dark) |
| host to plugin | `locale` | `{ locale }` | Lifer's language changed (BCP 47) |
| host to plugin | `visibility` | `{ visible }` | Page shown or hidden (pause heavy work) |
| plugin to host | `shortcut` | `{ key, code?, meta, ctrl, alt, shift }` | A reserved chord pressed inside the page; host acts on it |
| plugin to host | `navigate` | `{ to: "species", scientificName }` or `{ to: "photo", photoId }` or `{ to: "gallery", query }` | Open a Lifer page. A species Lifer doesn't know replies `not-found`; `photo` replies `unsupported` until Lifer has a page for one photo |
| plugin to host | `title` | `{ text }` | Toolbar title for the page |
| plugin to host | `pickFolder`, `pickFiles` | `{ title? }` | Needs `pickers` and an `id`. Native picker parented to Lifer's window; reply has a path (folder), paths (files) or `null`. One picker at a time: a second request while one is open replies `failed` |
| plugin to host | `reveal` | `{ path }` | Show in Finder, Explorer or the file manager. Local absolute paths only: no UNC or `//` paths (Windows would contact that host with the user's credentials), no `..` segments |
| plugin to host | `openUrl` | `{ url }` | https only, opened in the default browser |
| plugin to host | `notify` | `{ title, body?, action? }` | Needs `notifications`. A quiet notice (the shared toast), with one action that opens the plugin page; a burst from one app collapses into one notice that counts them; off per plugin in Settings |
| host to plugin | `droppedPaths` | `{ paths }` | Needs the `drop` capability. Files or folders dropped on the plugin's frame. Not sent in 1.0: see "Drag and drop" below (open question 7, decided) |

The protocol types live in `packages/shared/src/pluginProtocol.ts`, so the web app and any plugin
author read the same definitions; it also exports `parsePluginMessage`, `chordMatches` and
`chordFromEvent`. Lifer's side is `apps/web/src/lib/pluginHost.ts`.

- **Reserved chords.** `reservedShortcuts` lists every chord Lifer keeps: Mod+1 to Mod+9 (matched by
  `code`, `Digit1`... and `Numpad1`..., so any layout works), Mod+K and Mod+F (search), Mod+, (Settings),
  Mod+I and Mod+Shift+I (Import), and the sidebar chord (Ctrl+Cmd+S on macOS, Ctrl+Alt+S elsewhere).
  Mod is `meta` on macOS and `ctrl` elsewhere, already resolved in the list. The page never binds them:
  on a match it calls `preventDefault()` (so a native menu doesn't run it a second time) and sends
  `shortcut`. Lifer acts only on chords in its own list and ignores the rest.
- **Escape** belongs to the page: it closes the page's own layers first. Lifer has nothing under the
  plugin page for it to close.
- **One secret: `credential`.** The `pageToken` travels only in the `credential` message (maintainer
  decision AD-2), never in the frame's URL, so it stays out of history, logs and `Referer` headers.
  Lifer sends it only in answer to a `ready` that passed both the origin and the source-window check,
  always with the plugin's origin as `targetOrigin`, so a frame that navigated elsewhere never gets
  it. The page accepts it only when `event.source === window.parent`, keeps it in memory, and sends it
  with its own requests to its server. No message carries the host ticket or an API key.
- **Drag and drop (decided 2026-10-23).** Design: the shell gets drag-drop events with paths, and only
  when a drop lands inside the plugin frame's rectangle, the plugin page is on screen, and the
  manifest declares `drop`, Lifer sends `droppedPaths`; every other drop behaves as today. Not built in
  1.0 because Tauri fixes the handler when the window is created (no runtime toggle) and turning it on
  for Lifer's main webview breaks HTML5 drag and drop: on Windows, WebView2 then drops in-page drags
  (Gallery tiles), and everywhere Lifer's own file drop zones (`FilePickArea`, server settings) lose
  `dataTransfer.files`. Two ways to build it later: (a) in the app's own window (linked mode,
  section 3), turn the handler on for that window only, which needs no change to Lifer's pages; (b) in
  the main window's iframe, turn it on for the window and move Lifer's own drop zones to the shell's path events and
  Gallery tile drags to pointer events first. `drop` joins `PLUGIN_CAPABILITIES` (and the manifest
  check in `plugins.rs`) only when it ships.

**Process contract (version 1).** What the process Lifer launches must do, enforced by
`apps/desktop/src-tauri/src/plugins.rs`:

| Step | Rule |
|---|---|
| Launch | `executable --lifer-host --protocol=1` with `LIFER_HOST_TICKET` (64 lowercase hex characters, new per launch, secret) and `LIFER_WATCH_PARENT_PID` (Lifer's process id) in the environment; stdin, stdout and stderr are pipes. |
| READY | One stdout line, `LIFER_PLUGIN_READY port=<port> page=<path> pageToken=<token>`, printed only once the health route below answers. `page` starts with one `/`; `pageToken` is 1 to 512 of `A-Z a-z 0-9 - _ . ~`. Lines longer than 8 KiB on stdout or stderr are ignored. |
| Health request | `GET http://127.0.0.1:<port>/lifer-host/health?nonce=<nonce>`. `nonce` is 64 lowercase hex characters, fresh for every check. |
| Health response | Status 200, `Content-Type: application/json`, body `{"proof":"<hex>"}` (at most 4 KiB), where `proof` is the lowercase hex HMAC-SHA256 with the key set to the bytes of the ticket string exactly as received (not hex-decoded) and the message set to the bytes of the nonce string. Anything else (another status, a redirect, a wrong or missing proof, no answer within 3 s) is unhealthy. |
| When checked | Right after READY (a few tries over about a second, then the start fails with an error), and every 10 s while the page is visible. Two failures in a row count as a crash. |
| Hand-off | A launcher that forwards to an instance that is already running must pass the ticket to that instance before printing READY and exiting 0, over a channel only the same OS user can create or open, and must not hand it to a listener another user could have set up first. macOS and Linux: a Unix domain socket in a folder only the user can write, mode 0700 (for example `$XDG_RUNTIME_DIR` or the app's own data folder; never a Linux abstract socket). Windows: a Unix domain socket in the user's `%LOCALAPPDATA%`, or a named pipe created with `FILE_FLAG_FIRST_PIPE_INSTANCE` and a DACL for the current user only, where the launcher confirms the pipe's server runs as the same user (`GetNamedPipeServerProcessId`) before writing. Never loopback TCP, a file, a command-line argument or a log line. The instance then answers with that ticket, replacing any earlier one; Lifer only knows the newest. A ticket never arrives any other way (not over HTTP, not from the page). |
| Exit | The launched process must exit when its stdin closes or the process named by `LIFER_WATCH_PARENT_PID` is gone (check at least every 2 s). Lifer kills it 5 s after closing stdin. An app that keeps a window open after Lifer leaves does so in a separate instance it starts itself. |
| Exit codes | 0 when the user closed the app: Lifer shows it as closed with Restart and doesn't restart it. Anything else is a crash and restarts once. |

The health route answers only the challenge; it has nothing else to say and needs no `pageToken`.
Lifer loads `page` exactly as printed, with no token added: the plugin serves that page without one
and requires the token (from `credential`) on the page's own requests.

### 5. Pairing and keys

Keys are ordinary rows in `api_keys` (no new table), named after the plugin, carrying only the scopes
the user approved. They appear in Settings > Connected apps with the plugin's name, publisher, scopes
in plain words, last used, and Revoke.

| Where | Flow |
|---|---|
| Desktop, plugin launched by Lifer | The plugin calls `POST /api/plugins/v1/pair` with `{ ticket, pluginId, scopes }`. The first time, Lifer shows a consent dialog: "Allow <name> to read your life list, targets and seen species, and import photos?" with the scopes listed. On Allow, the reply carries the key. Later launches with the same plugin and scopes need no dialog. |
| Desktop, plugin started on its own | The plugin calls `POST /api/plugins/v1/pair-requests` with `{ pluginId, name, scopes }` and shows a 6-digit code. Lifer shows "<name> wants to connect" with the same code, Allow or Deny. The plugin polls `GET /api/plugins/v1/pair-requests/:id` for the key. Requests expire after 5 minutes. |
| Server | The user taps **Pair an app** in the server's Settings > Connected apps, which shows a code valid for 10 minutes. The plugin calls `POST /api/plugins/v1/pair` with `{ code, pluginId, scopes }` over HTTPS (or plain HTTP on the local network, as for the desktop link key). |

- The plugin stores the key in the OS credential store. Lifer stores only its hash.
- Pairing endpoints are rate limited (5 attempts per minute per address) and codes are single-use.
- Multi-user servers: each person pairs with their own account and gets their own data.
- A desktop linked to a server keeps plugins paired with the local desktop API only; the desktop syncs
  as it already does. One connection, no double uploads.

### 6. Desktop gate

Today the desktop API (`auth/desktopGate.ts`) accepts only the shell's launch credential. It gains one
rule: a request carrying `x-api-key` passes the gate when its route requires one of the plugin scopes
below, and `requireScope` then checks the key as on a server. Every other route keeps refusing keys in
desktop mode. The pairing routes join `isPublicApiRoute` and are protected by ticket, code or consent.

### 7. Scopes and endpoints

| Scope | Endpoints | Returns | Never returns |
|---|---|---|---|
| `userdata.read` | `GET /api/userdata/v1/species?since=&cursor=` | One row per species the user has marked or photographed: `speciesId`, `scientificName`, `state` (`photographed`, `seen`), `isTarget`, `firstCollected`, `lastPhotographed`, `photoCount`, `bestRating`, `coverPhotoId`, `updatedAt`; deletions with `deletedAt` | Region, checklist, tier, seasonality, catalog common names, descriptions, reference photos |
| `userdata.read` | `GET /api/userdata/v1/photos/:id/display` | The display image of one of the user's own photos | Any other photo |
| `userdata.read` | `POST /api/userdata/v1/similar` `{ space, vector, speciesId?, limit }` | The user's own photos nearest to a vector in a named open model space, with scores (later phase) | Catalog or reference vectors |
| `imports.write` | `POST /api/imports/v1/folders` `{ path, mode, tripName? }` (desktop) | A background import job of a folder of files; `mode` is `in-place` (file where it is) or `copy` (into the library by the user's folder layout) | |
| `imports.write` | `GET /api/imports/v1/jobs/:id` | Progress and result counts | |
| `imports.write` | The existing resumable upload routes (server) | Accept `imports.write` as an alternative to `photos.write`, for new photos only | Editing existing photos |
| `opendata.read` | `GET /api/opendata/v1/gallery-vectors?space=&since=` and `GET /api/opendata/v1/attribution` | Reference vectors whose photos are CC0 or CC BY, each with licence, photographer and source URL | Any vector with another licence |

- Imports read the files' own XMP marks (ratings, pick and reject, colour labels, through the marks reader trip scans already use)
  and species keywords (`matchSpeciesByKeywords`), exactly as a trip scan does today. The import shows
  in Lifer's normal progress tray and never blocks the window.
- Scientific names are returned as facts so a plugin can match species with its own taxonomy.
- The scopes are offered on the API keys page too, so anyone can build the same integration.
- `opendata.read` depends on the catalog republish's per-vector licence tags
  (`next-catalog-republish.md` item 5g).

### 8. Settings

- **Settings > Connected apps** (desktop and server): each paired app with its scopes, last used, and
  Revoke. On desktop, installed plugins also show "Show in the sidebar" (on), "Start with Lifer"
  (off), "Notices from this app" (on), and Remove (deletes nothing of the plugin's; only unpairs and
  hides).
- **Hide from the sidebar:** the sidebar item's context menu has "Hide <label>", reversible from
  Connected apps. Hiding never uninstalls.
- **Suggested apps:** "Show suggested apps" (on by default) controls offers for apps that aren't
  installed (below). Off removes every offer and every mention of them.

### 9. Suggested apps

Lifer can ship a small, data-only file of suggested plugins, `apps/web/src/data/suggestedApps.json`:
name, one-line description, publisher, homepage, download URL per OS, the installer's expected
signing identity, and the sidebar label and icon. It is empty until the maintainer adds an entry.

- A suggested app shows as a sidebar item with an offer page: what it is, who makes it, a link to its
  site, and **Install**.
- Install first states what it downloads and from where, then downloads in the background with
  progress (never blocking), checks the installer's signature against the expected identity, and runs
  the platform's normal installer. After that the plugin's own manifest takes over.
- No offer is shown in the server web interface or browsers, or when Suggested apps is off. Plain
  URLs only. Lifer contacts nobody except the download the user started.

### 10. Imports a plugin offers

A plugin with `offersImports` can answer `GET http://127.0.0.1:<port>/lifer-host/imports` with a list
of past work (name, date, folder, file count). Lifer's first run and its Import menu can list these as
"Bring in your work from <name>". Choosing one asks the plugin to export it to a folder with XMP, then
imports that folder through `imports.write`. Lifer's own recognition only fills gaps the files'
metadata leaves.

## Data rules

- A response-schema test per plugin route asserts the absence of catalog-derived fields (any key
  matching `region`, `checklist`, `tier`, `rarity`, `season`, `weekly`, `reference`, `description`,
  `commonName`).
- An integration test seeds catalog data and NC-licensed vectors and asserts none appear under any
  plugin scope.
- No new analytics or counters. `api_keys.last_used_at` already exists and stays the only record.

## Work packages

Each package is sized for one worker session. Standing rules for every package: never commit, branch
or stash; no em dashes anywhere (copy, comments, docs); short why-comments; tests use `lifer_test`,
never the Docker `lifer` database; migrations for spec'd work are pre-approved (claim the number, list it in the report); shared
components and design tokens (the check scripts must pass); `ux-rules.md` plus a screenshot HIG review
for UI; design for extremes; never block the user; zero config; lockfile changes only with
`npx -y npm@11`; targeted edits only, since other sessions may own uncommitted changes; don't rebuild
the desktop dev app while other workers are editing `apps/web` or `apps/api`.

### L-01 Plugin manifest and discovery

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the shell finds installed plugins and exposes them to the web app.
- **Scope in:** manifest schema v1, per-OS folder, validation, folder watch, `plugins_list` command,
  first-launch path approval record. **Out:** launching, UI.
- **Files:** `apps/desktop/src-tauri/src/plugins.rs` (new), `src/lib.rs` (register commands),
  `permissions/app-commands.toml`, `capabilities/default.json`, `packages/shared/src/pluginManifest.ts`
  (types shared with the web app).
- **Depends on:** none.
- **Contracts:** manifest table in section 1; command returns `{ id, name, page, scopes, approved }[]`.
- **Steps:** define serde structs mirroring the TS type; read and validate on launch; poll the folder
  every 5 s (no new dependency); store approvals in the
  existing desktop config store (`store.rs`).
- **Tests:** Rust unit tests for valid, invalid, duplicate id, missing executable, per-OS paths; the
  existing `every_registered_command_is_permitted` test covers the new command.
- **Acceptance:** dropping a manifest in the folder makes it appear in `plugins_list` within 5 s on
  all three OSes; a broken one is logged and skipped.
- **UX checks:** none (no UI).
- **Data checks:** none.
- **Risks:** Windows path casing; Linux without `XDG_DATA_HOME`.
- **Parallel with:** L-04, L-06, L-07, L-12, L-14.

### L-02 Plugin launch and lifecycle

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** start, watch and stop a plugin process safely.
- **Scope in:** launch with ticket, READY line parsing, attach to an already running instance, health
  polling, one automatic restart, stop on quit with stdin close and 5 s grace, Windows updater exit
  path. **Out:** the page itself.
- **Files:** `src/plugins.rs`, `src/lib.rs` (exit handler next to `StopApiOnDrop`), reuse the sidecar
  patterns in `src/local_inference.rs` and `src/api.rs`.
- **Depends on:** L-01.
- **Contracts:** section 2; command `plugin_start(id) -> { origin, pageUrl, pageToken }`, `plugin_status(id)`.
- **Steps:** mint a 32-byte ticket per launch (as `random_token`); spawn with `tauri_plugin_shell`;
  parse stdout; keep ticket in memory for L-08; generation counter against stale exits.
- **Tests:** Rust tests with a stub plugin binary (a tiny script from L-13) for ready, timeout, crash,
  restart once, attach mode; manual quit test on each OS.
- **Acceptance:** no orphan plugin process after quit, force quit or update on any OS; a crashing
  plugin restarts once then reports stopped.
- **UX checks:** P6 (never freezes the shell), F1.
- **Data checks:** none.
- **Risks:** Windows process trees; plugins that ignore stdin close.
- **Parallel with:** L-04, L-06, L-07.

### L-03 Plugin page in the desktop web app

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** a sidebar page that shows the plugin's screen.
- **Scope in:** sidebar item from the manifest, `/apps/:id` route, `PluginFrame` with sandbox,
  loading, error and stopped states, dark surface switch, shell navigation and CSP `frame-src` for
  registered origins, the linked-mode spike. **Out:** the protocol messages beyond `ready` and `init`.
- **Files:** `apps/web/src/components/AppSidebar.tsx`, `apps/web/src/App.tsx` (route),
  `apps/web/src/pages/PluginPage.tsx` (new), `apps/web/src/components/PluginFrame.tsx` (new),
  `apps/web/src/lib/plugins.ts` (new), `apps/web/src/locales/en.json`, `apps/api/src/index.ts` (CSP),
  `apps/desktop/src-tauri/src/security.rs`, `src/lib.rs` (`on_navigation`).
- **Depends on:** L-01, L-02.
- **Contracts:** section 3; only shown when `useDeploymentMode()` is `desktop` and inside Tauri.
- **Steps:** add the item after the main areas using the shared sidebar link; render PluginFrame
  full-bleed under the toolbar; switch tokens when `surface` is dark; extend `is_local_api` checks
  with `is_plugin_origin`; add `frameSrc` from the registry; run the https-parent spike and write the
  result into this doc.
- **Tests:** web unit tests for states; e2e with the example plugin (L-13): item appears, page loads,
  stopped state shows Retry, Back returns to the previous page.
- **Acceptance:** opening the page a second time shows the plugin with no loader; the sidebar,
  traffic lights and drag region behave as on every other page.
- **UX checks:** C1, C6, C8, P1, P2, P5, S3, S6, N1, N5, X1, X2, X4, T1, L1; HIG screenshot review in
  light and dark at the smallest window and on a 27 inch window; extremes: a 60-character label, 10
  plugins, a plugin that never answers.
- **Data checks:** none.
- **Risks:** iframe navigation handling differs per webview; keyboard focus inside the iframe.
- **Parallel with:** L-06, L-07, L-09.

### L-04 Host protocol

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the typed postMessage protocol between the plugin page and Lifer.
- **Scope in:** types, origin checks, request and reply, `init`, `theme`, `visibility`, `shortcut`,
  `navigate`, `title`, pickers via the shell, `reveal`, `openUrl`, `notify` into the status tray,
  `droppedPaths`. **Out:** pairing.
- **Files:** `packages/shared/src/pluginProtocol.ts` (new), `apps/web/src/lib/pluginHost.ts` (new),
  `apps/web/src/components/StatusTray.tsx` (notices), `apps/web/src/components/PluginFrame.tsx`.
- **Depends on:** L-03 for wiring; the types can start at once.
- **Contracts:** section 4 table, version 1; unknown types ignored; replies within 30 s or an error.
  The process contract in section 4 (health challenge, hand-off, exit) is fixed by L-02b; document
  it for plugin authors in `pluginProtocol.ts` (route, `nonce`, `{ proof }`) and change it only
  together with `plugins.rs`.
- **Steps:** write the types; a small dispatcher with an allowlist per manifest `capabilities`; map
  `navigate` to existing routes (species by scientific name lookup); route pickers through the
  existing dialog plugin; `notify` uses the shared toast and status tray components.
- **Tests:** unit tests for origin rejection, unknown types, each message; e2e with the example
  plugin for navigate, picker (stubbed), shortcut forwarding of ⌘1.
- **Acceptance:** a message from any other origin or frame is dropped; ⌘1 inside the plugin page
  opens Collection.
- **UX checks:** M3 (Escape peels one layer: the plugin first), X3, X7, F6; extremes: a burst of 100
  notices collapses into one.
- **Data checks:** none.
- **Risks:** shortcut double-handling; drag and drop paths with the drag handler disabled.
- **Parallel with:** L-06, L-07, L-08.

### L-05 Navigation allowlist and CSP hardening review

**Status:** built (2026-11-04): origin check and CSP tested (frame-src only in desktop mode)

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** confirm that only registered plugin origins can load, and nothing widens for Lifer's own
  pages.
- **Scope in:** review and tests of L-03's shell and CSP changes, `frame-ancestors` unchanged, plugin
  origins limited to `http://127.0.0.1:<port>` reported by the READY line. **Out:** new features.
- **Files:** `apps/desktop/src-tauri/src/security.rs` tests, `apps/api/src/index.ts` tests.
- **Depends on:** L-03.
- **Contracts:** principle 1 and section 3.
- **Steps:** add Rust tests for allowed and refused URLs; an API test that CSP contains `frame-src`
  only in desktop mode and only for running plugins.
- **Tests:** as above.
- **Acceptance:** a page at any other loopback port or host can't load in the window or frame.
- **UX checks:** none.
- **Data checks:** none.
- **Risks:** a plugin port change after restart; the CSP must update without an API restart.
- **Parallel with:** L-08, L-09.

### L-06 Plugin scopes and user-data endpoints

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** `userdata.read`, `imports.write`, `opendata.read` and the `userdata` routes.
- **Scope in:** add the scopes to `API_KEY_SCOPES` and the API keys page; `GET /api/userdata/v1/species`
  with `since` and cursor; photo display for the user's own photos; response schemas; OpenAPI; docs.
  **Out:** `similar` (later), imports (L-10), open vectors (L-12).
- **Files:** `apps/api/src/auth/apiKeyRoutes.ts`, `apps/api/src/userdata/routes.ts` (new),
  `apps/api/src/userdata/responses.ts` (new), `apps/api/src/apiRoutes.ts`,
  `apps/web/src/pages/ApiKeysPage.tsx` (scope labels), `apps/web/src/locales/en.json`,
  `docs/docs/api/overview.md`, `apps/api/src/integrations/openapi.ts` if needed.
- **Depends on:** none.
- **Contracts:** section 7 table; paging like `GET /api/captures`; deletions from `sync_tombstones`
  where species marks are removed.
- **Steps:** query `user_species` joined to `species` for `scientific_name` only; cover photo id
  only when the photo is the user's; reuse `requireScope`.
- **Tests:** integration tests on `lifer_test`: paging, since, deletions, other users' data refused,
  the field-absence test, the seeded-catalog leak test.
- **Acceptance:** a key with only `userdata.read` can read the species list and own cover images and
  gets 401 on every other route.
- **UX checks:** W3 and W8 for the scope labels on the API keys page.
- **Data checks:** the data rules section; no catalog-derived field in any response.
- **Risks:** `species.state` naming drift; heavy users with thousands of rows (page at 500).
- **Parallel with:** L-01 to L-05.

### L-07 Desktop gate accepts plugin keys

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** keys with plugin scopes work against the desktop's local API, nothing else does.
- **Scope in:** gate rule, `requireScope` path in desktop mode, pairing routes as public routes.
  **Out:** pairing logic.
- **Files:** `apps/api/src/auth/desktopGate.ts`, `apps/api/src/auth/publicRoutes.ts`,
  `apps/api/src/auth/session.ts`, `apps/api/src/auth/desktopMode.test.ts`.
- **Depends on:** L-06 (scope names).
- **Contracts:** section 6.
- **Steps:** read the matched route's scope from the hook metadata (`routeCatalog` already records
  it); allow `x-api-key` only when that scope is a plugin scope.
- **Tests:** desktop-mode tests: plugin key on a plugin route passes, on any other route 401, no key
  401, launch credential unchanged.
- **Acceptance:** all existing desktop-mode tests pass unchanged.
- **UX checks:** none.
- **Data checks:** none.
- **Risks:** routes whose scope is set dynamically; keep the rule to the static hook metadata.
- **Parallel with:** L-03, L-04, L-08.

### L-08 Pairing

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the three pairing flows and the consent dialog.
- **Scope in:** `POST /api/plugins/v1/pair` (ticket or code), pair requests with a 6-digit code,
  server pairing codes, consent dialog on desktop, rate limits, key creation in `api_keys`.
  **Out:** Connected apps list (L-09).
- **Files:** `apps/api/src/plugins/pairing.ts` (new), `apps/api/src/plugins/routes.ts` (new),
  `apps/api/src/apiRoutes.ts`, `apps/web/src/components/PairingConsentModal.tsx` (new, built on Modal),
  `apps/web/src/locales/en.json`, the shell ticket check via a command or the local credential.
- **Depends on:** L-02 (tickets), L-06, L-07.
- **Contracts:** section 5. Pairing state (tickets, requests, codes) lives in memory with expiry, so
  no migration.
- **Steps:** tickets validated by the shell (command `plugin_ticket_valid`) or passed to the API at
  launch through the existing launch-token channel; consent dialog is the shared Modal with one
  primary action; codes are 6 digits from a CSPRNG, single-use.
- **Tests:** integration tests for each flow, expiry, reuse, rate limit, wrong scopes; e2e with the
  example plugin through consent.
- **Acceptance:** approving once pairs; a second launch pairs silently; Deny leaves no key; revoking
  in L-09 makes the plugin's next call 401.
- **UX checks:** W3, W5, W8, D2, M3, M4, N5; HIG review of the consent dialog; extremes: a plugin
  asking for every scope, a 200-character name.
- **Data checks:** consent text lists exactly the scopes requested.
- **Risks:** a consent dialog over a plugin page that is itself waiting; keep the dialog in Lifer's
  layer above the iframe.
- **Parallel with:** L-09, L-10.

### L-09 Connected apps and hide settings

**Status:** built (2026-11-04): Remove and Notices rows in Connected apps, unit test 3/3; light-mode screenshot only

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the user sees, controls and hides every plugin.
- **Scope in:** Settings > Connected apps panel, per-plugin toggles, sidebar context menu "Hide",
  Suggested apps toggle, Remove. **Out:** offers (L-11).
- **Files:** `apps/web/src/pages/settings/IntegrationsSettings.tsx` (or a new
  `ConnectedAppsSettings.tsx` registered in `pages/settings/groups.ts`), `apps/web/src/components/AppSidebar.tsx`,
  `apps/web/src/components/Menu.tsx` use, `apps/web/src/locales/en.json`.
- **Depends on:** L-01, L-08.
- **Contracts:** section 8; settings stored with the existing settings mechanism (`useServerSetting`)
  or the desktop config store, no migration.
- **Steps:** grouped panel with divided rows, label left, control right; Revoke confirms (destructive);
  hide is immediate with an Undo toast.
- **Tests:** web unit tests; e2e: hide from the context menu, item gone, restore from Settings; revoke
  ends the plugin's access.
- **Acceptance:** hiding removes every mention of that plugin from the sidebar; server mode shows only
  paired apps and the pairing code button.
- **UX checks:** C1, C2, L3, L5, F3, D2, W5, A1; HIG review; extremes: 20 apps, long names.
- **Data checks:** none.
- **Risks:** none notable.
- **Parallel with:** L-10, L-11.

### L-10 Folder import hand-off and plugin-offered imports

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** a plugin can ask Lifer to import a folder of files, and Lifer can list a plugin's past work
  to bring in.
- **Scope in:** `POST /api/imports/v1/folders` (desktop), job status, `imports.write` on resumable
  uploads (server, new photos only), reading XMP marks and keywords, the "Bring in your work" list.
  **Out:** any new grouping data in Lifer.
- **Files:** `apps/api/src/imports/routes.ts`, reuse `apps/api/src/trips/scan.ts`,
  `apps/api/src/trips/import.ts`, `apps/api/src/library/` (in-place import), the existing XMP marks reader in `apps/api/src/uploads/`;
  web: the Import menu and first-run step.
- **Depends on:** L-06, L-07.
- **Contracts:** section 7 and section 10.
- **Steps:** wrap the existing scan and import with the user's defaults (destination, layout,
  duplicates); `mode: in-place` registers files where they are if they sit under a library root, else
  copies; job progress in the existing tray.
- **Tests:** integration tests on `lifer_test` with a fixture folder carrying XMP picks, rejects,
  labels and species keywords; duplicates skipped; a moved folder; a path outside allowed roots refused.
- **Acceptance:** importing a folder of 1,000 files runs in the background, the window stays
  responsive, and marks and species arrive as from a trip scan.
- **UX checks:** F1, F2, F4, F5, P6, S1; extremes: 20,000 files, a file that vanishes mid-import.
- **Data checks:** none.
- **Risks:** in-place imports of folders outside library roots; decide the rule with the maintainer.
- **Parallel with:** L-09, L-11, L-12.

### L-11 Suggested apps

**Status:** built (2026-11-04): suggested-apps e2e inside plugins.spec; real install path needs Rust tests in plugins.rs

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** an honest offer page and a safe one-click install for a suggested plugin.
- **Scope in:** the data file (empty in the repo), offer page, download with progress, signature
  check, platform installer launch, Suggested apps toggle. **Out:** any entry's content (added later
  by the maintainer).
- **Files:** `apps/web/src/data/suggestedApps.json` (new, `[]`), `apps/web/src/pages/PluginOfferPage.tsx`
  (new), `apps/desktop/src-tauri/src/plugins.rs` (download, verify: macOS `codesign` team id, Windows
  Authenticode subject, Linux a detached minisign signature).
- **Depends on:** L-03, L-09.
- **Contracts:** section 9.
- **Steps:** say what is downloaded and from where before any download; reuse the shared progress bar;
  never auto-install.
- **Tests:** unit tests for the signature check with test certificates; e2e with a fake entry pointing
  at a local test server.
- **Acceptance:** with Suggested apps off, nothing about any offer is visible anywhere; a tampered
  installer is refused with a plain message.
- **UX checks:** W5, W6, L5, F6, S1, A3; HIG review; extremes: no network, slow download, cancel.
- **Data checks:** no identifiers in URLs; no request before the user presses Install.
- **Risks:** Linux has no common installer format; AppImage placement needs a decision.
- **Parallel with:** L-10, L-12.

### L-12 Open reference vectors endpoint

**Status:** built (2026-11-04): /api/opendata/v1/gallery-vectors and /attribution serve CC0, public-domain and CC BY only; computed_at index would need a migration

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** serve only the CC0 and CC BY reference vectors, with attribution.
- **Scope in:** `opendata.read` routes, filter by per-vector licence tag, attribution document.
  **Out:** the catalog pipeline work that adds the tags (catalog republish item 5g).
- **Files:** `apps/api/src/opendata/routes.ts` (new), `apps/api/src/apiRoutes.ts`, docs.
- **Depends on:** catalog republish 5g (the licence columns need an approved migration), L-06.
- **Contracts:** section 7; vector format as `galleryEmbeddingsFormat.ts`.
- **Steps:** select vectors where licence in (`cc0`, `cc-by`); stream in pages; attribution lists
  photographer, licence and source per vector.
- **Tests:** integration test with mixed-licence seeded vectors: only open ones returned.
- **Acceptance:** zero NC vectors in any response.
- **UX checks:** none.
- **Data checks:** licence filter is a whitelist, never a blacklist.
- **Risks:** depends on the republish timeline.
- **Parallel with:** L-01 to L-11.

### L-13 Example plugin and end-to-end tests

**Status:** built (2026-11-04): example plugin and plugins.spec pass 8/8 with --no-deps; Windows cannot launch the .mjs directly

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** a tiny open example plugin that proves the whole surface and doubles as documentation.
- **Scope in:** a Node script that writes a manifest, prints READY, serves a page speaking protocol
  v1, pairs, reads `userdata.read`, imports a fixture folder; Playwright specs. **Out:** anything
  beyond the documented surface.
- **Files:** `e2e/fixtures/example-plugin/` (new), `e2e/tests/plugins.spec.ts` (new),
  `e2e/support/` helpers.
- **Depends on:** L-01 to L-10 for full coverage; start with discovery and page.
- **Contracts:** sections 1 to 10.
- **Steps:** run the API in desktop mode in tests with a stub for the shell commands; cover hide,
  revoke, consent, navigate, shortcut, import.
- **Tests:** the specs themselves.
- **Acceptance:** CI runs the specs on macOS, Windows and Linux runners.
- **UX checks:** screenshots of the plugin page states for review.
- **Data checks:** the leak test runs through the example plugin's key.
- **Risks:** shell behaviour can't run in Playwright; keep Rust behaviour in Rust tests.
- **Parallel with:** L-14.

### L-14 Developer and privacy docs

**Status:** built (2026-11-04): plugins.md example section and privacy sentence added

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** public docs so anyone can build a plugin, and a privacy note.
- **Scope in:** `docs/docs/api/plugins.md` (manifest, launch, protocol, pairing, scopes, data rules,
  example plugin), the privacy page line "Lifer itself never contacts any plugin's maker; a plugin you
  add may make its own network calls, described by its maker". **Out:** anything about a specific
  plugin.
- **Files:** `docs/docs/api/plugins.md` (new), `docs/docs/api/overview.md` (link), the privacy page.
- **Depends on:** L-01 to L-12 settled.
- **Contracts:** this document.
- **Steps:** write in the docs' house style; examples from the example plugin.
- **Tests:** `check:em-dashes`; docs build.
- **Acceptance:** a developer can build the example plugin from the docs alone.
- **UX checks:** W1, W3, W6.
- **Data checks:** none.
- **Risks:** none.
- **Parallel with:** L-13.

## Order

```
L-01 --> L-02 --> L-03 --> L-04
                    \--> L-05
L-06 --> L-07 --> L-08 --> L-09 --> L-11
          \--> L-10
L-12 (after catalog republish 5g)
L-13 grows with each package; L-14 last
```

Rough size: about 3 to 4 weeks for one developer, with L-12 waiting on the catalog republish.

## Open questions

1. Decided (AD-2): on a linked server's https pages the app opens in its own window; see section 3.
2. Scope names: `userdata.read`, `imports.write`, `opendata.read`, or names closer to the existing ones
   (`collection.read` is broader and includes region progress, so it can't be reused as is)?
3. In-place folder imports outside library roots: allow, ask, or always copy?
4. Should imported photos record which connected app they came from (a small badge)? That needs a
   migration.
5. Decided: yes, under a narrow `userdata.write` scope (rating, pick or reject, colour label, a
   species' card photo and crop, and a "needs a better photo" mark), each change logged under the
   app's name and undoable in Settings > Connected apps; see docs/docs/api/plugins.md.
6. Linux installs for suggested apps: AppImage into `~/Applications`, or a deb the user opens?
7. Decided 2026-10-23: `droppedPaths` stays in version 1 behind a `drop` capability and is not sent in
   1.0; see "Drag and drop" in section 4 for the design and the two ways to build it.
