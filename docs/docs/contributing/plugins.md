---
title: Suggested apps and the launcher
description: How the desktop app gets a third-party app's own installer, what it checks, how it finds and opens the installed app, and what it never does.
---

# Suggested apps and the launcher

Lifer is a launcher for third-party companion apps. For a suggested app it downloads the **publisher's own signed installer**, checks it, and opens it with the system's installer. After that the app is an ordinary program on the computer: Lifer finds it, opens it through the [host hand-off](../api/plugins.md#2-start-and-stop-the-launch-rules), and can quit it. Lifer never unpacks, moves, updates or deletes the app's files, and never runs a downloaded file itself.

| Piece                                                              | File                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| The list of suggested apps and their trust anchors                 | `apps/web/src/data/suggestedApps.json`                                                            |
| Download, checks, opening the installer, finding an installed copy | `apps/desktop/src-tauri/src/plugin_install.rs`                                                    |
| Manifests, approval, launch, Quit                                  | `apps/desktop/src-tauri/src/plugins.rs`                                                           |
| Offer page, Connected apps rows                                    | `apps/web/src/pages/PluginOfferPage.tsx`, `apps/web/src/pages/settings/ConnectedAppsSettings.tsx` |

## Trust anchors

Each entry's `install` block holds everything Lifer trusts. The Rust side compiles the file in (`include_str!`), so a script in the page can't swap a URL, key or signer: the page passes only the app's id.

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feed`               | The publisher's https feed; `{channel}` is replaced by `channel` (default `stable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `hosts`              | Exact host names the feed and the installer may come from, checked on every redirect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `minisignKeys`       | Minisign public keys (the `RW...` line). Any one may sign. A `platforms.<target>` entry may carry its own `minisignKeys`, which replace these for that chip.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pending`            | The offer shows **Available soon** and nothing installs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `platforms.<target>` | `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`, picked by the desktop shell from its own architecture (the page asks the shell, it never guesses). Each chip has its own entry, so `signer` and `minisignKeys` can differ per chip; size and sha256 come per target from the feed. An Intel Mac (`darwin-x86_64`) gets a note that the app runs on the CPU only and is slower. `format` is `dmg`, `nsis` or `msi`, `deb` or `rpm`. `signer` is the macOS Team ID or the Windows certificate subject; Windows `issuers` optionally lists allowed issuers. |
| `locations.<os>`     | Where a copy installed on its own keeps its program (`darwin`, `win32`, `linux`). `~/` and a leading `%VAR%` expand.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Optional page-only fields: `pricingText`, `licenseUrl`, `uninstallHelp`.

Any anchor that still contains `PLACEHOLDER` refuses to install ("This app's publisher details are not set up yet"). A unit test fails the build when an entry that isn't `pending` has a placeholder, no key, a key that doesn't parse, or a feed off its hosts.

## The feed

Lifer reads `installers.<target>` from the feed: `version`, `format`, `url`, `size`, `sha256` and `minisign` (the whole `.minisig` text). A feed without that block, or without this computer's target, sends the user to the publisher's website. The feed is capped at 64 KB.

## What Lifer checks

In order, refusing at the first failure and deleting everything downloaded:

1. The feed and installer addresses are https on a listed host, also after each redirect (at most 5).
2. The feed's `format` equals the compiled-in one; `size` is at most 4 GB; there's free space for it.
3. The minisign signature's trusted comment names `id:<app id> target:<target> version:<feed version>`, and one of the compiled-in keys made it (prehashed signatures only).
4. While streaming into a new owner-only folder with a random name: never more bytes than `size`, a running SHA-256 and the minisign hash on the same bytes. At the end: exact size, SHA-256 equal to the feed's, signature valid. Then the file is renamed into place.
5. macOS: the disk image's code signature chains to Apple with the pinned Team ID, and `spctl` accepts it as notarised. Windows: WinVerifyTrust accepts the Authenticode signature and the leaf subject equals the pinned one (and the issuer, if a list is given). Linux: the minisign signature is the only check.
6. The installer opens with the system's handler: Finder mounts the disk image, Windows runs the installer, Linux opens its package installer (only when `dpkg` or `rpm` is present). An AppImage is never offered: running it would mean Lifer running downloaded code.

Errors reach the page as codes (`verification`, `offline`, `space`, `blocked`, ...) that it words in plain language. Cancel works until the installer opens. One install per app at a time.

Test the real signer values on a real signed build before shipping a non-pending entry: Windows signing certificates can be short-lived and chain through several intermediates, which is why the issuer isn't pinned unless listed.

## After the install

- **Manifest:** the app writes its manifest into Lifer's `plugins` folder when it first runs. The offer page then shows **Open**, which starts it with the host hand-off.
- **Already installed:** a signed copy at one of `locations` (owner-only folders, executable, signer matching on macOS and Windows) makes the offer say **Already installed**; **Open** starts it as the system would, and it registers itself.
- **Quit:** Settings > Integrations > Connected apps quits an app Lifer started: standard input closes, and after 5 seconds the process is stopped. Quitting Lifer does the same for every app.
- **Uninstall:** the app's own uninstaller. Lifer shows how and links `uninstallHelp`.
- **Remove all Lifer data** quits running apps first, then deletes Lifer's records about them (approvals, grants, downloaded installers, caches). Each app's manifest in `plugins` and the app's own data stay: they belong to the app.

## Threat model

| Threat                                       | Mitigation                                                                                                               | Left over                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Network tampering                            | https, exact hosts incl. redirects, size, SHA-256, minisign, OS code signature                                           | Key compromise                                                                  |
| Feed or download host compromised            | Keys and signer aren't on the host; macOS also needs the Developer ID and notarisation, Windows the Authenticode subject | Linux has minisign only                                                         |
| A validly signed older installer             | The trusted comment binds id, target and version to the feed                                                             | The feed may still name an old version; the system installer handles downgrades |
| Cross-platform or cross-app swap             | Trusted comment binds id and target; format fixed per target                                                             | None                                                                            |
| Script in Lifer's page                       | The page passes only an app id; every anchor is compiled in; `is_app_page`                                               | It could start an install of the genuine app, which the user still has to run   |
| Swapped file between check and open          | Private random folder, owner-only, created fresh; renamed only after every check                                         | Malware already running as the user is out of scope                             |
| Huge or endless download                     | 4 GB cap, size from the signed feed, read timeout, free-space check                                                      | None                                                                            |
| Two installs at once                         | One slot per app                                                                                                         | None                                                                            |
| An installed copy that isn't the publisher's | Signer pinned for detection; the host checks identity and approval again before every launch                             | Linux detection checks ownership and permissions only                           |

Never download anything real in tests: `plugin_install.rs` serves fixture installers and a test-only key pair from a local server.
