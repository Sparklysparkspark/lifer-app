---
title: Install the desktop app
description: Download and install Lifer on macOS, Windows or Linux, and keep it up to date.
---

# Install the desktop app

The desktop app is the simplest way to run Lifer. It manages its own database in the background, so there's nothing else to install and no login.

## Download

Get the installer for your computer from the [latest release](https://github.com/Sparklysparkspark/lifer-app/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 or newer) | `Lifer-macos-arm64.zip` |
| Mac with an Intel processor | `Lifer-macos-x64.zip` |
| Windows | `Lifer_<version>_x64-setup.exe` |
| Linux | `Lifer_<version>_amd64.AppImage` (runs directly) or `Lifer_<version>_amd64.deb` (Debian and Ubuntu) |

Not sure which Mac you have? Open the Apple menu > **About This Mac**. **Chip** (Apple M1, M2 and so on) means Apple Silicon; **Processor** (Intel) means Intel. Both need macOS 14 (Sonoma) or later.

### Check your download {#verify}

Each release also lists a `SHA256SUMS` file with a checksum for every download. To check yours, download `SHA256SUMS` into the same folder, then in Terminal:

```bash
cd ~/Downloads
shasum -a 256 -c --ignore-missing SHA256SUMS
```

It prints `OK` after your file's name if the download is intact and matches the release. `FAILED` means the file is damaged or isn't the one the release published: delete it and download it again. (On Linux, use `sha256sum -c --ignore-missing SHA256SUMS`.)

## Install on macOS

These steps are the same for the Apple Silicon and the Intel download.

1. Open the downloaded `.zip` (`Lifer-macos-arm64.zip` or `Lifer-macos-x64.zip`).
2. Drag **Lifer** into your **Applications** folder. Run it from Applications, not from Downloads. Updates can't install while Lifer runs from a temporary location, and Lifer will remind you to move it.
3. Open Lifer. The first time, macOS says it can't check Lifer for malicious software and won't open it. Click **Done** (or **OK**).
4. Open **System Settings > Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to the message about Lifer.
5. Confirm with **Open Anyway** again and your Mac's password or Touch ID, and Lifer opens.

On macOS 14 you can instead right-click Lifer, choose **Open**, then **Open** again. On macOS 15 and later that doesn't skip this; use **Open Anyway** as above.

macOS shows this warning because Lifer, a free project, isn't notarized by Apple; to make sure your download is the one the release published, check it against the release's `SHA256SUMS` [as shown above](#verify).

Updates installed from inside Lifer open without this step. A copy you download and install by hand gets the same one-time warning again.

### Folder permission prompts

macOS protects some folders. The first time Lifer reads from one, macOS asks whether to allow it:

- **Desktop**, **Documents** or **Downloads**, if your photo library or imports live there.
- **Removable volumes**, if your photos are on an external drive.

Click **Allow**. If you clicked **Don't Allow** by mistake, Lifer shows a message saying it doesn't have permission to access the folder. See [macOS folder permission errors](../troubleshooting.md#macos-permissions) to fix it.

## Install on Windows

1. Run the downloaded `.exe` installer.
2. Windows may show **Windows protected your PC**, because Lifer isn't signed with a paid Microsoft certificate. Click **More info**, then **Run anyway**.
3. Follow the installer, then open Lifer from the Start menu.

## Install on Linux

- **AppImage:** make the file executable (`chmod +x Lifer_*.AppImage`) and run it.
- **.deb:** install it with `sudo apt install ./Lifer_*_amd64.deb`, then open Lifer from your applications menu.

## First launch

Lifer opens a **Set up Lifer** window with two choices:

- **Pick Local Storage Folder:** choose a folder for your photo library. Lifer runs entirely on this computer. Use this if you're not sure.
- **Connect to a Server:** use a Lifer server you already run. See [Connect the desktop app to a server](./connect-desktop-to-server.md).

After you pick a folder, Lifer shows "Setting up your library… this can take a minute the first time." The first launch doesn't need an internet connection: the database engine (PostgreSQL) and the species catalog both come with the app. Then continue with [Getting started](../getting-started.md).

The folder you pick **is** your library: Lifer creates `Birds`, `Mammals`, `Fish` and other folders directly inside it. Pick an empty folder, or one Lifer used before. You can move it later from [Settings > Storage](../settings.md#storage-location).

To change this choice later, use the **Change Server / Library…** item in the Lifer app menu.

## Where your data lives

| What | Where |
|---|---|
| Your photos | The library folder you chose, plus any [external drives](../settings.md#external-drives) you registered. If you never chose one, it's `data/` inside the app data folder below. |
| Lifer's database, thumbnails and downloads (offline map, catalog, offline packs) | macOS: `~/Library/Application Support/app.lifer.desktop/`<br />Windows: `%APPDATA%\app.lifer.desktop\`<br />Linux: `~/.local/share/app.lifer.desktop/` |
| The species-matching models and GPU runtime | macOS: `~/Library/Caches/app.lifer.desktop/`<br />Windows: `%LOCALAPPDATA%\app.lifer.desktop\`<br />Linux: `~/.cache/app.lifer.desktop/`<br />A cache: if it's cleared (by macOS's storage settings, say), Lifer downloads them again. |
| The database itself | `app-data/postgres-data/` inside that folder |
| The database engine (PostgreSQL) | Inside the app itself. |
| The chosen library folder and a few local settings | `~/.lifer/settings.json` in your home folder |
| The server you connected to, if any | `desktop-config.json` in the app data folder |
| Collected and seen status, for recovery | `.lifer/collection-state.json` inside your library folder |
| Albums and trips, for recovery | Album membership in `.lifer/albums.json` beside the photos and album details in `.lifer/album-details.json` in your library folder; each trip in `.lifer/trip.json` in the folder its photos are in |

Your library folder is the part that matters most. See [Backup and restore](./backup-restore.md) for what to back up.

## Updating {#updating}

Lifer checks for updates by itself and shows a notice with an **Update** link in the bottom-left corner when one is available. You can also check any time:

1. Open **Settings > General**.
2. In **App updates**, click **Check for updates**.
3. If a new version is available, click **Update now**. Lifer downloads it, checks its signature, installs it, and restarts.

If macOS blocks the update from replacing the app, the card shows a **Download Lifer _version_ (.zip)** button instead. Download it, open the `.zip`, and drag Lifer into Applications, replacing the old copy. Then use **Open Anyway** again as in the install steps.

On Windows, if an update can't install, download the new installer from the [Releases page](https://github.com/Sparklysparkspark/lifer-app/releases/latest) and run it. On Linux, only the AppImage updates itself. For the `.deb`, install the new version by hand.

Updating never touches your photos or database.

## Uninstalling

Deleting the app removes only the app itself: like most apps, Lifer's data stays behind in case you reinstall. To remove that too, do this first:

1. Open **Settings > Storage**.
2. In **Remove all Lifer data**, click **Remove**, read what it deletes, type `remove`, and click **Remove everything and quit**.

It deletes Lifer's database, thumbnails, downloads, settings, logs and caches, then quits. Your photos are never deleted, including a library in the default `data/` folder inside the app data folder. The library folder also keeps what a fresh install needs to bring your collection back when you reimport it: collected, seen, target and hidden species, albums and trips with their details, and the tags and ratings written into the photos. Only Lifer's settings are lost; a [backup](./backup-restore.md) keeps those too.

Then delete the app like any other.

To do it by hand instead, delete the app data and cache folders listed above (moving your photos out first if they're in the default `data/` folder) and `~/.lifer/settings.json`.
