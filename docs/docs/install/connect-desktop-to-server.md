---
title: Connect the desktop app to a server
description: Use the Lifer desktop app as a window onto your own Lifer server, and move a local library up to it.
---

# Connect the desktop app to a server

If you run a [Lifer server](./docker.md), the desktop app can show that server's library in a native window, the same as opening it in a browser. You can switch between the server and the app's own local library at any time.

## Connect on first launch

1. Open Lifer. In **Set up Lifer**, click **Connect to a Server**.
2. Enter the **Server address**, including `http://` or `https://`, for example `https://lifer.example.com` or `http://192.168.1.50:4000`.
3. Click **Connect**. Lifer checks that the server answers.
4. Sign in with your server account.

If you see "Couldn't reach that address. Check the URL and that the server is running.", check the address in a browser on the same computer first.

## Connect from an existing local library

1. Open **Settings > Server**.
2. In **Sign in to a server**, enter the server address and click **Connect**.
3. When it says **Connected to** your server, enter your **Email** and **Password**.
4. Leave **Keep an offline cache after connecting** ticked if you want low-resolution covers and your collected and seen status to stay browsable when this computer loses its connection. See [Offline cache](#offline-cache).
5. Click **Sign in**. The window switches to the server's library.

To go back, open **Settings > Server** and click **Switch to local library** in **Connect a server**. You can also use **Change Server / Library…** in the Lifer app menu to start over from the setup screen.

## Offline cache {#offline-cache}

While the desktop app is connected to a server, it keeps a read-only copy of your collection on this computer, so you can still browse it when the server can't be reached. It's on by default, including when you connect from the setup screen.

**What it holds:**

- Every species in your collection: its common and scientific name, group and family, and whether you've collected it, seen it or not yet.
- A small square cover (192 pixels, a few KB) for up to 3,000 species, your collected ones first, then seen, then the rest. Covers are made from the server's own thumbnails, cropped the way your cards are.
- Never full-size photos, your captures, trips, albums, notes or settings, and never your password.

It's usually 5 to 30 MB and can never grow past about 150 MB.

**When it syncs:** in the background right after you connect, each time the app starts or reloads while the server answers, and every half hour while you're connected. Only covers that changed are downloaded again. Syncing only talks to your own server.

**When the server can't be reached:** when it doesn't answer as the app starts, or after about a minute without an answer while you're using it, the window shows the cached collection under a banner reading **Offline: showing your last synced collection**, followed by the date and time of the last sync. You can search it and filter by collected, seen and not seen, but it's read-only: nothing can be changed until the server is back. As soon as the server answers again, the window switches back to it by itself. **Try again** checks straight away. **Work in this computer's library** opens the app's own library instead, if you want to add photos while away (Lifer offers to push them to the server when it's back). If there's no cache yet, the app opens this computer's library as before.

**Where it lives:** the `offline-cache` folder in the app's data folder:

- macOS: `~/Library/Application Support/app.lifer.desktop/offline-cache/`
- Windows: `%APPDATA%\app.lifer.desktop\offline-cache\`
- Linux: `~/.local/share/app.lifer.desktop/offline-cache/`

**Clearing it:** untick **Keep an offline cache** in **Settings > Server** (it also shows the last sync and size). The cache is also deleted when you sign out, switch to another server, switch to the local library, or use **Change Server / Library…**. A different account signing in on the same server starts a fresh cache. Deleting the folder by hand while Lifer is closed is safe too.

## Automatic URL switching {#url-switching}

At home, the fastest way to reach your server is its local address. Away from home, you need its public address. Lifer can switch between them for you.

**On first launch:** tick **Automatic URL Switching (connect locally over a designated Wi-Fi network)**, then fill in **Local address (home network)**, **Wi-Fi network name** and **External address (away from home)**.

**Later:**

1. While connected to the server, open **Settings > Server**.
2. In **Automatic URL Switching**, click **Set up**.
3. Under **Local network**, enter the server's local address and your home Wi-Fi name. **Use current connection** fills these in from the network you're on.
4. Under **External networks**, **Add** one or more public addresses. Lifer tries them from top to bottom, and you can drag to reorder them.
5. Click **Save**.

## Migrate your library to a server {#migrate}

Moving from the desktop app to a server? Lifer can upload your whole local library.

1. Make sure the server is set up and you've [created its account](./docker.md#first-account).
2. In the desktop app (using its local library), open **Settings > Server**.
3. In **Sign in to a server**, enter the server address and click **Connect**. The **Migrate your library to a server** card appears.
4. Check the server address, enter the **Email on that server** and **Password**, and click **Migrate my library**.
5. Confirm. Uploading a large library can take a while. The card shows how many photos have moved, been skipped, or failed.
6. When it's done, check that nothing failed, then click **Switch this window to the server**.

Your local copies stay on this computer. After a run where nothing failed or was skipped, a **Delete local files now that they're on the server** button appears. Use it only once you've checked the server has everything. It can't be undone.

## Faster species suggestions from the desktop app {#desktop-assisted-matching}

When the desktop app is connected to a server, it can do the heavy part of species matching on your computer instead of on the server. On a small NAS this makes suggestions noticeably faster while you import. There's nothing to turn on.

How it works:

1. The first time you open **Bulk import** while connected, the desktop app downloads the same models the server uses (about 620 MB) into its own app data folder. Each file is checked against the server's checksum. If the app's own local library already has them, it reuses them. Imports keep working while this downloads, with the server doing the matching as usual.
2. Once the models are ready, the region box on the **Bulk import** page says **Matching on this computer or the server, whichever is faster**.
3. For each photo, the app either works out its matching data on your computer and sends it along with the photo, or leaves the work to the server, whichever has been faster. See [GPU acceleration](./hardware-acceleration.md#desktop-and-server).
4. The server only accepts that data when it's provably what it would have computed itself: the same model files, the same image processing version, and the same photo. If anything doesn't match, it ignores the data and does the work itself, so suggestions are never worse for it.

A few things to know:

- **Keep the desktop app and the server on the same Lifer release.** Different releases can process images very slightly differently, and then the app can't help. If they don't match, the server simply does all the matching. [Update the server](./docker.md#updating) and the app to the same version to get the speed-up.
- **RAW files are always matched on the server**, since only the server reads the preview image inside a RAW.
- **If anything goes wrong on your computer**, that photo is matched on the server instead, and the app tries again for the next one.

This only affects species matching. Your photos are still uploaded to and stored on the server as usual.

## What's different when connected

- You sign in with your server account, and the Settings **Account** tab appears.
- Photos are stored on the server, not on this computer.
- [Share links](../guides/albums-and-sharing.md#share-links) and [API keys](../settings.md#api-keys) are available, because they're server features.
- **Settings > Storage** shows the server's folders. They're set by the server's administrator.
