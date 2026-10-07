---
title: Importing photos
description: Batch import, RAW pairing, duplicates, species suggestions, keyword matching, and bringing in an existing library.
---

# Importing photos

There are four ways to get photos into Lifer:

| Way | Best for | Where |
|---|---|---|
| [Batch import](#batch-import) | A card or folder from a shoot, with a species for each photo | **Import** in the top bar |
| [From a species page](#species-page) | A few photos of one species you already know | **Upload** on a species page |
| [Trips](./trips.md) | A trip's folder you want to keep where it is | **Albums & trips > Trips** |
| [Existing library](#existing-library) | Years of photos already tagged in Lightroom, digiKam or similar | **Settings > Library > Reimport library** |

Already culled the shoot in Lightroom, Photo Mechanic, digiKam, Vireo, SuperPicky or another culling app? Lifer reads your picks, rejects and colour labels, and leaves rejected photos out by default. See [Culling with other apps](./culling-with-other-apps.md).

## Supported files {#supported-files}

- **Photos:** JPEG, PNG, WebP, TIFF and HEIC/HEIF (`.heic`, `.heif`, `.hif`).
- **RAW:** `.cr2`, `.cr3`, `.nef`, `.nrw`, `.arw`, `.raf`, `.rw2`, `.orf`, `.dng`, `.pef`, `.srw`, and unprocessed TIFFs straight from the camera's sensor (see [TIFF files](#tiff)).
- **Video:** MP4 and MOV.
- **Any size.** There's no size limit per file unless your server sets one (see [Large files](#large-files)).

### HEIC photos {#heic}

HEIC is the format iPhones and many newer cameras save in. Lifer keeps your HEIC file as it is and makes a JPEG copy of it behind the scenes, which it uses for thumbnails, previews and species matching. You can import HEIC photos directly; there's no need to convert them first.

### TIFF files {#tiff}

Lifer looks inside each TIFF to decide what it is:

- **An edited TIFF** (exported from Lightroom, Photoshop, a scanner and so on) is treated as a photo, like a JPEG. If you also have the RAW it came from, Lifer [pairs them](#raw-pairing) the same way it pairs a RAW with its JPEG.
- **A sensor TIFF** (unprocessed camera data, which a few cameras and converters produce) is treated as a RAW.

You don't need to do anything: Lifer tells them apart from the file's contents.

### Large files {#large-files}

Big RAWs, long videos and huge panoramas all import normally.

- **Uploads resume by themselves.** Lifer sends each file in pieces. If your connection drops or the laptop goes to sleep partway, the upload picks up from the last piece that arrived instead of starting over. An upload you never finish is cleaned up 2 hours after its last piece arrived.
- **Works behind any reverse proxy.** Because each piece is small, a proxy's request-size limit doesn't get in the way. If a proxy rejects a piece as too large, Lifer automatically retries with smaller pieces. See [Reverse proxy](../install/reverse-proxy.md#large-uploads).
- **Panoramas:** photos up to 2,000,000,000 pixels (2 gigapixels) open normally. For species matching, Lifer uses a smaller copy (about 64 megapixels) of any photo over about 268 megapixels, which keeps matching quick. Your original stays full size.

A server admin can set a per-file size cap or change the panorama limit. See [Environment variables](../install/environment-variables.md#uploads).

## Batch import {#batch-import}

1. Click **Import** in the top bar. The **Bulk import** page opens.
2. Optionally, type a **Location (optional)** for the whole batch, like "Prince George". This is a place name you choose, separate from GPS. It's also used for [location folders](./library-folders.md#organization).
3. If species suggestions are on, pick the **Region for species suggestions**. Lifer pre-selects the last region you picked here or viewed on the Collection page. The region is also saved with each photo, so [Stats](./stats.md) can count the countries you've photographed in.
4. Add files: drag photos, RAWs or videos onto the box, or click **choose a folder** or **choose files**. A folder includes everything in its subfolders.
5. Each file gets its own row. Assign a species to each one (see [Choosing species quickly](#choosing-species)). Click a row's thumbnail to see it full size.
6. Click **Import N photos** (or videos, or files).

A line above the rows keeps count, like "40 files · 32 ready to import · 0 imported".

If a culling app marked some files rejected, a line above that says how many, with a **Rejected photos** choice: **Skip them** (the default), **Import them hidden** or **Import them anyway**. See [Culling with other apps](./culling-with-other-apps.md#bulk-import).

Each row shows **Uploading…** then **✓ Imported**. If you assigned every row, Lifer takes you back to the Collection page and finishes uploading in the background. A small banner in the bottom-left corner shows progress.

If you left some rows without a species, you stay on the page. Made a mistake? While you're still here, **Undo last import (N)** removes the photos that batch just created.

To leave a photo out, click **✕** on its row.

Bulk import always saves into your main library. To save to an external drive, [upload from a species page](#species-page).

## Choosing species quickly {#choosing-species}

### Suggestions

Turn suggestions on in **Settings > Species and import** with **Suggest species while importing photos**. Each row then shows up to five suggestion cards with the species' reference photo, name and a **% match**. Click a card to use it. Click the reference photo to see more photos of that species, to compare.

- A confident pick is shown on its own.
- When Lifer isn't sure, it shows several cards under "No confident match. Closest guesses:".
- Suggestions never assign themselves. You always confirm.
- Videos get suggestions too, from frames taken across the clip.

The **% match** compares the candidates with each other. It isn't a probability. A clear winner shows high, a toss-up closer to 50%.

Every photo you confirm or correct becomes another example for Lifer to learn from, so suggestions improve for the species you photograph.

### Keyboard shortcuts

On the **Bulk import** page, when you're not typing in a box:

| Key | What it does |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> (or <kbd>↓</kbd>) | Move between suggestions for the next photo without a species |
| <kbd>Enter</kbd> | Accept the highlighted suggestion and jump to the next photo |
| <kbd>↑</kbd> | Undo the last assignment |
| <kbd>Enter</kbd> (every photo has a species) | Start the import |

In a species search box, use <kbd>↑</kbd> <kbd>↓</kbd> to move through results, <kbd>Enter</kbd> to pick, and <kbd>Esc</kbd> to close.

### Searching by hand

Click **Type a species…** on a row and type a common name, scientific name, or bird code (eBird or ABA).

To give many photos the same species, tick their checkboxes and use **Assign N selected to:**. Rows you've assigned are ticked for you, so untick them first if you only want the new ones.

### Correcting a pick

Click the species name on a row ("Click to change, or see other suggestions again") to search again or see the suggestions.

After import, open the photo's **⋯** menu on its species page or in the Gallery and choose **Correct the ID…**. To fix several at once, use **Select** mode and **Correct ID to:**.

### Photos with more than one species

Import the photo under the main species. Then, from its **⋯** menu on the species page, choose **Also features another species…**. The extra species counts as collected too, and the photo appears on both species' pages.

### When suggestions aren't available

Suggestions need the species-matching model, a one-time download in **Settings > Offline data**. Without it you still assign species by hand, and [keyword matching](#keyword-matching) still works. See [Species suggestions unavailable](../troubleshooting.md#suggestions-unavailable).

### Faster suggestions {#faster-suggestions}

Suggestions are worked out while you add files, so they're usually ready by the time you reach each row.

- **Lifer gets ready as soon as you open the page.** When you open **Bulk import** (or change the region), Lifer loads its models and that region's species in the background, so the first photo doesn't have to wait for them.
- **The app stays responsive.** The species-matching models run in the background, separately from the rest of Lifer, so browsing and other pages don't slow down while a batch is being matched.
- **The desktop app can help a server.** When the desktop app is connected to a server, it can do the matching on your computer whenever that beats the server, which it often does against a small NAS. The region box then says "Matching on this computer or the server, whichever is faster". See [Connect the desktop app to a server](../install/connect-desktop-to-server.md#desktop-assisted-matching).

## Photos that aren't wildlife

When the species-matching model is installed, Lifer flags photos that look like something other than wildlife, such as people, screenshots, documents, paintings, cars, buildings, landscapes or the night sky. The row says "This doesn't look like wildlife (it looks like …), so it won't be imported." Photos whose own tags name a species are never flagged. Click **Import anyway** to keep it, or **Remove**. Assigning a species by hand also clears the flag.

## RAW files and edited JPEGs {#raw-pairing}

Lifer keeps a RAW file with the edited JPEG made from it, as one photo. It pairs them by:

1. The same file name (like `IMG_4411.CR3` and `IMG_4411.jpg`, ignoring suffixes like `-2`) **and** capture times within one second of each other.
2. If the names differ, the camera's own details: capture time, sub-second time, camera model and serial number. Exported JPEGs often lose the sub-second time and serial number, so Lifer then tries capture time and camera model alone.

Lifer never guesses. A RAW that could belong to more than one photo isn't attached to any of them.

An edited TIFF pairs with its RAW exactly like a JPEG does.

Ways to add RAWs:

- **Together with the JPEGs** in a batch import. RAW rows need a species like any other row, but a RAW that matches a JPEG already in your library joins that photo, under its species. A RAW with no match becomes its own photo, using the preview image inside the RAW.
- **Later, in bulk:** on the **Bulk import** page, use **Bulk import RAW files** with **Choose RAW files…** or **Choose a folder…**. Each RAW is matched against photos already in your library and filed into that species' `RAW` folder, with no species picker needed. The list shows "N of N linked" and which species each RAW was filed under. RAWs that don't match anything, or match more than one photo, are left untouched on your drive.
- **From a species page:** click **Upload**, then use the **Upload RAW files** section of the window. **Choose RAW files…** files an unmatched RAW under that species anyway. It shows in a **RAW gallery** section on the page. **Choose a folder…** only adds RAWs that match a photo you already have.

It works the other way too: import a JPEG later and Lifer links it to a matching RAW it already has.

## Duplicates {#duplicates}

Lifer checks each photo before importing:

- **Exact duplicates:** the very same file you already imported.
- **Near duplicates:** the same shot re-exported, converted to black and white, or lightly cropped. This needs the species-matching model.

On the **Bulk import** page, a duplicate gets a note: "Looks like you've already imported this photo before" (or "a very similar photo"). Choose **Remove** or **Import anyway**. Suggestions for that row wait until you choose.

From a species page, a **Possible duplicate** dialog appears instead, with **Skip** and **Import anyway**. With several, it shows "(1 of N)" and asks about each in turn. <kbd>Esc</kbd> means **Skip**.

Videos aren't checked for duplicates.

## Keyword matching from photo tags {#keyword-matching}

If your photos are already tagged in Lightroom, digiKam or another tool, Lifer reads those tags. It looks at:

- IPTC keywords and XMP subject keywords.
- Lightroom hierarchical keywords (like `Birds|Waterfowl|Mallard`) and digiKam tags (like `Birds/Waterfowl/Mallard`). Only the last part (`Mallard`) is used.

A tag matches a species if it's exactly the scientific name, the common name, an alternative common name, an older scientific name from before a taxonomic change, or a bird's eBird or ABA code. Capital letters don't matter.

During a batch import, if the tags name exactly one species, it appears as a 100% suggestion. This works even with suggestions turned off.

## What Lifer reads and writes

**Read from each file:** capture time, GPS location, camera, lens, focal length, aperture, shutter speed, ISO, and star rating. Ratings set in Lightroom or a culling tool come along. A rating of 0 or "rejected" counts as unrated. A culling app's pick or reject and colour label are read too, from the file and its `.xmp` sidecar: see [Culling with other apps](./culling-with-other-apps.md).

**Written back to files Lifer stores:** so other tools see your work, Lifer writes into the photo:

- Keywords: each species' common name, scientific name and codes. Your own keywords are kept.
- A hierarchical keyword: `Species|<group>|<family>|<species>`, like `Species|Birds|Turdidae|American Robin`.
- The title (the species name, in your [naming style](./library-folders.md#naming)) and your star rating.

JPEG, PNG, TIFF, DNG, WebP and HEIC files get this written inside the file. For other RAW files, Lifer writes a `.xmp` sidecar next to the file instead of changing it. Both are updated whenever you change a photo's species, rating or featured photo. Photos that stay in your own folders, like a library imported without organizing, aren't written to. For a [trip](./trips.md), only the copies in its `Wildlife` folder are.

## Import from a species page {#species-page}

1. Open the species: press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd>) and type its name, or click it on the Collection page.
2. Click **Upload** in the **Your photos** section.
3. If you have external drives connected, choose where to save under **Save these photos to**: **Main library** or one of your drives.
4. Click **Choose photos or videos…** and pick photos or videos (see [Supported files](#supported-files)). They upload in the background and appear on the page as each one finishes.

To add RAW files here, use the **Upload RAW files** section in the same window (see [RAW files](#raw-pairing)).

A small banner in the bottom-left corner shows progress. When saving to an external drive, it says **Don't unplug the drive yet** until it's done.

This page doesn't do drag and drop or suggestions, since you've already chosen the species.

## Import an existing library {#existing-library}

Have a library organized some other way? Lifer can bring it in by reading the species tags already in the files, and from file and folder names.

1. Open **Settings > Library** and find **Reimport library**.
2. Choose **Import a library organized differently**.
3. Enter the **Folder to import**, or click **Browse…**.
4. Choose whether to tick **Organize matched photos into species folders in my library**. Leave it off to add photos to Lifer without moving them.
5. Click **Import library now** and confirm.

Lifer reads photos (JPEG, PNG, WebP, TIFF and HEIC) and RAWs in every subfolder. Video files aren't picked up. It matches each one using its embedded tags, an `.xmp` sidecar, and species names or bird codes in the file or folder name. RAWs are paired with their edited photos by name and time.

A progress bar shows photos and RAW files processed, with a cancel button. At the end, Lifer reports how many photos it recovered and how many RAWs it matched.

Photos it can't match are left alone and listed under **Review unmatched (N)**, with the reason, like "No species tag found" or "Matched more than one species". Click **Ignore** on any you don't want (a folder of insects, say) and they won't show up in future scans.

On a server, you can only import from the library folder or an [extra library folder](../install/docker.md#extra-library-folders).

To rebuild Lifer's records from its own library after a reinstall, choose **Reimport my existing library** instead. See [Settings > Reimport library](../settings.md#reimport).
