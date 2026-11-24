---
title: Photo versions
description: Where the RAW, edited and print files live, and how Lifer groups them as one photo so it counts once. Switch, rename, choose which one shows, or split one out.
---

# Photo versions

A photo often has more than one file: the camera original, a Lightroom or Photoshop edit, a black and white copy, a panorama, and prints at several sizes. Lifer groups these **versions** under one photo, so the moment counts once on your life list, in species counts and in stats.

Grouping never moves, renames or deletes a file. What Lifer does with your files depends on how they came in, as [Where the files live](#where-files-live) explains.

## Where the files live {#where-files-live}

**Folders you keep yourself.** If you link a folder where it is, without organizing it, Lifer never moves it, renames it or writes into it. Keep versions wherever you like. A folder named like **Prints** or **B&W** helps Lifer find them (see [Keep versions in folders](#version-folders)).

```text
Moose/
  IMG_1234.CR3
  IMG_1234.jpg
  Prints/
    IMG_1234_8x10.jpg
  B&W/
    IMG_1234.jpg
```

**Your Lifer library.** When Lifer files an original into the library, it puts each file in a species folder with a subfolder for its kind:

```text
<your library>/
  Birds/
    American Robin/
      RAW/        camera originals in a RAW format
      Adjusted/   JPEG, PNG and TIFF files, including your edits and exports
      Video/      MP4 and MOV clips
      Audio/      sound recordings
```

The folders above the species depend on your [folder layout](./library-folders.md#organization), and the species folder can sit under a trip, place or year. Files keep their own names. If you correct a photo's species, its files move to the new species' folder.

**How versions fit.** A camera RAW goes to `RAW` and a JPEG, edit or export goes to `Adjusted`. The folder doesn't make a version: Lifer links files as versions by capture evidence and file name, wherever they are. So a RAW in `RAW` and its edited JPEG in `Adjusted` are one photo, and so are a RAW and a print in `Prints`.

Which applies: a photo Lifer stores in the library (the default) is filed as above, and one you linked in place stays where it is. Linking a version only records the link. It never moves a file.

## How Lifer finds versions

Grouping runs in the background shortly after an import finishes. Lifer links files on its own only when the evidence is clear:

- **Saved from the same file**: an edit or export that Lightroom or Photoshop marked as made from the original.
- **Same moment, same camera, same name**: the same capture time (to the fraction of a second), camera and serial number, and a name that differs only by what editors add, like `-2`, `-Edit`, `-Enhanced-NR`, `-Pano`, `-BW` or a print size like `_8x10`.
- **A RAW and its edited JPG**: see [A RAW and its edited JPG](#raw-and-edit).
- **A versions folder**: a file in a folder named like **Prints** or **B&W**, with the same name as a photo beside that folder, and the same capture time and camera.

When Lifer is less sure (the same moment but different names, or a versions folder file whose metadata was stripped on export) it only **suggests** the group. Suggestions wait on the **Import photos** page, where you can link them all at once, one by one, or keep them apart.

After an import, a short note says what was grouped, like "Found 4 versions of 2 photos".

## A RAW and its edited JPG {#raw-and-edit}

A RAW and the JPG you edited from it link on their own when either is true:

- they carry the same XMP document ID (Lightroom and Photoshop write it), or
- they come from the same shutter press and the file names match apart from the extension and editor suffixes like `-Edit` or `-2`.

The edited JPG is the **shown version** by default, and the RAW is kept with it, one click away in the viewer's version list. In the Gallery, the **RAW files** and **Edited photos** filters follow the version that is shown.

**At import.** Import an edited JPG whose RAW is already in the library and its row says **Edited version of the photo you already have**. It joins that photo as its shown version, with the RAW's species, trip and place, so you pick no species. Undo the import and the photo goes back to showing its RAW. If the RAW arrives after its JPEG, it's filed with the JPEG instead (see [RAW pairing](./importing.md#raw-pairing)).

**In one import.** When a RAW and its edited JPG are both in the same batch, Lifer pairs them. The second row says **Same photo as** the first, and choosing a species on one sets it on the other. They import as one photo with both files.

**Which version shows.** With no choice from you, a photo shows its newest edit (a DNG, TIFF or PSD saved by an editor), else its camera original, else an edited export. A RAW alone is the last pick, since all it has to show is a small embedded preview. To change it, see [Seeing and switching versions](#switching).

## Keep versions in folders {#version-folders}

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

## Seeing and switching versions {#switching}

A photo with versions shows a small stack badge, like **3 versions**, in the Gallery, on species pages, trips and albums.

Open the photo, and the viewer lists its versions by name under the photo, with the original, edits and exports marked. Click one to see it, or press <kbd>Option</kbd>+<kbd>←</kbd> and <kbd>Option</kbd>+<kbd>→</kbd> (<kbd>Alt</kbd>+<kbd>←</kbd> and <kbd>Alt</kbd>+<kbd>→</kbd> on Windows and Linux). Seeing a version doesn't change which one is the photo. When two versions are the same size, the zoom stays where it is, so you can compare details.

File actions follow the version you see. In the viewer, **Open in** an editor opens the version on screen. In a photo's **⋯** menu, **Reveal in Finder**, **Copy original's path** and **Open in** use the version shown as the photo.

- **Rename**: double-click a version's name, or click **Rename**, type a name like "Gallery print" and press <kbd>Enter</kbd>. <kbd>Esc</kbd> cancels. Clear the name to go back to the one Lifer chose.
- **Use this as the photo**: shows that version everywhere the photo appears: grids, the species card and albums. Use it to show the RAW's preview instead of an edit. Undo is in the message that follows.
- **Manage versions**: the button at the top of the viewer opens the **Versions** window. It lists every file with its size and format, and why it was grouped. The line under the title says what it holds, like "2 files: your camera original and an export" for a RAW and its JPG, or "3 versions" for a photo with prints and edits. **Shown** marks the one file that is the photo. From there you can **Split out** a version that isn't the same photo (it becomes a photo of its own again, and Lifer won't group it again).
- **List or Grid**: switch the Versions window between rows and large thumbnails. A few files open as a list and many as a grid, until you pick one, which Lifer remembers. Each file's **⋯** menu has the same actions in both.
- **See a file full size**: click its thumbnail. A RAW shows its own preview, not the JPG beside it. Use <kbd>←</kbd> and <kbd>→</kbd> to go through the files, and <kbd>Esc</kbd> to go back to the Versions window.

## Link a version yourself

When Lifer didn't group a file, open it and choose **Versions** in its **⋯** menu, then **Link to another photo** (or press <kbd>Cmd</kbd>+<kbd>G</kbd> in the viewer). Lifer first shows photos taken within two minutes. To link a print scanned years later, or a file whose date was lost, search by file name, species, place or date.

You can pick a photo that already has versions, marked with its stack badge: the file joins them. Picking one of its versions does the same.

A linked version counts under the original's species and date. Its own species and date are kept, so **Split out** gives them back. Every link and split offers **Undo**. The photo you link can't have versions of its own; split those out first.

## Keyboard shortcuts

| Key                                                                       | What it does                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| <kbd>Option</kbd>+<kbd>←</kbd> <kbd>→</kbd>                               | Previous or next version in the viewer                                         |
| <kbd>Shift</kbd>+<kbd>A</kbd>                                             | Manage versions                                                                |
| <kbd>Shift</kbd>+<kbd>U</kbd>                                             | Use the version on screen as the photo                                         |
| <kbd>Cmd</kbd>+<kbd>G</kbd>                                               | Link to another photo                                                          |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>                              | Split out the version on screen                                                |
| <kbd>Cmd</kbd>+<kbd>G</kbd>, <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | On the **Import photos** page: link the suggestion you're on, or keep it apart |
| <kbd>Cmd</kbd>+<kbd>Enter</kbd>                                           | On the **Import photos** page: link all suggestions                            |

On Windows and Linux, use <kbd>Alt</kbd> for <kbd>Option</kbd> and <kbd>Ctrl</kbd> for <kbd>Cmd</kbd>. <kbd>Cmd</kbd>+<kbd>G</kbd> and <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> follow Lightroom's group and unstack keys.

## How counts work

A photo with versions counts once everywhere: life list, species counts, stats, trips and albums. Ratings, tags and places belong to the photo, not to each version.

To see every file instead, turn on **View > Show every version as its own photo** in the Gallery. Each version then gets its own card, marked with its name and a **Show its photo** link, and the count under the title says "Showing all versions". Counts elsewhere don't change. Selecting is off while this is on, since an action could apply to a version or to its whole photo; a version's **⋯** menu has **Use this as the photo**, **Split out** and **Versions** instead.
