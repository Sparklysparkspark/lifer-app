---
title: Culling with other apps
description: Cull in Lightroom, Photo Mechanic, digiKam, Vireo, SuperPicky or another culling app, then import into Lifer. Which apps work, which fields Lifer reads, and what happens to rejected photos.
---

# Culling with other apps

Many wildlife photographers sort the keepers from the rest in a dedicated culling app before doing anything else. Lifer honours those decisions when you import, so the workflow is simple: **cull with the app you like, then import into Lifer.** Photos you rejected are left out by default (a library reimport hides them instead), and the pick and colour label you gave a photo come along with it.

Lifer only ever reads these marks. It never deletes, moves or changes one of your files because of a mark.

## What Lifer reads

Culling apps record their decisions in the photo's metadata: inside a JPEG, TIFF or DNG, and in an `.xmp` sidecar next to a RAW file (`IMG_0001.xmp` or `IMG_0001.CR3.xmp`). Lifer reads both, and turns what it finds into two things:

- **A verdict:** picked, rejected, or none.
- **A colour label:** red, orange, yellow, green, blue, purple, gray, black or white, or none.

| Field | Written by | Lifer reads it as |
|---|---|---|
| `xmpDM:pick` (1 or -1) and `xmpDM:good` (True or False) | Lightroom Classic 13.2 and later, Lightroom desktop 7.2 and later, digiKam, Vireo, SuperPicky | Picked or rejected |
| `xmp:Rating` of -1 | Adobe Bridge's **Reject**, FastRawViewer (when set to), and other apps that follow the XMP standard's "-1 means rejected" | Rejected |
| `digiKam:PickLabel` | digiKam (Rejected, Pending, Accepted) | Rejected or picked. Pending is no verdict |
| `photomechanic:Tagged` | Photo Mechanic's tag | Picked |
| `xmp:Label` | Lightroom, Bridge, Capture One, digiKam, SuperPicky, FastRawViewer | The colour label |
| `digiKam:ColorLabel` | digiKam | The colour label |

A label's text must name a colour (`Red`, `Green` and so on, in English), or be one of Adobe Bridge's default label names (`Select`, `Second`, `Approved`, `Review`, `To Do`). A custom label set, or label names in another language, isn't read as a colour.

Star ratings are read as they always have been: 1 to 5 stars become the photo's rating in Lifer.

## App by app

| App | Rejects | Picks | Colour labels | Notes |
|---|---|---|---|---|
| **Lightroom Classic 13.2+** and **Lightroom desktop 7.2+** | Yes | Yes | Yes | Flags reach the files only when metadata is saved to them. See [Lightroom](#lightroom) |
| **Lightroom Classic before 13.2** | No | No | Yes | Flags stay in the catalog. See [Lightroom](#lightroom) |
| **Adobe Bridge** | Yes | No | Yes | **Reject** sets the rating to -1 |
| **Photo Mechanic** | No | Yes | Only if written to `xmp:Label` | Photo Mechanic has no reject; its tag is the keeper mark. Color classes are numbered and named by you, so Lifer doesn't read them as colours |
| **digiKam** | Yes | Yes | Yes | Pick labels and colour labels both work |
| **Capture One** | No | No | Yes | Capture One has no pick or reject flag; turn on writing XMP sidecars to share colour tags |
| **Vireo** | Yes | Yes | No | Vireo writes its reject and flag marks (`xmpDM:pick`) when **sync flags to XMP** is on, which it is by default. Its KEEP, REVIEW and REJECT triage stays inside Vireo until you turn it into flags |
| **SuperPicky** | Yes | Yes | Yes | Picks and its "no bird" rejects are written as flags; its blue, green and red labels come along as colour labels. Its 0-star rejects aren't read as rejects, since 0 stars means unrated |
| **FastRawViewer** | With a setting | No | Yes | Turn on **Use XMP Reject rating** so a reject is written as rating -1. Its **Move to Rejected** moves files into a `_Rejected` folder, which Lifer still finds inside a trip folder |
| **Narrative Select** | Probably | Probably | Yes | Narrative says its tags and rejects are written to metadata Lightroom can read, which suggests the `xmpDM` flags. Not yet confirmed with a real file |
| **Excire Foto** | Not known | Not known | Yes | Stars and colour labels are written to sidecars for RAW files; we found no reject flag |

If your app isn't listed, it probably works when it writes `xmp:Rating` -1 for a reject or Lightroom-style flags. Check by importing a few photos with **Rejected photos** set to **Import them anyway**: rejected and picked photos say so in the [Gallery](./gallery-and-search.md)'s full-screen view.

## Lightroom {#lightroom}

Lightroom's Pick and Reject flags used to live only in its catalog, never in your files, so no other app could see them. That changed with **Lightroom Classic 13.2** and **Lightroom desktop 7.2** (February 2024): they now write flags to the files' XMP, as `xmpDM:pick` and `xmpDM:good`.

Lightroom Classic writes them only when it saves metadata to the files:

- **To save automatically,** turn on **Catalog Settings > Metadata > Automatically write changes into XMP**.
- **Otherwise,** select the photos in the Library's Grid view and choose **Metadata > Save Metadata to File** (<kbd>Cmd</kbd>+<kbd>S</kbd> or <kbd>Ctrl</kbd>+<kbd>S</kbd>) before importing into Lifer.

Flags you set before updating to 13.2 aren't written until the photo's metadata is saved again, so select everything and save once.

**On an older Lightroom Classic,** flags can't leave the catalog, and Lightroom has no "rating -1" to set instead. Before importing into Lifer, either:

- remove the rejects: filter by **Rejected** and choose **Photo > Delete Rejected Photos**, or move them to a folder outside the trip folder, or
- update Lightroom, then save the metadata as above.

A colour label from any Lightroom version comes along.

## When you import

### Trips {#trips}

When you [scan a trip's folder](./trips.md), Lifer reads every new photo's marks, from the photo, its sidecar and its RAW. The review then says, for example, "212 photos, 37 marked rejected by your culling app", with a **Rejected photos** choice:

- **Skip them** (the default): rejected photos aren't listed for review and aren't imported. Nothing is copied. They're offered again (and skipped again) on the next scan, so you can change your mind later.
- **Import them hidden:** they're imported, but kept out of the Gallery, your life list and Stats until you [unhide them](#hidden). A species seen only in hidden photos isn't added to your life list.
- **Import them anyway:** they're imported like any other photo.

Each rejected row says what will happen to it. When the import finishes, Lifer reports how many photos it skipped or hid.

### Bulk import {#bulk-import}

The **Bulk import** page reads the marks inside each file you add, and offers the same **Rejected photos** choice when it finds any. A browser only sends the files you pick, not the `.xmp` sidecars next to them, so marks that live only in a sidecar (common for RAWs) aren't seen here. For those, use a [trip](#trips), which reads sidecars.

### Other ways in

Importing an existing library from **Settings > Library > Reimport library** reads the marks in each photo, its `.xmp` sidecar and its RAW, and offers the same choice under **Photos a culling app marked rejected**: **Skip them**, **Import them hidden** (the default here, since a reimport recovers photos you already imported) or **Import them anyway**. See [Reimport library](../settings.md#reimport). The [API](../api/overview.md) reads them too, and its `cullMarks` field chooses what happens.

## RAW and JPEG pairs {#pairs}

A RAW and its JPEG are one photo in Lifer ([how they're paired](./importing.md#raw-pairing)), so a verdict on either file counts for both. If either one is rejected, the pair is rejected, even when the other is picked: a rejection is the deliberate choice, and the other file is usually just one the culling app didn't write to.

## Picks and labels on imported photos

Lifer keeps the verdict and colour label it read with each photo, whichever option you chose. Open a photo full screen in the Gallery and its details say, for example, "Picked in your culling app · Red label".

Lifer's star rating is separate. When Lifer writes its species tags into the copy it keeps, it leaves the culling app's own marks alone, including a rejected photo's rating of -1 while you haven't given it stars in Lifer. (A trip's copy of a RAW doesn't bring the RAW's `.xmp` sidecar along, so for those the marks are kept in Lifer only.)

## Hidden photos {#hidden}

To see photos imported hidden, open the **Gallery**, click **Filters** and tick **Hidden**. (It only appears when you have hidden photos.) From there:

- **Unhide one:** open its **⋯** menu and choose **Unhide**.
- **Unhide several:** click **Select**, tick them, then **Unhide selected**.

Unhiding puts a photo back in the Gallery, your life list and Stats, as if it had been imported normally. Hidden photos can't be edited until they're unhidden. A hidden photo isn't in the Trash and is never removed on its own.

## A recommended workflow

1. **Copy the card** into a trip folder, the way you always do.
2. **Cull** in your app: reject the misses, pick or label the keepers. Make sure it writes to the files (Lightroom: [save metadata](#lightroom); FastRawViewer: XMP reject rating on; Vireo: sync flags to XMP on).
3. **In Lifer, scan the trip.** Check the count of rejected photos looks right, keep **Skip them**, assign species and import.
4. **Changed your mind?** Un-reject the photo in your culling app and scan the trip again: it's offered like any new photo.

## Questions

**Will Lifer delete my rejects?**
No. Lifer never deletes, moves or changes a file because of a culling mark. Skipped photos stay exactly where they are.

**Does a colour label do anything?**
Not at import: only rejections change what's imported. Labels and picks are kept with the photo so you don't lose them.

**My rejected photos were imported anyway.**
Check that your app wrote the reject to the file: for Lightroom, save the metadata ([see above](#lightroom)); for a RAW in Bulk import, use a trip instead, since the browser doesn't send sidecars. Then check the **Rejected photos** choice was **Skip them**.
