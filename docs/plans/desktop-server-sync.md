# Desktop and server: one library, every way in

Status: built 2026-10-17, conflict rule, deletions and cursor fixed 2026-10-20, uncommitted. This page now describes what was built; the original plan's unbuilt parts are listed under [Not built](#not-built). The contributor-facing reference is the sync section of `docs/docs/contributing/state-and-sync.md`. Not verified on a built app against a real server: the cookie handoff, the native pack dialog, and a full push and pull.

## Goal

Anyone running a Lifer server should prefer to reach it through the desktop app, because the app does the heavy work (reading files, RAW previews, species matching) on their own hardware. When the server is unreachable, the app keeps working on a local copy, and whatever they add or change goes to the server by itself when it is back. Whether they started on the desktop and built a server later, or started with a server and installed the app later, the result is the same library with nothing lost.

## Before this work (the 2026-10-17 trace)

The desktop window pointed at one backend at a time and the two libraries never talked. The user signed in twice when connecting. Packs were never reconciled. The old Migrate uploaded original files only and recorded what it sent by URL in `capture_migrations`. Change tracking was `captures_all.updated_at` alone.

## Journeys the design must make smooth

| # | Journey | What must happen |
|---|---|---|
| A | Desktop only, never a server | Nothing changes. No sync code runs. |
| B | Server first, desktop installed later | Sign in once. Packs on either side are offered to the other. The app becomes the fast client. Local copy fills in the background. |
| C | Desktop first, server built later | "Move this library to the server" pushes photos, packs and every edit. Local library becomes the mirror. Nothing is deleted. |
| D | Away from home, server unreachable | App opens the local copy with the full collection. New photos import locally with local matching. On return, everything pushes without asking for anything. |
| E | Two desktops on one server (laptop and desktop) | Both are mirrors. Each pushes its own changes. The newest edit wins per capture; photos dedup by fingerprint. |
| F | Server address changes, or home and away URLs | The server is known by its instance id, not its URL. Any URL that answers with that id is the same server. |
| G | Library already moved with the old Migrate | `capture_migrations` rows are converted to the new record on first connect, so nothing re-uploads. |
| H | Server reinstalled from scratch (new instance id) | Treated as a new server: offer the full move again. The old mirror record is kept until the user confirms. |
| I | Sign out, switch server, remove data | Mirror and outbox for that server are removed; local-only photos are never deleted without the existing "Delete local files" confirmation. |

## How it works

1. **The server is the library. The desktop's database is a mirror plus whatever was imported there.** Rows carry `origin` (`local` or `mirror`, migration 149). A mirrored row has metadata and a small derivative (`thumb`, or also `medium`), never the original. A local row is pushed until the server has it.
2. **A server is identified by an instance id** (`install_settings`, migration 148), reported on `GET /health`. URLs are just ways to reach it; any address that answers with the id is the same server. Linking to another instance drops the mirror and makes everything local due for a push again (`adoptServer` in `sync/mirror.ts`).
3. **The desktop's local API talks to the server with an API key.** After the window signs in (the shell hands the login's cookies to the webview, so the user signs in once), the server's page calls `POST /auth/desktop-link` and gives the key to the shell, which writes `<app data>/app-data/server-link.json` (`server_link.rs`). Scopes: `sync`, `species.read`, `photos.read`, `photos.write` (uploads go through the import routes). The key goes only over https or plain http on this computer or the local network. Signing out or switching server revokes it, retried at each launch until the server answers.
4. **Change tracking is `updated_at` plus `pushed_at`, and tombstones for deletes.** Touch triggers stamp `updated_at` but skip bookkeeping-only updates (migrations 150 and 152), so recording a push or taking the server's copy never echoes. A row is due while `pushed_at` is null or older than `updated_at`. Captures and species marks deleted outright leave a row in `sync_tombstones` (migration 152), skipped for deletes sync makes itself.
5. **Conflicts: the newest edit wins, judged against the version each side last saw.** A pushed capture carries the server's `updated_at` the desktop last had; the server writes it only if its row hasn't changed since, else it answers `conflict` with its copy and the desktop takes it at once. A push never un-trashes a capture unless the desktop had seen the trashed version. A fingerprint match with no server version is a conflict. The pull never overwrites a local row with an edit not pushed yet. No two clocks are ever compared.
6. **The cursor never skips a row.** `/sync/changes` pages by `(updated_at, id)` and serves only rows stamped before the oldest transaction open on the server, so a long import delays the mirror instead of being missed.

## What was built

| Phase | What exists |
|---|---|
| 0 identity | Instance id on `/health`; `sync` scope; `POST /auth/desktop-link`; the shell confirms the id at every address. |
| 1 sign-in | One sign-in: `test_login` returns the session cookies for the webview. The key handoff above. |
| 2 packs | `sync/packs.ts`: packs only the desktop has are started on the server by its own download from the pack store; packs only the server has are offered in a native dialog and downloaded here on a yes. Photos come from the pack store on both sides, never over the LAN. |
| 3 local work | The push sends vectors computed on this computer with each upload, which the server verifies against its own versions and the file's hash. |
| 4 mirror | `GET /sync/changes` (captures, trashed ones included, and purged ids from tombstones) and `GET /sync/user-species` (every mark, sent whole); `sync/mirror.ts` applies them, keeping files six at a time and the cursor in `install_settings`. Settings > Server picks thumbnails or medium copies. A linked app with no server reachable opens this library. |
| 5 push | `POST /sync/push`: desktop deletions first, then captures in batches of 100 (an unknown one is uploaded like any import, then its metadata pushed again), then species marks with their deletions. A failed upload is logged, stays due and fails the job. "Move my library" is the first push of a never-linked library. Deleting the local copy is a separate, gated step (`deleteLibraryGate.ts`). |
| 6 one experience | Settings > Server shows the push and mirror state; the shell runs packs, push, then pull after every connection and every 30 minutes, restarting the local API if it stopped. |

## Journey checks

Each journey is covered by an automated test, a manual script, or both. Manual scripts run on a built desktop app against a Docker server.

| # | Automated | Manual script |
|---|---|---|
| A | none: no code runs when unlinked (`sync.rs` returns at once) | Fresh app, no server. Open Settings > Server: no Sync group. Import a photo. Nothing in the log mentions sync. |
| B | `sync/packs.test.ts`, `sync/mirror.integration.test.ts` | Install the app, sign in to a server with photos. Packs are offered, the collection appears in the local library after the first pull. |
| C | `sync/push.integration.test.ts`, `sync/pushRun.integration.test.ts`, `sync/libraryMirror.integration.test.ts` | Build a library with albums and trips, link a new server. Everything arrives, albums and trips included, and the local copy stays. |
| D | `server_watch.rs` fallback is manual only | See "Journey D manual script" below. |
| E | `sync/journeys.integration.test.ts` (laptop, desktop and server, three databases: albums, trips, membership and species corrections both ways, renamed on both, deleted on one, nothing echoes); the conflict rule in `sync/push.integration.test.ts`, `sync/library.integration.test.ts` | Two apps on one server. Rename one album on both while one is offline: the newest edit wins on both. Delete a trip on one: it goes from the other. |
| F | `sync/serverLink.test.ts` (another server at an address, no proof) | Reach the server by two addresses; the same library either way. |
| G | `sync/journeys.integration.test.ts` (a photo the old Migrate copied is matched by fingerprint, gets the server's id, and is not uploaded again) | Copy a library to a server with an old build's Migrate, then link with this build: the push log shows 0 uploaded. |
| H | `sync/libraryMirror.integration.test.ts` (asks, keeps everything, then starts over) | Reinstall the server, reconnect. Settings > Server says "This server looks new" and nothing changes until you click Send my library to it. |
| I | `server_link.rs` unit tests | Sign out: the key leaves Linked devices on the server and the mirror goes. Local-only photos stay. |

### Journey D manual script

On a built desktop app linked to a Docker server, with at least one album and one mirrored photo:

1. Stop the server (`docker compose stop api`). Quit and reopen the app.
2. The app opens this computer's library: the collection, albums and photos are all there, and Settings > Server says the server can't be reached, in plain words.
3. Import one photo. It is matched to a species on this computer.
4. Create an album named "Away test" and add the new photo and one mirrored photo.
5. Settings > Server shows the photo and the album waiting to sync.
6. Start the server (`docker compose start api`). Within a minute the app offers to switch back; accept.
7. The push runs without asking anything else. On the server's web page, the photo is there with its species and "Away test" holds both photos. Settings > Server shows nothing waiting.

## Not built

- Extra species on a photo and iNaturalist links don't sync in either direction. Species name choices after a split (`species_split_kept`) do: `/sync/species-split-kept`, `speciesSplitKept` in the push.
- No byte cap on the mirror (`mirror_max_bytes`), no "collected species first" order for downloads.
- RAW previews, video posters and the working image are still made on the server.
- No `capture_migrations` conversion (journey G): the old Migrate is gone and its table is unused; a library moved with it is matched again by fingerprint.

