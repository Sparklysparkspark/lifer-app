# Lifer-managed install of the Cull app

> **Superseded (2026-11-25).** The maintainer dropped the managed install (L1 to L5). Lifer is a launcher for third-party apps instead: it downloads the publisher's own signed installer from a compiled-in feed, checks it and opens the system installer, then finds and opens the installed app through the host hand-off. Lifer never unpacks or runs the program itself. See `docs/docs/contributing/plugins.md`. This file stays for its threat model and history.

Internal plan. Lifer's side of the contract in preen-app `docs/plans/lifer-managed-install.md` (branch `managedinstall`, 684222a). This document may name Preen; the shipped Lifer code, copy and docs may not, beyond the existing Cull entry in `suggestedApps.json` and its offer page. Everything Preen-specific reaches Lifer as data in that entry (names, ids, paths, keys), never as code or strings in Rust or TypeScript. No Preen code or data is copied here.

Field names marked **(proposed)** are Lifer's proposal to the Preen session; the Preen plan's names were intent only.

## 1. What exists today

| Piece           | File                                                                                                                    | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install         | `apps/desktop/src-tauri/src/plugin_install.rs`                                                                          | `plugin_install(appId, url, signer, signatureUrl)` downloads into `<Lifer data>/downloads/apps/<id>/` (https only, 4 GB cap, cancel, progress), checks the code signer (macOS Team ID via `codesign`, Windows Authenticode subject+issuer) or a detached minisign signature (Linux), then opens the system installer.                                                                                                                                               |
| Trust anchors   | `apps/web/src/data/suggestedApps.json`, `apps/web/src/lib/suggestedApps.ts`                                             | One entry, `app.preen.desktop`. `downloads.{darwin,win32,linux}` with `signer: "PLACEHOLDER"`, `pending: true` (offer shows "Available soon"). **The signer and URL are passed from the web page to Rust** in the invoke call.                                                                                                                                                                                                                                      |
| Plugin host     | `apps/desktop/src-tauri/src/plugins.rs`                                                                                 | Rescans `<Lifer data>/plugins/*.json` every 5 s; `executable{os}` must be absolute; approval (`plugin-approvals.json`) pinned to signer or sha256; launches with `--lifer-host --protocol=1`, `LIFER_HOST_TICKET`, `LIFER_WATCH_PARENT_PID`, piped stdio, READY line; Windows Job object, Linux `PR_SET_PDEATHSIG`, Unix process group. Only `stop_all()` exists; no per-plugin stop. Can attach to an instance the plugin runs itself (`Running.process == None`). |
| Remove all data | `apps/desktop/src-tauri/src/remove_data.rs`, `apps/web/src/pages/settings/StorageSettings.tsx` (`RemoveAllDataSection`) | Native confirm, then deletes app data, local data, cache, logs, `~/Library/WebKit/app.lifer.desktop`. Keeps `<app data>/data` (the default photo library) and **the whole `<app data>/plugins/`**. Stops the API and local inference, **not plugins**.                                                                                                                                                                                                              |
| Offer page      | `apps/web/src/pages/PluginOfferPage.tsx`                                                                                | Grants scopes, runs `plugin_install`, progress bar, Cancel; offer hidden once a manifest with the id exists (`useSuggestedApps`).                                                                                                                                                                                                                                                                                                                                   |
| Updater         | `tauri.conf.json`, `release.yml`                                                                                        | Tauri updater with a minisign pubkey; `TAURI_SIGNING_PRIVATE_KEY` in CI. NSIS, app, deb, AppImage targets. **No NSIS hooks exist.** Windows signing through SignPath.                                                                                                                                                                                                                                                                                               |
| Crates          | `Cargo.toml`, `Cargo.lock`                                                                                              | `minisign-verify 0.3`, `sha2`, `reqwest`, `semver` direct or in the lock; `tar 0.4`, `flate2`, `zip`, `xattr` are already in `Cargo.lock` through `tauri-plugin-updater`, so adding them as direct dependencies adds no new code to the tree. No keyring crate.                                                                                                                                                                                                     |

## 2. Shape of the change (one paragraph)

The Cull entry gains a `managed` block holding only trust anchors (feed URL, minisign keys, signer, per-platform program paths). Rust reads that block from the compiled-in JSON, never from the page. Install and update share one path: fetch the feed, pick this platform's entry, download, verify (size, sha256, minisign with version and target in the signed trusted comment, unpacked code signature, macOS notarisation), unpack safely into `app.new/`, swap into `app/`, write `managed.json`. The plugin host treats `plugins/<id>/managed.json` as authoritative for which program runs. Removal is one Rust command used by the Storage row, by Remove all data, and mirrored by the Windows uninstaller hook.

## 3. Proposed schemas

### 3.1 `suggestedApps.json`: new `managed` block (proposed)

Added to the existing entry; `downloads` stays for the website-installer path until the maintainer drops it (decision D1).

| Field                        | Type                  | Req                      | Meaning                                                                                                                                                                           |
| ---------------------------- | --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed.feed`               | string, https URL     | yes                      | Feed holding the per-platform bundles (Preen's `latest.json`). Host must equal one of `managed.hosts`.                                                                            |
| `managed.hosts`              | string[]              | yes                      | Hosts the feed and bundle URLs (after redirects) may resolve to.                                                                                                                  |
| `managed.minisignKeys`       | string[]              | yes, 1 to 3              | Bare minisign public keys (`RW...`, the second line of the `.pub` file). Any one verifying is enough. Order irrelevant.                                                           |
| `managed.platforms.<target>` | object                | yes per shipped platform | `<target>` is Tauri's updater key: `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`.                                                                           |
| `...program`                 | string, relative path | yes                      | The executable inside `app/`. Forward slashes, no `..`.                                                                                                                           |
| `...codeRoot`                | string, relative path | macOS only               | The bundle checked with `codesign`/`spctl` (`Preen.app`).                                                                                                                         |
| `...bundleId`                | string, reverse DNS   | macOS only               | Expected `CFBundleIdentifier` (`app.preen.lifer`); used for the codesign requirement and for WebKit/Caches removal. Must differ from the entry `id` and from `app.lifer.desktop`. |
| `...signer`                  | string                | macOS, Windows           | Team ID, or `subject\nissued by issuer`, same format as `plugins.rs` identities. Never `PLACEHOLDER` (build fails, see L1).                                                       |
| `managed.removeWarningKey`   | string, i18n key      | no                       | Extra sentence for the Remove dialogs (`suggestedApps.cull.removeWarning`).                                                                                                       |
| `managed.pending`            | boolean               | no                       | Same meaning as today's `pending`: offer shows "Available soon".                                                                                                                  |

Example:

```json
"managed": {
  "feed": "https://updates.preenwildlife.com/stable/latest.json",
  "hosts": ["updates.preenwildlife.com", "licence.preenwildlife.com"],
  "minisignKeys": ["RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"],
  "removeWarningKey": "suggestedApps.cull.removeWarning",
  "platforms": {
    "darwin-aarch64": { "codeRoot": "Preen.app", "program": "Preen.app/Contents/MacOS/preen", "bundleId": "app.preen.lifer", "signer": "ABCDE12345" },
    "darwin-x86_64":  { "codeRoot": "Preen.app", "program": "Preen.app/Contents/MacOS/preen", "bundleId": "app.preen.lifer", "signer": "ABCDE12345" },
    "windows-x86_64": { "program": "preen.exe", "signer": "CN=Example Publisher, O=Example\nissued by CN=Example CA" },
    "linux-x86_64":   { "program": "preen" }
  }
}
```

Why no pinned `bundle{url, sha256, ...}` in `suggestedApps.json` (the Preen contract had one): a bundle pinned in Lifer's source ages with every Preen release, so a first install would fetch an old build and update straight away, and every Preen release would want a Lifer release. Install reads the same feed as updates. Trust does not move: the keys, signer, program path and hosts stay compiled into Lifer. Decision D2.

### 3.2 Feed entry: Preen's `latest.json` `managed` block (proposed, Preen P4)

```json
{
  "version": "1.2.3",
  "platforms": { "...": "Preen's own updater entries, untouched" },
  "managed": {
    "darwin-aarch64": {
      "version": "1.2.3",
      "url": "https://updates.preenwildlife.com/stable/1.2.3/Preen_1.2.3_aarch64.lifer.app.tar.gz",
      "format": "tar.gz",
      "size": 183400112,
      "unpackedSize": 412300000,
      "sha256": "9f2c...64 hex...",
      "signature": "<base64 of the .minisig file, exactly as Tauri's 'signature'>",
      "minHost": "1.0.0"
    },
    "darwin-x86_64": {
      "version": "1.2.3",
      "url": "https://.../Preen_1.2.3_x64.lifer.app.tar.gz",
      "format": "tar.gz",
      "size": 190112000,
      "unpackedSize": 430000000,
      "sha256": "...",
      "signature": "..."
    },
    "windows-x86_64": {
      "version": "1.2.3",
      "url": "https://.../Preen_1.2.3_x64.lifer.zip",
      "format": "zip",
      "size": 201000000,
      "unpackedSize": 520000000,
      "sha256": "...",
      "signature": "..."
    },
    "linux-x86_64": {
      "version": "1.2.3",
      "url": "https://.../Preen_1.2.3_amd64.lifer.tar.gz",
      "format": "tar.gz",
      "size": 210000000,
      "unpackedSize": 560000000,
      "sha256": "...",
      "signature": "..."
    }
  }
}
```

| Field          | Type                  | Req | Check                                                                                                                                                |
| -------------- | --------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | semver string         | yes | Must equal the signed trusted comment's `version`; must be greater than the installed version (no downgrades, see 6).                                |
| `url`          | https URL             | yes | `checked_url` as today, host in `managed.hosts` after redirects.                                                                                     |
| `format`       | `"tar.gz"` \| `"zip"` | yes | macOS and Linux `tar.gz`, Windows `zip`. Anything else refused.                                                                                      |
| `size`         | integer bytes         | yes | Download stops past it; must match exactly at the end. Cap 4 GB (existing constant).                                                                 |
| `unpackedSize` | integer bytes         | yes | Disk check before download; unpack aborts once written bytes pass it by 1%.                                                                          |
| `sha256`       | 64 lowercase hex      | yes | Hashed while streaming; compared before unpack.                                                                                                      |
| `signature`    | string                | yes | Minisign over the archive bytes. **Trusted comment (signed) must be** `id:app.preen.desktop target:<target> version:<version>` (proposed, Preen P4). |
| `minHost`      | semver                | no  | Lowest Lifer version that can host it; a lower Lifer keeps the installed copy and shows "Update Lifer to get the latest {name}".                     |

Version scheme: semver 2.0 (`semver` crate), pre-releases only on non-stable feeds. Comparison is on the signed version, never on the URL or file name.

### 3.3 `managed.json` (Lifer writes, Preen reads; proposed)

Path: `<Lifer data>/plugins/<id>/managed.json`, written with `fsutil::write_atomic`.

| Field         | Type                  | Req   | Who reads                                                                                 |
| ------------- | --------------------- | ----- | ----------------------------------------------------------------------------------------- |
| `schema`      | integer, `1`          | yes   | both                                                                                      |
| `host`        | `"app.lifer.desktop"` | yes   | Preen (mode detection)                                                                    |
| `id`          | string                | yes   | Lifer                                                                                     |
| `version`     | semver                | yes   | both                                                                                      |
| `program`     | relative path         | yes   | Lifer (authoritative executable)                                                          |
| `cacheDir`    | absolute path         | yes   | Preen: `<Lifer cache>/plugins/<id>`, since Preen can't derive Lifer's cache folder per OS |
| `bundleId`    | string                | macOS | Lifer (removal)                                                                           |
| `installedAt` | RFC 3339              | yes   | Lifer (Storage row)                                                                       |
| `previous`    | semver                | no    | Lifer: version left in `app.old/` until the new one starts once                           |
| `skipVersion` | semver                | no    | Lifer: a version that failed to start; not retried until a newer one appears              |

```json
{
  "schema": 1,
  "host": "app.lifer.desktop",
  "id": "app.preen.desktop",
  "version": "1.2.3",
  "program": "Preen.app/Contents/MacOS/preen",
  "cacheDir": "/Users/x/Library/Caches/app.lifer.desktop/plugins/app.preen.desktop",
  "bundleId": "app.preen.lifer",
  "installedAt": "2026-12-01T09:12:00Z"
}
```

Preen must ignore unknown fields. Lifer owns this file; Preen never writes it.

### 3.4 Minisign key: location, embedding, rotation

- **Location**: the keys live in `managed.minisignKeys` in `apps/web/src/data/suggestedApps.json`, committed to the public repo. The maintainer also publishes them at a stable https URL on the Preen site (D4) for anyone auditing; Lifer never fetches keys.
- **Embedding**: Rust reads the file at compile time (`include_str!("../../../web/src/data/suggestedApps.json")`, parsed once into a `OnceLock`). The web page passes only `appId`; Rust looks up URL, keys, signer and program itself. This closes today's gap where page script chooses the signer.
- **Build guard**: a unit test (runs in CI) fails if any non-`pending` entry has `PLACEHOLDER`, an empty key list, or a key that doesn't parse.
- **Which key**: recommended a dedicated managed-bundle key, not Preen's updater key and not the Linux `MINISIGN_SECRET_KEY`, so that Lifer trusting it doesn't widen what Preen's own updater accepts and it can rotate on its own schedule (D3). Reusing the updater key works too; the trusted-comment format still separates the two uses.
- **Rotation**: (1) add the new key to `minisignKeys` and ship a Lifer release; (2) once most installs run it, Preen signs with the new key; (3) a later Lifer release drops the old key. Compromise: ship a Lifer release without the key; on macOS and Windows an attacker also needs the code signing identity (two independent factors). Linux has minisign only (one factor), stated in the threat model.

## 4. Work packages

### L1 Install (M, Opus)

New `apps/desktop/src-tauri/src/managed_install.rs` (download/verify/unpack/swap) and a small `unpack.rs` (archive safety, easy to fuzz and test alone). Reuse `checked_url`, `download`, `Download` progress state and `PluginInstalls` from `plugin_install.rs` (make them `pub(crate)`; the download gains a sha256 hasher and an exact-size check).

Steps, all in Rust, triggered by `plugin_install_managed(appId)` (new command, `app-commands.toml` entry, `is_app_page` check):

1. Look up the compiled-in entry; refuse unknown ids or `pending`.
2. Take the per-id install lock: in-process (the existing `PluginInstalls` map) plus a lock file `plugins/<id>/.lock` opened `create_new`, with stale detection by pid, so two Lifer processes (dev and release, or a second instance) can't interleave.
3. Fetch the feed (64 KB cap, https, hosts allowlist), pick `managed.<target>`, check `minHost`, `skipVersion`, and version greater than installed.
4. Disk check: free space on the data volume at least `size + unpackedSize + 10%` (and on updates, the old copy stays until the swap). Helper via `statvfs` (unix) and `GetDiskFreeSpaceExW` (Windows; add the `Win32_Storage_FileSystem` feature). Message: "There isn't enough free space to install {name}. It needs {needed}; {free} is free."
5. Clean `plugins/<id>/app.new/` and `downloads/apps/<id>/`, download into the latter, hashing as bytes arrive, stopping past `size`.
6. Verify, in order, refusing at the first failure and deleting everything downloaded: exact size, sha256, minisign against any `minisignKeys` entry, trusted comment equals `id:<id> target:<target> version:<feed version>`.
7. Unpack from the same open file handle (seek to 0) into `app.new/` (rules in 4.6).
8. Check the unpacked program:
   - `program` exists, is a regular file, executable bit on Unix, path stays inside `app.new/` after `canonicalize`.
   - macOS: `codesign --verify --strict --deep` with requirement `anchor apple generic and identifier "<bundleId>" and certificate leaf[subject.OU] = "<signer>"` on `codeRoot`; then `spctl --assess --type execute` on `codeRoot` (passes only for a notarised Developer ID app; the stapled ticket makes it work offline).
   - Windows: `win::authenticode_signer` on `program` and every other `.exe` in the tree must equal `signer`.
   - Linux: nothing more (minisign is the only factor).
9. macOS: remove `com.apple.quarantine` from every entry in `app.new/` (`xattr` crate, no shell). Files written by reqwest are not quarantined (Lifer doesn't set `LSFileQuarantineEnabled`), so this is a no-op in practice and a guard if that ever changes.
10. Swap (4.5), write `managed.json`, delete `downloads/apps/<id>/`.
11. Register: run `<program> --lifer-register` (new Preen flag, P3) with a 20 s timeout. Preen writes its manifest `plugins/<id>.json` and exits. Lifer then grants (existing `grantSuggestedApp`) and opens the app's page.

`plugins.rs` change (in L1): in `scan`, when `plugins/<id>/managed.json` exists and parses, the executable is `plugins/<id>/app/<program>` whatever the manifest says. This makes the managed copy win when both copies exist and makes a manifest rewritten by a standalone copy harmless. Also refuse to start a plugin while its install slot is busy (swap in progress).

### L1.5 Swap and recovery (inside L1)

Folder states under `plugins/<id>/`: `app/`, `app.new/`, `app.old/`, `data/`, `managed.json`.

Swap (same volume, so renames are atomic):

1. Plugin stopped (L2 rule) and its slot marked busy.
2. `app/` to `app.old/` (if present).
3. `app.new/` to `app/`.
4. `managed.json` rewritten with `version`, `previous`.
5. After the first READY from the new version: delete `app.old/`, clear `previous`.

Windows: renames of a folder with open handles fail; retry with backoff for up to 10 s (antivirus scanners hold handles briefly), then roll back step 2 and report.

Recovery, run at Lifer startup and before every install, start or removal:

| Found                                            | Action                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `app.new/`                                       | Delete (unverified or half-unpacked).                                                         |
| no `app/`, `app.old/` present                    | Rename `app.old/` to `app/` (crash between steps 2 and 3); restore `version` from `previous`. |
| `app/` and `app.old/`, `previous` set            | Normal pending state; resolved at next start.                                                 |
| `app/` present, no `managed.json`                | Install never finished: delete `app/`. Never touch `data/`.                                   |
| `managed.json` present, no `app/`, no `app.old/` | Show "Repair" on the Storage row (reinstall, keeps `data/`).                                  |

Rollback: if the new version doesn't send READY or crashes within 60 s twice, rename `app/` to `app.bad/` (deleted), `app.old/` to `app/`, set `skipVersion`, start the old copy, and show "{name} {version} didn't start, so Lifer went back to {previous}." Data migrations are Preen's concern: `data/` is never rolled back, so Preen must not make its database unreadable by the previous version, or must back it up before migrating (P-side dependency, D9).

### L1.6 Safe unpack rules (`unpack.rs`)

Every entry is validated before anything is written; the whole archive is refused on the first bad entry.

- Path: relative, normal components only (no `..`, no root, no Windows prefix or drive, no `:` anywhere, no backslash in tar names), UTF-8, at most 255 bytes per component.
- Windows names: reject reserved device names (`CON`, `NUL`, `COM1`...), trailing dot or space, names that collide case-insensitively (also on macOS, whose default volume is case-insensitive).
- Types: regular files and directories; symlinks only on macOS and Linux, only relative, and only if the target resolved lexically against the link's folder stays inside the root (`.app` frameworks need `Versions/Current` links). No hard links, devices, FIFOs, sockets. Zip symlinks refused entirely.
- No writing through a symlink: entries are written in a second pass where the parent of every path is checked with `symlink_metadata` component by component, and files are created with `create_new` (no follow of a pre-existing link).
- Modes: keep owner-execute bits; drop setuid, setgid, sticky, group/other write. Files end up `0755`/`0644` at most.
- Limits: entry count at most 200 000; bytes written at most `unpackedSize * 1.01`; a single file's declared size must match what is read.
- Windows long paths: write through `\\?\` paths; refuse if any final path is over 32 000 characters. Preen's CI checks under 200 characters for the relative part (P5).
- The `tar` crate's `unpack_in` and `zip`'s `enclosed_name` are not relied on alone: the explicit checks above run first.

### L2 Updates (S, Opus)

- When: when the Cull page or the app's own page opens, and once a day (a timer in Rust that only runs while a managed copy is installed). Offline or feed errors are silent and never hide the installed copy (offline first).
- How: the same steps 3 to 9 as L1 into `app.new/`, while Preen keeps running.
- Apply: never kill a running Preen to update (never block the user, and it may be importing). A verified update waits in `app.new/` and is swapped the next time Lifer starts Preen (before launch) or when Preen is stopped. The app's page shows a quiet "Update ready. Restart {name}" button that stops (stdin close, existing grace), swaps and relaunches (D6).
- Requires a per-plugin `PluginHost::stop(id)` (new, mirrors `stop_all` for one slot). If Lifer is attached to an instance it didn't launch (`process == None`), Lifer doesn't stop it and the update waits.
- Preen's own updater is off in managed mode (P3); its banner says Lifer keeps it up to date.

### L3 Removal (S, Opus)

New command `plugin_remove_managed(appId)` in `managed_install.rs`, native confirm like `remove_all_data` (page script alone can't delete). Steps:

1. `PluginHost::stop(id)`; if an instance Lifer didn't launch is running from `plugins/<id>/app/`, refuse with "Quit {name}, then try again."
2. Credentials: run `<program> --lifer-forget` (new Preen flag, P3, 20 s timeout), which deletes only the managed accounts (`lifer-api-key.managed`, `licence-activation.managed`) and keeps `trial-days`. Lifer keeps no knowledge of Preen's account names. If the program is missing or fails, carry on (the Preen plan accepts leftover entries: a later install picks them up).
3. Revoke the app's Lifer API key and grants the same way Connected apps' Disconnect does, and drop its entry in `plugin-approvals.json`.
4. Delete `plugins/<id>/` (program, `data/`, `managed.json`), `<Lifer cache>/plugins/<id>/`, `downloads/apps/<id>/`.
5. Delete `plugins/<id>.json` **only if** its `executable` resolves inside `plugins/<id>/app/` or no longer exists; a manifest pointing at a standalone copy stays (it is that copy's).
6. macOS: delete `~/Library/WebKit/<bundleId>` and `~/Library/Caches/<bundleId>`, where `bundleId` comes from `managed.json`, must be valid reverse DNS, and must not equal the entry `id` (the standalone copy's) or Lifer's identifier.
7. Never touched: XMP sidecars and exports beside photos, standalone Preen's folders and keychain entries, `trial-days`.

`remove_data.rs` change:

- Call `PluginHost::stop_all()` before deleting (it doesn't today; Windows would fail on files Preen holds).
- Run step 2 (credentials) for each managed app before deleting.
- Replace `keep.push(app_data.join("plugins"))` with: keep each `plugins/*.json` manifest whose executable is outside `plugins/` (other apps' and standalone copies'); `plugins/<id>/` folders and managed manifests go. `plan()` already handles file-level keeps.
- Add each managed `bundleId`'s WebKit and Caches folders to `roots`.
- Native dialog gains the app's warning sentence when a managed app is installed.

### L4 Settings > Storage row (S, Sonnet)

`StorageSettings.tsx`: a row group shown only when a managed app is installed, above `RemoveAllDataSection`. Data from a new read-only command `plugins_managed()` returning `{id, name, version, bytes, updateReady, broken}` (size computed in Rust, off the main thread, `data/` and `app/` separately not needed). Built from `SettingRow` and the house `Button`, like the other rows. Remove opens the native dialog (L3). Must hold up with very long names and several managed apps (design for extremes), HIG screenshot review before done.

### L5 Windows uninstaller hook (S, Opus)

`tauri.conf.json` `bundle.windows.nsis.installerHooks: "windows/hooks.nsh"` with `NSIS_HOOK_PREUNINSTALL`:

- Stop only processes whose image path is under `$APPDATA\app.lifer.desktop\plugins\` (PowerShell `Get-Process | Where-Object Path -like ...`), never by image name, so a standalone Preen survives. Usually a no-op: the Job object already kills Preen when Lifer exits, and Tauri's uninstaller asks to close Lifer.
- Skip everything when the uninstaller runs in update mode.

**Do not turn "Delete app data" on by default.** Tauri's checkbox runs `RMDir /r` on `$APPDATA\app.lifer.desktop`, which holds the default photo library (`<app data>/data`, the folder `remove_data.rs` is careful to keep). Default-on would delete users' photos on a routine uninstall. The same risk exists today for anyone who ticks it. Recommended instead: leave it off by default, and when ticked, the hook deletes `plugins\<id>\` folders, managed manifests and the Lifer cache plugin folders, and Tauri's own `RMDir` is replaced by a hook that keeps `data\` (D7). This contradicts the contract's "box on"; maintainer decides.

Linux (deb, AppImage) and a macOS Trash drag leave everything; help text says so.

## 5. What the user sees

All copy uses `{name}` from the entry, no em dashes, terse.

**Cull page, not installed (replaces `suggestedApps.disclosure` when the entry has `managed`):**
"The button below downloads {name} from {host}, checks that its maker signed it, and keeps it inside Lifer. No installer or password needed, and removing Lifer's data removes it too. Nothing is downloaded until you press it."

**Progress** (one `ProgressBar`, label changes; Cancel works in every step before the swap):
"Downloading {name}" (percent), then "Checking {name}", then "Installing {name}". The user can leave the page; installs keep going in the background and a toast reports the end ("{name} is ready" with an Open action).

**Errors** (each ends the install, deletes what was downloaded):

| Cause                                         | Copy                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Network, feed down                            | "Couldn't reach the download. Check your connection and try again." (existing)         |
| Size, sha256, minisign, trusted comment       | "The download didn't match what {name}'s maker published, so Lifer deleted it."        |
| Code signer, notarisation                     | "This copy of {name} isn't signed by its maker, so Lifer deleted it."                  |
| Unsafe archive                                | "The download contained files Lifer won't install, so Lifer deleted it."               |
| Disk space                                    | "There isn't enough free space to install {name}. It needs {needed}; {free} is free."  |
| Swap failed (Windows lock)                    | "Lifer couldn't finish installing {name}. Restart your computer and try again."        |
| `minHost`                                     | "This version of {name} needs a newer Lifer. Update Lifer, then try again."            |
| OS policy blocks running from the user folder | "{name} was installed but this computer won't run it. Get it from {homepage} instead." |

**Standalone detection:**

- Standalone installed and its manifest present: the offer is already hidden (`useSuggestedApps` filters installed ids) and the sidebar opens it. Unchanged.
- Standalone installed but never launched (no manifest): optional `managed.platforms.<target>.knownLocations` (absolute paths such as `/Applications/Preen.app`) checked with the same signer; offer page then says "{name} is already installed on this computer." with **Open {name}** first and the managed install as a secondary link. Decision D8 (small, but adds Preen paths to the entry).
- Both present: managed copy wins (L1 `plugins.rs` rule). Storage row and Connected apps say "Two copies of {name} are installed. Lifer opens the one it keeps; the other has its own culling history."

**Settings > Storage row:**
Label "{name}", description "Kept inside Lifer. {version}, {size}." Button **Remove**. States: "Update ready" (secondary button "Restart {name}"), "Broken: Repair" when the program is missing.

**Remove dialog (native):** title "Remove {name}?"; body "This deletes {name} and everything it keeps inside Lifer. {name}'s culling history (ratings and picks not yet written to XMP) is deleted too. Your photos and their XMP sidecars are not touched." Buttons "Remove {name}" / "Cancel". The culling sentence comes from `removeWarningKey`.

**Remove all Lifer data dialog:** existing text plus the same `removeWarningKey` sentence when a managed app is installed.

**Help** (`docs/docs/guides/culling-with-other-apps.md`, Sonnet): where it lives, that Remove all Lifer data removes it, and "To remove everything, use Settings > Storage > Remove all Lifer data before deleting the app."

## 6. Threat model

Asset: the user's account on their computer. A managed install downloads and runs native code with the user's privileges, and does so again on every update without asking. Attackers considered: network (MITM, DNS), a compromised CDN or feed host, a compromised Preen release pipeline or signing key, script injected into Lifer's page, another local user, and Lifer's own bugs and crashes. Out of scope: malware already running as the user (it can rewrite Lifer itself).

| Threat                                                                                         | Mitigation                                                                                                                                                                                                                                                                         | Residual                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network tampering                                                                              | https only, hosts allowlist incl. after redirects, sha256 + minisign + code signature                                                                                                                                                                                              | none beyond key compromise                                                                                                                                       |
| Feed host or CDN compromised, serves a malicious archive                                       | Minisign key not on the host; macOS also needs the Developer ID + notarisation for `bundleId`, Windows the Authenticode signer                                                                                                                                                     | Linux: minisign is the only factor                                                                                                                               |
| Feed serves an older, validly signed, vulnerable build (downgrade)                             | Version and target are inside the signed trusted comment; Lifer refuses `version <= installed`; macOS bundle version is under the code signature                                                                                                                                   | A fresh install could be served an old build; Lifer refuses anything older than the newest it has seen (`managed.json` `version`, also kept after `skipVersion`) |
| Cross-platform or cross-app swap (signed Linux archive served as macOS, another app's archive) | Trusted comment binds `id` and `target`                                                                                                                                                                                                                                            | none                                                                                                                                                             |
| Minisign key leaked                                                                            | Rotation via Lifer release (3.4); macOS/Windows still need the code signing identity                                                                                                                                                                                               | Linux exposed until the Lifer release with the key removed spreads                                                                                               |
| Code signing identity leaked                                                                   | Still need minisign key; Apple revocation; Windows certificate revocation                                                                                                                                                                                                          | none if only one leaks                                                                                                                                           |
| Page script (XSS in Lifer's page) installs arbitrary code                                      | Web passes only `appId`; URLs, keys, signer, program come from compiled-in JSON in Rust; `is_app_page`                                                                                                                                                                             | Could trigger an install of the genuine app, which is consented anyway                                                                                           |
| TOCTOU between verify and run                                                                  | Everything under the user's own data folder; hash taken from the bytes streamed, unpack from the same handle; signer checked in `app.new/` then renamed (same inode); plugin host checks identity again before every launch (`identify`, approval pin) and `running_matches` after | Another process running as the user can swap files, out of scope                                                                                                 |
| Zip slip, absolute paths, symlink escape, writing through links, hard links, devices           | 4.6 rules, malicious fixture tests                                                                                                                                                                                                                                                 | none known                                                                                                                                                       |
| Decompression bomb, entry flood                                                                | `unpackedSize` cap, entry count cap, disk check                                                                                                                                                                                                                                    | none                                                                                                                                                             |
| Partial install or crash mid-swap                                                              | `app.new/` staging, recovery table, atomic `managed.json`                                                                                                                                                                                                                          | Disk full during `data/` migration is Preen's                                                                                                                    |
| Failed update bricks the app                                                                   | `app.old/` kept until first READY, automatic rollback, `skipVersion`                                                                                                                                                                                                               | Preen data migration not reversible by Lifer (D9)                                                                                                                |
| Concurrent installs (two clicks, update timer, second Lifer process)                           | In-process map plus lock file, slot busy flag blocks starts during swap                                                                                                                                                                                                            | none                                                                                                                                                             |
| Removal deletes the wrong thing                                                                | Only `plugins/<id>/`, cache `plugins/<id>/`, managed manifest, and `bundleId` folders that are not the standalone id or Lifer's; XMP never under these paths                                                                                                                       | A user who stored photos inside `plugins/<id>/data` by hand loses them (documented)                                                                              |
| Uninstaller deletes photos                                                                     | L5 keeps `data\`; checkbox stays off by default                                                                                                                                                                                                                                    | Existing Tauri behaviour until L5 lands                                                                                                                          |
| Admin-less run from user folder blocked (AppLocker, Smart App Control, `noexec` home)          | Error copy with website link                                                                                                                                                                                                                                                       | Those users need standalone                                                                                                                                      |

**Quarantine strip: acceptable?** Yes, with Lifer's checks in place. Gatekeeper on first launch of a quarantined app checks the code signature and the notarisation ticket and shows a "downloaded from the internet" prompt. Lifer performs a stricter version of the same checks before the app is ever runnable: Developer ID chain with the pinned Team ID and bundle id, `spctl --assess` (the same policy engine, which accepts only notarised Developer ID code), plus minisign and sha256 that Gatekeeper doesn't have. App translocation (read-only random mount) would also break the managed layout's `managed.json` lookup. In practice reqwest sets no quarantine flag, so the strip is a guard. Not acceptable without the `spctl` step: the strip must only run after the notarisation assessment passes. XProtect still scans the program at launch regardless. Windows equivalent: reqwest writes no Mark of the Web and Lifer's zip extraction doesn't add one, so SmartScreen doesn't prompt; Defender still scans, and Smart App Control on Windows 11 needs the exes signed with a reputable certificate, which P4 provides.

## 7. Tests

Rust (`cargo test`, fixtures generated in test code with the `tar`/`zip`/`flate2` crates, no binary blobs committed; a test-only minisign key pair generated once and its public half in the test file):

- Malicious archives: `../evil`, `/etc/evil`, `C:\evil`, `a\..\..\evil` in tar, `CON.txt`, `a:stream`, trailing dot, case collision `A`/`a`, symlink to `/`, symlink to `../../x`, symlink then a file written through it, absolute symlink, hard link to outside, char device, FIFO, setuid file, 200 001 entries, a file whose bytes exceed `unpackedSize`, a tar entry whose header size lies, duplicate entries, zip with a symlink entry. Each: refused and `app.new/` gone, nothing written outside the temp root.
- Good archives: a mini `.app` tree with `Versions/Current` relative links unpacks; exec bits kept; group/other write dropped.
- Verification: wrong size (short, long), wrong sha256, signature by another key, malformed signature, trusted comment with other version, other target, other id, feed version lower or equal to installed (downgrade), `skipVersion`, `minHost`, `PLACEHOLDER` signer in a non-pending entry (the build guard), bad key in `minisignKeys`, second key in the list verifies.
- Feed: hosts allowlist incl. a redirect to another host, oversized feed, missing platform.
- Swap and recovery: each row of the recovery table set up on disk, then `recover()`; rollback after a fake plugin (existing test plugin harness in `plugins.rs` tests) that never sends READY.
- Concurrency: two `install` calls for one id; lock file from a dead pid is taken over.
- Removal: `plan()` tests extended: a managed folder goes, a standalone app's manifest and another app's manifest stay, a manifest pointing into `plugins/<id>/app` goes; `bundleId` equal to the entry id or Lifer's is refused.
- macOS-only (`#[cfg(target_os = "macos")]`): a locally ad hoc signed bundle fails the signer check; `spctl` refusal path.
- Windows-only: long path unpack; rename retry.

Web (Vitest): `PluginOfferPage.test.tsx` for managed disclosure, progress steps, each error, standalone-present and both-present copy; `StorageSettings.test.tsx` for the row, update-ready and broken states; `RemoveAllData.test.tsx` warning line.

Manual (each release that touches this): real install on macOS arm64, macOS x64 (Rosetta not used), Windows 11 with Smart App Control on, Ubuntu; update with Preen running; Remove; Remove all data; Windows uninstall with and without the box. Screenshot HIG review for L4 and the offer page.

## 8. Phases and dependencies

| Phase  | Lifer                                                                                                                                                                | Needs from Preen                                                                                                                          | Model  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A, now | Move trust anchors to Rust (web passes `appId` only); `PluginHost::stop(id)`; `remove_all_data` stops plugins; `unpack.rs` with full fixture tests; build guard test | nothing                                                                                                                                   | Opus   |
| B      | L3 removal and the `remove_data.rs` keep-list change; L5 hook (stop by path, keep `data\`)                                                                           | P1 (layout) settled on paper                                                                                                              | Opus   |
| C      | L1 install end to end, `plugins.rs` managed override, register run                                                                                                   | P1, P2, P3 (`--lifer-register`, `--lifer-forget`), P4 artifacts and real feed sample with trusted comments, real signer and keys (D3, D4) | Opus   |
| D      | L2 updates                                                                                                                                                           | P3 (updater off), P4 `managed` feed block                                                                                                 | Opus   |
| E      | L4 Storage row; offer page copy; help page                                                                                                                           | C                                                                                                                                         | Sonnet |
| F      | Review: Opus review of A to D (security, file writes, process control); Sonnet review of E                                                                           |                                                                                                                                           |        |

Sizes: L1 M, L2 S, L3 S, L4 S, L5 S, as the contract has them; Phase A adds about S.

Preen P5 should add: an archive conformance test that runs Lifer's rules (re-implemented in Preen's CI, not shared code) against each release archive, so a release Lifer would refuse never ships.

## 9. Decisions for the maintainer

- **D1** Keep `downloads` (website installer through Lifer) alongside `managed`, or drop it once managed ships? Recommended: drop; the website covers standalone.
- **D2** Install from the feed (recommended) or from a bundle pinned in `suggestedApps.json` as the contract proposed?
- **D3** Minisign key for managed bundles: dedicated key (recommended), Preen's updater key, or the Linux `MINISIGN_SECRET_KEY`?
- **D4** Stable public URL for the key(s); the real Team ID and Windows subject/issuer to replace `PLACEHOLDER`; register `app.preen.lifer` with Apple.
- **D5** Trusted comment format `id:<id> target:<target> version:<v>` for Preen P4 (needed for downgrade protection).
- **D6** Update apply rule: wait for the next start plus a "Restart {name}" button (recommended), or stop and relaunch as soon as it's verified (contract)?
- **D7** Windows uninstaller: keep "Delete app data" off by default and protect `data\` (recommended, photo-loss risk), or default on as the contract says?
- **D8** Add `knownLocations` so Lifer can spot a standalone copy that never ran?
- **D9** Preen's database migrations stay readable by the previous version, or Preen backs up before migrating, so Lifer's rollback is safe?
- **D10** Credential cleanup through `--lifer-forget` run by Lifer (recommended, Lifer stays ignorant of Preen's account names) or Lifer deleting named keychain entries itself (adds a keyring dependency and Preen names to Lifer code)?
- **D11** Does the Storage row and the Remove dialogs' sentence count as allowed mentions under the "only the Cull entry and its offer page" rule? They show the name from the entry's data and only when the app is installed.
