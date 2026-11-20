---
title: Photo versions
description: Prints, black and white copies, edits and exports of one photo are grouped as one photo, so it counts once. Switch, rename, choose which one shows, or split one out.
---

# Photo versions

A photo often has more than one file: the camera original, a Lightroom or Photoshop edit, a black and white copy, a panorama, and prints at several sizes. Lifer groups these **versions** under one photo, so the moment counts once on your life list, in species counts and in stats.

Lifer only groups files, it never moves, renames or deletes them.

## How Lifer finds versions

Grouping runs in the background shortly after an import finishes. Lifer links files on its own only when the evidence is clear:

- **Saved from the same file**: an edit or export that Lightroom or Photoshop marked as made from the original.
- **Same moment, same camera, same name**: the same capture time (to the fraction of a second), camera and serial number, and a name that differs only by what editors add, like `-2`, `-Edit`, `-Enhanced-NR`, `-Pano`, `-BW` or a print size like `_8x10`.
- **A versions folder**: a file in a folder named like **Prints** or **B&W**, with the same name as a photo beside that folder, and the same capture time and camera.

When Lifer is less sure (the same moment but different names, or a versions folder file whose metadata was stripped on export) it only **suggests** the group. Suggestions wait on the **Import photos** page, where you can link them all at once, one by one, or keep them apart.

After an import, a short note says what was grouped, like "Found 4 versions of 2 photos".

## Keep versions in folders

Lifer works with the folders you already keep. Put versions in a folder next to the original:

```text
Moose/
  IMG_1234.CR3
  IMG_1234.jpg
  Prints/
    IMG_1234_8x10.jpg
    IMG_1234_16x20.tif
  B&W/
    IMG_1234.jpg
  Edits/
    IMG_1234-Edit.psd
    IMG_1234-Pano.jpg
```

The folder can sit beside the original (`Moose/Prints`) or beside the folder holding it (`Moose/RAW` and `Moose/Prints`). The names have to match, apart from the suffixes above: a folder name alone never groups anything.

Lifer looks for these folder names: **Prints**, **Print**, **Versions**, **Edits**, **Exports**, **B&W**, **BW**, **Black and White** and **Mono**. Change the list in **Settings > Species and import > Photo versions**. After changing it, use **Look for versions in a folder** there to group an existing folder again. It runs in the background, and photos you already split or linked stay as they are.

Some examples:

- **Prints at several sizes**: `Fox/Prints/IMG_1_8x10.jpg` and `Fox/Prints/IMG_1_10x27.jpg` group with `Fox/IMG_1.CR3`, named **Print 8x10** and **Print 10x27**.
- **Black and white**: `Owl/B&W/IMG_9.jpg` or `Owl/IMG_9-BW.jpg` group with `Owl/IMG_9.jpg`, named **Black and white**.
- **Edits**: `Heron/IMG_5-Edit.tif` or a denoised `IMG_5-Enhanced-NR.dng` group with `Heron/IMG_5.NEF`.
- **Panoramas**: `Lake/IMG_7-Pano.jpg` groups with the frame it was started from, named **Panorama**. The other frames stay photos of their own.

## Seeing and switching versions

A photo with versions shows a small stack badge, like **3 versions**, in the Gallery, on species pages, trips and albums.

Open the photo, and the viewer lists its versions by name under the photo. Click one to see it, or press <kbd>Option</kbd>+<kbd>←</kbd> and <kbd>Option</kbd>+<kbd>→</kbd> (<kbd>Alt</kbd>+<kbd>←</kbd> and <kbd>Alt</kbd>+<kbd>→</kbd> on Windows and Linux). When two versions are the same size, the zoom stays where it is, so you can compare details.

- **Rename**: double-click a version's name, or click **Rename**, type a name like "Gallery print" and press <kbd>Enter</kbd>. <kbd>Esc</kbd> cancels. Clear the name to go back to the one Lifer chose.
- **Use this as the photo**: shows that version everywhere the photo appears: grids, the species card and albums. Undo is in the message that follows.
- **Manage versions**: the button at the top of the viewer lists every file with its size and format, and why it was grouped. From there you can **Split out** a version that isn't the same photo (it becomes a photo of its own again, and Lifer won't group it again).

## Link a version yourself

When Lifer didn't group a file, open it and choose **Versions** in its **⋯** menu, then **Link to another photo** (or press <kbd>Cmd</kbd>+<kbd>G</kbd> in the viewer). Lifer first shows photos taken within two minutes. To link a print scanned years later, or a file whose date was lost, search by file name, species, place or date.

A linked version counts under the original's species and date. Its own species and date are kept, so **Split out** gives them back. Every link and split offers **Undo**. A photo that already has versions of its own can't be linked to another; split its versions out first.

## Keyboard shortcuts

| Key | What it does |
| --- | --- |
| <kbd>Option</kbd>+<kbd>←</kbd> <kbd>→</kbd> | Previous or next version in the viewer |
| <kbd>Shift</kbd>+<kbd>G</kbd> | Manage versions |
| <kbd>Shift</kbd>+<kbd>S</kbd> | Use the version on screen as the photo |
| <kbd>Cmd</kbd>+<kbd>G</kbd> | Link to another photo |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Split out the version on screen |
| <kbd>Cmd</kbd>+<kbd>G</kbd>, <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | On the **Import photos** page: link the suggestion you're on, or keep it apart |
| <kbd>Cmd</kbd>+<kbd>Enter</kbd> | On the **Import photos** page: link all suggestions |

On Windows and Linux, use <kbd>Alt</kbd> for <kbd>Option</kbd> and <kbd>Ctrl</kbd> for <kbd>Cmd</kbd>. These follow Lightroom's stack keys.

## How counts work

A photo with versions counts once everywhere: life list, species counts, stats, trips and albums. Ratings, tags and places belong to the photo, not to each version.

To see every file instead, turn on **View > Show every version as its own photo** in the Gallery. Each version then gets its own card, marked with its name and a **Show its photo** link, and the count under the title says "Showing all versions". Counts elsewhere don't change. Selecting is off while this is on, since an action could apply to a version or to its whole photo; a version's **⋯** menu has **Use this as the photo**, **Split out** and **Versions** instead.
