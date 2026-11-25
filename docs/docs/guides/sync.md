---
title: Syncing with your server
description: What the desktop app keeps in step with your Lifer server, how to see what is waiting, and what to do when something didn't sync.
---

# Syncing with your server

When the desktop app is [signed in to your Lifer server](../install/connect-desktop-to-server.md), the two keep each other up to date by themselves. There is nothing to start: the app syncs when it connects, every half hour while connected, and whenever you click **Sync now**.

## What syncs

Both ways, between this computer and the server:

- Photos imported on either side. Originals you import on this computer are sent to the server; the server's photos come here as thumbnails (or medium previews, if you turn that on) for when the server can't be reached.
- Species, dates, places, ratings, tags and hidden or deleted photos.
- Seen and target marks on species.
- Albums, the photos in them and the ones you took out of a smart album.
- Trips and saved spots.
- Your choice to keep a photo under its old name after a species was split.

Not synced: downloaded regions are offered rather than copied (see [Downloaded regions on both sides](../install/connect-desktop-to-server.md#packs)), and share links, API keys and accounts live on the server only. Extra species in one photo, lists added from iNaturalist and named target lists stay on the computer they were made on; the target marks a list sets do sync.

## See what is waiting

Open **Settings > Server**. The **Sync** group has a row for **Photos** and one for **Albums and trips**:

- **Up to date** means nothing on this computer is waiting for the server.
- **12 changes waiting to sync** counts every photo, mark, album, trip or deletion made here that the server doesn't have yet. Under each row, a line says what the last send did.

While anything is waiting, the **Linked server** row says why: **Sending now.**, **It sends when the app connects to the server and every half hour, or when you click Sync now.**, or the reason the last send stopped.

A large first sync, such as moving a whole library up, can show tens of thousands of changes. They go in batches in the background; the count drops as each batch lands, and you can keep using Lifer meanwhile.

## When the same thing changed in both places

If you change a photo or album on this computer while the server's copy has also changed since this computer last synced, the server's version is kept and the line under **Photos** says so. Lifer never compares the clocks of two computers. Change it again if you want your version.

Two computers signed in to the same server (a laptop and a desktop, say) work the same way: each sends its own changes, and each gets the other's from the server.

## When something didn't sync

- **The last send stopped.** The **Linked server** row gives the reason. Photos that couldn't be sent stay waiting and are tried again at the next sync. A common cause is an original on a drive that isn't connected: connect it and click **Sync now**.
- **A species the server doesn't know.** The server needs the same catalog as this computer. Update both to the same Lifer release and sync again.
- **This server looks new.** The server was probably reinstalled. Nothing changes until you choose; see [If the server was reinstalled](../install/connect-desktop-to-server.md#reinstalled).
- **The server can't be reached.** The app works from this computer's library and sends what you did when the server answers again; see [When the server can't be reached](../install/connect-desktop-to-server.md#offline).
