---
title: Install the desktop app
description: Download and install Lifer on macOS, Windows or Linux, and keep it up to date.
---

# Install the desktop app

The desktop app is the simplest way to run Lifer. It's self-contained: it manages its own database in the background, so there's nothing else to install and no login.

## Download

Get the installer for your computer from the [latest release](https://github.com/Sparklysparkspark/lifer-app/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 or newer) | `Lifer-macos-arm64.zip` |
| Windows | `Lifer_<version>_x64-setup.exe` |
| Linux | `Lifer_<version>_amd64.AppImage` (runs directly) or `Lifer_<version>_amd64.deb` (Debian and Ubuntu) |

Macs with Intel processors aren't supported yet.

## Install on macOS

1. Open the downloaded `.zip`.
2. Drag **Lifer** into your **Applications** folder. Run it from Applications, not from Downloads. Updates can't install while Lifer runs from a temporary location, and Lifer will remind you to move it.
3. Open Lifer. macOS blocks it the first time, because Lifer isn't signed with a paid Apple developer certificate.
4. Open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to the message about Lifer.
5. Confirm, and Lifer opens.

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

After you pick a folder, Lifer shows "Setting up your library… this can take a minute the first time." The first launch needs an internet connection to download its database engine (PostgreSQL). The species catalog comes with the app. Then continue with [Getting started](../getting-started.md).

:::tip Choosing a library folder
The folder you pick **is** your library. Lifer creates `Birds`, `Mammals`, `Fish` and other folders directly inside it. Pick an empty folder, or one Lifer used before. You can move it later from [Settings > Storage](../settings.md#storage-location).
:::

To change this choice later, use the **Change Server / Library…** item in the Lifer app menu.

## Where your data lives

| What | Where |
|---|---|
| Your photos | The library folder you chose, plus any [external drives](../settings.md#external-drives) you registered |
| Lifer's database, thumbnails and downloads (models, offline map, catalog) | macOS: `~/Library/Application Support/app.lifer.desktop/`<br />Windows: `%APPDATA%\app.lifer.desktop\`<br />Linux: `~/.local/share/app.lifer.desktop/` |
| The database itself | `app-data/postgres-data/` inside that folder |
| The database engine, downloaded on first launch | `~/.theseus/postgresql/` in your home folder (Windows: `%USERPROFILE%\.theseus\postgresql\`) |
| The chosen library folder and a few local settings | `~/.lifer/settings.json` in your home folder |
| The server you connected to, if any | `desktop-config.json` in the app data folder |
| Collected and seen status, for recovery | `.lifer/collection-state.json` inside your library folder |

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

Delete the app like any other. Your photo library folder stays where it is. To remove Lifer's own data too, delete the app data folder listed above, `~/.lifer`, and `~/.theseus/postgresql` (the downloaded database engine).
