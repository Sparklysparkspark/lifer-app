---
title: Trash
description: Restore deleted photos, or empty the Trash to remove them for good.
---

# Trash

When you delete a photo or video, it goes to the Trash first. It stays there for **7 days**, and you can restore it any time before then.

Open it from **Settings > Library > Trash**, or type "trash" in [quick search](./gallery-and-search.md#quick-search) (<kbd>Cmd</kbd>+<kbd>K</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd>).

## Deleting photos

Use **Delete photo** (or **Delete video**) in a photo's **⋯** menu, or click **Select**, choose several and use **Delete selected**. This works on a species page, in the Gallery, and on a trip. In the Gallery you can also press <kbd>Delete</kbd> or <kbd>Backspace</kbd> in select mode.

If a photo (or any of the selected photos) has a RAW file, the delete dialog also offers **Also delete the matching RAW file when this is permanently removed**. Leave it off to keep the RAW on disk.

Nothing on disk changes while a photo is in the Trash.

## Restoring

- One photo: open its **⋯** menu and click **Restore**.
- Several: click **Select**, choose the photos (<kbd>Shift</kbd>-click or drag to pick a range), then **Restore selected**.

A restored photo comes back exactly as it was, with its species, rating and tags.

Turn on **Labels** to see each photo's species, how many days it has left, and whether its RAW will be deleted too or kept.

When the Trash holds RAW-only photos or videos, a filter appears with counts: **All**, **Edited**, **RAW** and **Video**. Click a photo to view it full size.

## Emptying the Trash

Click **Empty Trash** and confirm. This permanently removes everything in the Trash right now, even photos that haven't reached 7 days yet. It can't be undone.

Otherwise, Lifer removes photos by itself once they've been in the Trash for 7 days. It checks when it starts and once a day after that.

## What gets removed from disk

When a photo is permanently removed, Lifer deletes the photo or video file it stored in your library, along with its own previews and thumbnails. A species folder left empty is tidied away too.

The RAW file is only deleted if you ticked **Also delete the matching RAW file when this is permanently removed**. Leave it off and the RAW stays in your library.

Files that live in your own folders, like photos imported without copying them into the library, are never deleted from disk. Lifer only forgets them. For a [trip](./trips.md), only the copy Lifer made in the trip's `Wildlife` folder is removed; the trip's own folder is never touched.

If a photo is stored on an external drive that isn't connected, it stays in the Trash until you plug the drive back in. Lifer then removes it the next time it empties the Trash.
