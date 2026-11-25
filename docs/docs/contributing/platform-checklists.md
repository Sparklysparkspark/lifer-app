---
title: Platform and release checklists
description: Manual checks on real Windows, macOS and Linux machines before a release, and the per-OS code audit.
---

# Platform and release checklists

CI builds and tests every OS, but some things only show on a real machine. Run these on each release candidate and note the date, OS version and anything that failed. File each failure as an issue.

## Every platform

On a fresh user account, for each of macOS, Windows 11 and Linux (GNOME and KDE):

- [ ] Install from the release download. It opens without a security warning (macOS once notarized, Windows once signed; until then, note the warning shown).
- [ ] First launch reaches the library setup with no window flashing white first.
- [ ] Import 20 photos, including a RAW and a video. Recognition runs and the Settings acceleration row names the backend used (CoreML, DirectML, CUDA or CPU).
- [ ] Download one offline pack. The free space shows beside its size.
- [ ] Quit from the menu and from the tray. No `lifer-desktop`, `node` or `postgres` process is left (Activity Monitor, Task Manager, `ps aux | grep -i lifer`).
- [ ] Reopen: window size and position come back, clamped to a visible screen.
- [ ] Install the previous release, then update from inside the app. The library opens unchanged after the update.

## Windows

- [ ] Hover the maximise button: Snap Layouts appear.
- [ ] Taskbar progress shows while an import runs and clears when it ends.
- [ ] 100% and 150% display scale, and dragging the window between monitors of different scale: text stays sharp, nothing clips.
- [ ] High contrast (Settings > Accessibility > Contrast themes): every control is visible and the keyboard focus outline shows.
- [ ] Right-click menus open on photos, species cards, albums and trips, as on macOS.
- [ ] A library on a UNC path (`\\nas\photos`) and on a mapped drive letter: import, open an original, Show in File Explorer, then disconnect the share and reconnect. Photos come back without a rescan.
- [ ] Open in: each installed editor (Lightroom Classic, Photoshop, Capture One, DxO, Affinity, GIMP, darktable, RawTherapee) opens the RAW when there is one.

## Linux

- [ ] GNOME on Wayland and KDE Plasma: the title bar matches the desktop, and the app follows the system's light or dark setting.
- [ ] 125% fractional scale: text stays sharp.
- [ ] The tray icon appears (KDE; GNOME with the AppIndicator extension).
- [ ] A library on `/media/<user>/<drive>` and `/run/media/<user>/<drive>`: unplug and replug the drive.
- [ ] AppImage, `.deb` and Flatpak each start. The Flatpak shows no in-app update button (Flathub updates it).
- [ ] Open in: darktable, RawTherapee and GIMP, as installed by the distribution and as Flatpaks.

## macOS

- [ ] Apple Silicon and an Intel Mac.
- [ ] A library on an external drive and on an SMB share (`/Volumes/...`).
- [ ] Open in: Lightroom Classic, Photoshop, Capture One, DxO, Affinity.
- [ ] `spctl --assess --type execute -v /Applications/Lifer.app` says "accepted" once notarized.

## Lightroom Classic plugin

On Lightroom Classic for macOS and for Windows, with Lifer open on the same computer:

- [ ] File > Plug-in Manager > Add the unzipped `lifer.lrplugin` from the release.
- [ ] Library > Plug-in Extras > Connect to Lifer. Lifer asks to allow it, and the codes match.
- [ ] Tag 3 photos with a species. The keywords appear in the layout chosen.
- [ ] Send 3 photos to Lifer. They import, and Lifer's matches come back as keywords.
- [ ] Quit Lifer and send again: the plugin says Lifer isn't running, in plain words.
- [ ] Watch the network (Little Snitch, or Resource Monitor on Windows): the plugin talks only to `127.0.0.1` or the server you connected.

## Docker

- [ ] `docker compose up` with no `.env` and no environment variables: the server starts, migrations run, sign-up works.
- [ ] Stop and start again: data is kept.

## Per-OS code audit

Every `target_os`, `windows` and `unix` branch in `apps/desktop/src-tauri/src` was checked for a missing sibling (2026-11-04). None is missing:

- macOS only, with nothing to do elsewhere: the overlay title bar, the Gatekeeper translocation warning, the open panel tweak, the Dock reopen event, WKWebView's storage folder in Remove All Data (WebView2 and WebKitGTK keep theirs in the app data and cache folders, which are already removed).
- Each OS has its own branch: Wi-Fi name (`network.rs`, parsers tested on every OS), free space (`pg_upgrade.rs`), server data paths (`server_paths.rs`), a plugin ending with Lifer (Linux kernel signal, Windows job object, macOS pid watch), editor detection (`editors.rs`).
- Unix only, with Windows covered another way: file modes and permission tests (Windows uses the user profile's access rules), the process group for plugins (the job object), the shell-based catalog stream tests.

## Dialogs that wait on long work

A sweep (2026-11-04) of every dialog that stays open while it waits. These still need to close at once and show progress where the item lives:

| Where                         | Waits on                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Trash, Empty Trash            | `POST /trash/empty` deletes every file inside the request                      |
| Name changed (species split)  | `POST /species/:id/split` moves each photo's files inside the request          |
| Adjust date and time          | A background job, but the dialog stays open until it ends                      |
| Place step, over 5,000 photos | A background job the dialog waits for, so a following iNaturalist send sees it |
| Album export                  | A background job; progress shows in the dialog (it can be hidden)              |

Not dialogs, but a button that spins through long work: Reorganize in Library and Species import settings (call the route with `?background=1` and follow its status), Delete local library, and Correct ID on many photos at once.
