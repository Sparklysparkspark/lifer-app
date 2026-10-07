---
title: Troubleshooting
description: Fixes for common problems with Lifer, and where to find its logs.
---

# Troubleshooting

## macOS folder permission errors {#macos-permissions}

**You see:** "Lifer doesn't have permission to access this folder".

macOS asks before an app can read your Desktop, Documents or Downloads folders, or external drives. If the request was denied, Lifer can't read or write your library there.

1. Open **System Settings > Privacy & Security > Files and Folders**.
2. Find **Lifer** in the list.
3. Turn on the folder your library lives in: **Desktop Folder**, **Documents Folder**, **Downloads Folder**, or **Removable Volumes** for an external drive.
4. Try again. If it still fails, quit and reopen Lifer.

If Lifer isn't in the list, try the action again so macOS asks. Or move your library to a folder macOS doesn't protect, like a folder in your home folder or `Pictures`, with [Settings > Storage](./settings.md#storage-location).

## Model download failures {#model-download}

**You see:** "Download failed" in **Settings > Offline data > Species-matching model**, or during setup.

The models (about 620 MB together) come from Hugging Face and the Lifer GitHub releases.

1. Check your internet connection, then click the download button again.
2. Make sure there's at least 1 GB of free space on the disk that holds Lifer's app data. On a server, that's the `lifer-app-data` Docker volume.
3. On a server, make sure the container can reach `huggingface.co` and `github.com`. Firewalls, DNS filters and some proxies block them.
4. If it says "Waiting for another download to finish", another download (a pack, the map, or a catalog update) is running. It starts when that one finishes.

If "Species reference vectors couldn't be fully downloaded" appears, the model is installed but the species examples it compares against aren't complete. Lifer tries again each time it starts.

## Species suggestions unavailable {#suggestions-unavailable}

**You see:** no suggestion cards on the Import page, or **Suggest species while importing photos** is greyed out.

- **The model isn't downloaded.** Download it from **Settings > Offline data > Species-matching model**. Then tick **Suggest species while importing photos** in **Settings > Species and import**.
- **No region is chosen.** On the **Bulk import** page, pick a **Region for species suggestions**. Suggestions come from the species in that region.
- **The region's pack isn't downloaded.** Download it from [Offline packs](./guides/offline-packs-and-map.md).
- **"Species matching took too long on this photo"** means one photo timed out. Lifer restarts species matching on its own, so carry on.
- **"Stopped: species matching is stuck on an earlier photo"** means several photos in a row timed out. Quit and reopen the desktop app, or run `docker compose restart api` on a server.

Suggestions only appear on the **Bulk import** page and in trips and albums, not on a species page's Upload, since the species is already known there.

The status line in **Species-matching model** tells you which model suggestions use. "The general model, which is less accurate" means only part of the download finished. Click **Download the identification model (~310 MB)** to finish it.

If matching is slow on a server with a graphics card, see [GPU acceleration](./install/hardware-acceleration.md#troubleshooting).

## Drive not connected {#drive-not-connected}

**You see:** a red dot on a photo, "Original unavailable. Connect "…" to view it", or "This file's drive isn't connected right now".

The original is on an external drive that isn't plugged in. Plug it in and try again. Thumbnails keep working while it's unplugged.

If the drive is plugged in but Lifer still says it isn't:

- On a Mac, check [folder permissions](#macos-permissions) for **Removable Volumes**.
- Check **Settings > Storage > External drives** to see whether it shows **Connected**.
- On a server, check that the folder is still mounted and listed in `LIFER_LIBRARY_ROOTS`. **Settings > Storage > Library folders** shows **Not found** if it isn't.

"The file couldn't be found at its saved location" means the file was moved or deleted outside Lifer. Put it back, or run [Reimport library](./settings.md#reimport) to relink moved files.

## "Lifer can't save photos right now"

Your library folder (or Lifer's app data folder) is missing, usually because it was moved, renamed or deleted, or the drive it's on was unplugged.

- **Desktop app:** move it back, or choose its new location in **Settings > Storage**, then restart Lifer.
- **Docker:** update `LIFER_STORAGE_DIR` to the folder's new location and run `docker compose up -d`.

## Resetting a forgotten password {#forgot-password}

This applies to server accounts. The desktop app's own library has no password.

Lifer doesn't send email, so a forgotten password is reset from a shell on the server, which proves you run it. The **Forgot password?** link on the login page shows the same steps.

1. Run the reset command:
   - **Docker:** from the folder with `docker-compose.yml`, run:

     ```bash
     docker compose exec api lifer-admin reset-password
     ```

   - **TrueNAS Custom App:** open the app's **Shell** in the TrueNAS web interface (on the `api` container), then run:

     ```bash
     lifer-admin reset-password
     ```
2. Type the new password (at least 8 characters), then type it again.
3. Sign in with the new password.

Every device that was signed in is signed out. To see which email your account uses, run `lifer-admin list-users`.

## The desktop app won't start

- **"Another program (possibly an earlier copy of Lifer) is still using port 4310."** Quit any other copy of Lifer (check the menu bar or Task Manager), then open it again. Restarting the computer also clears it.
- **"Lifer's backend didn't respond in time."** Quit and reopen Lifer. The first launch can be slow while it sets up its database.
- **"Lifer stopped unexpectedly."** The dialog includes the last error messages. Copy them into a [bug report](./support.md).
- **macOS says Lifer can't be opened.** See [Install on macOS](./install/desktop.md#install-on-macos) for **Open Anyway**.

## Countries or checklists are empty on a new server

The species catalog is built into the Docker image and loads on first start. If countries still don't appear, check the log for "Catalog auto-seed failed". Once the server has internet access, open **Settings > Offline data > Species catalog updates** and click **Update catalog** if it offers one, or restart the server.

## Where the logs are {#logs}

**Docker server:**

```bash
docker compose logs -f api
```

On a NAS, open the Lifer container's logs in its interface. Lines worth knowing:

| Log line | Meaning |
|---|---|
| "Catalog auto-seed failed" | The species catalog didn't load. See above. |
| "[watchdog] Lifer has been unresponsive for …" | The server was stuck. It restarts itself after `LIFER_FREEZE_RESTART_SECONDS`. Please report these. |
| "[library] …" | The library folder, or an extra library folder, went missing or came back |

**Desktop app:** the app doesn't write a log file. If it crashes, the "Lifer stopped unexpectedly" dialog shows the last messages. To see everything as it happens on a Mac, open Terminal and run:

```bash
/Applications/Lifer.app/Contents/MacOS/lifer-desktop
```

## Still stuck?

Ask in [Discussions](https://github.com/Sparklysparkspark/lifer-app/discussions), or [report a bug](https://github.com/Sparklysparkspark/lifer-app/issues/new/choose). [Getting help](./support.md) lists what to include: your Lifer version (**Settings > General > App updates** in the desktop app, or `/version` on your server's address, like `http://192.168.1.50:4000/version`), whether you use the desktop app or Docker, and any log lines.
