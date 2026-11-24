---
title: Importing photos
description: Batch import, RAW pairing, duplicates, species suggestions, keyword matching, and bringing in an existing library.
---

# Importing photos

There are four ways to get photos into Lifer:

| Way                                   | Best for                                                        | Where                                     |
| ------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| [Batch import](#batch-import)         | A card or folder from a shoot, with a species for each photo    | **Import** in the top bar                 |
| [From a species page](#species-page)  | A few photos of one species you already know                    | **Upload** on a species page              |
| [Trips](./trips.md)                   | A trip's folder you want to keep where it is                    | **Trips**                                 |
| [Existing library](#existing-library) | Years of photos already tagged in Lightroom, digiKam or similar | **Settings > Library > Import a library** |

Already culled the shoot in Lightroom, Photo Mechanic, digiKam, Vireo, SuperPicky or another culling app? Lifer reads your picks, rejects and color labels, and leaves rejected photos out by default. See [Culling with other apps](./culling-with-other-apps.md).

## Supported files {#supported-files}

- **Photos:** JPEG, PNG, WebP, TIFF and HEIC/HEIF (`.heic`, `.heif`, `.hif`).
- **RAW:** `.cr2`, `.cr3`, `.nef`, `.nrw`, `.arw`, `.raf`, `.rw2`, `.orf`, `.dng`, `.pef`, `.srw`, and unprocessed TIFFs straight from the camera's sensor (see [TIFF files](#tiff)).
- **Video:** MP4 and MOV.
- **Any size.** There's no size limit per file unless your server sets one (see [Large files](#large-files)).

### HEIC photos {#heic}

HEIC is the format iPhones and many newer cameras save in. Lifer keeps your HEIC file as it is and makes a JPEG copy for thumbnails, previews and species recognition. You don't need to convert HEIC photos before importing.

### TIFF files {#tiff}

Lifer looks inside each TIFF to decide what it is:

- **An edited TIFF** (exported from Lightroom, Photoshop, a scanner and so on) is treated as a photo, like a JPEG. If you also have the RAW it came from, Lifer [pairs them](#raw-pairing) the same way it pairs a RAW with its JPEG.
- **A sensor TIFF** (unprocessed camera data, which a few cameras and converters produce) is treated as a RAW.

You don't need to do anything: Lifer tells them apart from the file's contents.

### Large files {#large-files}

Big RAWs, long videos and huge panoramas import like any other file.

Lifer sends each file in pieces. If your connection drops or the laptop goes to sleep partway, the upload picks up from the last piece that arrived instead of starting over. An upload you never finish is cleaned up 2 hours after its last piece arrived.

Because each piece is small, a reverse proxy's request-size limit doesn't get in the way. If a proxy rejects a piece as too large, Lifer retries with smaller pieces. See [Reverse proxy](../install/reverse-proxy.md#large-uploads).

Photos up to 2,000,000,000 pixels (2 gigapixels) open normally. For species recognition, Lifer uses a smaller copy (about 64 megapixels) of any photo over about 268 megapixels. Your original stays full size.

A server admin can set a per-file size cap or change the panorama limit. See [Environment variables](../install/environment-variables.md#uploads).

## Batch import {#batch-import}

1. Click **Import** in the top bar. The **Import photos** page opens.
2. If species suggestions are on, pick the **Region for species suggestions**. Lifer pre-selects the last region you picked here or viewed on the Collection page, or your first downloaded country if you haven't picked one yet. Instead of drilling in, you can type in **Search regions** to find a country, state or province by name (accents are optional, so "quebec" finds Québec), using the arrow keys and <kbd>Enter</kbd> or a click, or click one of the **Suggested:** regions: the one you're working in and the last three you picked. Every region picker in Lifer works this way. Suggestions for a group with a place or camera GPS use that place's region instead, so a batch from two provinces gets the right species for each; this region covers the rest. It is also saved with each photo, so [Stats](./stats.md) can count the countries you've photographed in.
3. Add files: drag photos, RAWs or videos onto the box, or click **choose a folder** or **choose files**. A folder includes everything in its subfolders.
4. The files are grouped by outing, each group with its place (see [Where the photos were taken](#places)). Each file gets its own row. Assign a species to each one (see [Choosing species quickly](#choosing-species)). Click a row's thumbnail to see it full size.
5. Click **Import N photos** (or videos, or files).

A line above the rows keeps count, like "40 files · 32 ready to import · 0 imported".

If a culling app marked some files rejected, a line above that says how many, with a **Rejected photos** choice: **Skip them** (the default), **Import them hidden** or **Import them anyway**. See [Culling with other apps](./culling-with-other-apps.md#bulk-import).

Each row shows **Uploading…** then **✓ Imported**. If you assigned every row, Lifer takes you back to the Collection page, on the batch's region, and finishes uploading in the background. A small banner in the bottom-left corner shows progress, then what happened, like "12 photos filed under 5 species".

When the batch is done, a message in the bottom-right corner says the same, with **View** (the species, or the region if you picked several species) and **Undo**, which removes the photos that batch just created. It works from whatever page you're on.

If you chose places for any groups, a second message says **Places set for N photos**, with **Undo**, which puts back every place that import set in one step and leaves the photos in your library.

If you left some rows without a species, you stay on the page. There, **Undo last import (N)** does the same as the message's **Undo**.

To leave a photo out, click **✕** on its row.

### Where the photos were taken {#places}

Photos taken close together are one group, going by the camera's own clock, so one camera's photos with and without GPS stay together: a gap of an hour or more, a new day, or camera GPS in another region starts a new one. Each group's heading shows how many photos it has and when they were taken, like "14 photos, Sep 14, 7:10 AM to 8:02 AM", with its place button next to it. After the first five, groups start folded; click a heading to open or close it.

The place button says what Lifer knows:

- **From the camera: near Prince George** when the photos have GPS. The town comes from Lifer's offline town list, so the location never leaves your computer. If the GPS falls inside one of your [places](./photo-map.md#places), Lifer asks **This looks like King Fisher Pond. Use it?**
- **9 from the camera, 5 without** when only some of the group has GPS. A place you choose goes to the ones without; the others keep their camera location.
- **Set place** when none of them has GPS.

Click the button to **Choose a place**: your nearby, recent and other places, a region, or **New place from the map** to drop a pin and save it as a place. A region sets only the region. **Same place as the 7:10 AM group** gives the group the place of the group before it; for a group with no GPS taken the same day, Lifer offers that as a button. **Label** sets a free-text place name, like "Prince George", which is also used for place folders in your [folder layout](./library-folders.md#organization) and suggests names you've used before. **Remove place** clears it. With more than one group, **Place for all photos** above them does the same for the whole batch.

To give one photo a different place, move to its row with the arrow keys and click **Set place for this photo**. Lifer suggests; nothing is set until you choose. When the import finishes, Lifer files the photos under the places you chose, all at once: a saved place gives photos without a point its centre and its privacy radius, and photos with camera GPS keep their own point and take the place's name. A group you leave without a place keeps its camera location, or waits in the map's [Needs placing](./photo-map.md#needs-placing) list.

The **Import photos** page saves into your main library, or into a trip's folder when you pick a trip under **Trip** (see [Importing during a trip](./trips.md#importing-during-a-trip)). To save to an external drive, [upload from a species page](#species-page).

## Choosing species quickly {#choosing-species}

### Suggestions

Turn suggestions on in **Settings > Species and import** with **Suggest species while importing photos**. Each row then shows up to five suggestion cards with the species' reference photo, name and a **% match**. Click anywhere on a card to use it. To check first, use [compare mode](#compare-mode).

- A confident pick is shown on its own.
- When Lifer isn't sure, it shows several cards under "No confident match. Closest guesses:".
- Suggestions never assign themselves. You always confirm.
- Videos get suggestions too, from frames taken across the clip.
- Right after setup, species matching is still downloading in the background. The import page says so, with its progress, and you can carry on: photos you add meanwhile get their suggestions as soon as it finishes.

The **% match** compares the candidates with each other. It isn't a probability. A clear winner shows high, a toss-up closer to 50%.

Every photo you confirm or correct becomes another example for Lifer to learn from, so suggestions improve for the species you photograph.

### Keyboard shortcuts

On the **Import photos** page, when you're not typing in a box:

| Key                                                            | What it does                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| <kbd>↑</kbd> <kbd>↓</kbd>                                      | Previous or next photo. Moving off a photo never confirms its highlighted suggestion                                                     |
| <kbd>←</kbd> <kbd>→</kbd> or <kbd>1</kbd> to <kbd>5</kbd>      | Highlight a suggestion on the outlined photo                                                                                             |
| <kbd>Enter</kbd>                                               | Confirm the highlighted suggestion and go to the next photo without a species. On a photo with nothing to pick, it opens the species box |
| <kbd>Backspace</kbd>                                           | Clear the outlined photo's species                                                                                                       |
| <kbd>⌘⌫</kbd> (<kbd>Ctrl+Backspace</kbd> on Windows and Linux) | **Not wildlife**: leave the outlined photo out of the import and go to the next                                                          |
| <kbd>⌘Z</kbd> (<kbd>Ctrl+Z</kbd> on Windows and Linux)         | Undo the last confirm or clear                                                                                                           |
| <kbd>Enter</kbd> (every photo has a species)                   | Start the import                                                                                                                         |
| <kbd>C</kbd>                                                   | Open [compare mode](#compare-mode) on the outlined photo                                                                                 |

In a species search box, use <kbd>↑</kbd> <kbd>↓</kbd> to move through results, <kbd>Enter</kbd> to pick, and <kbd>Esc</kbd> to close.

### Compare mode {#compare-mode}

Compare mode puts your photo beside photos of the species Lifer suggests, so you can check the markings before you confirm. Open it with <kbd>C</kbd>, a row's **Compare** button, or the magnifier on a suggestion card. Trip scan review has it too.

- Your photo opens zoomed on the animal, when Lifer found one. **Fit** shows the whole photo, and **Subject** goes back to the animal.
- The other side starts on the species' featured photo. Use the arrows on it, or <kbd>←</kbd> <kbd>→</kbd>, to see the rest of its photos.
- Click either photo, or press <kbd>F</kbd> or <kbd>Enter</kbd> on it, to see it full screen; <kbd>Esc</kbd> brings you back. A drag moves a zoomed photo and a double-click zooms, so neither opens it.
- The suggested species are listed along the bottom. To compare with a species that isn't there, click **Search species** at the end of the list, or just start typing its name.
- **Confirm** names your photo and brings up the next one without a species. **Not this** shows the next suggestion. **Skip** (or <kbd>↓</kbd>) goes to the next photo without deciding anything. **Not wildlife** (<kbd>⌘⌫</kbd>, <kbd>Ctrl+Backspace</kbd> on Windows and Linux) leaves out a photo with no animal in it, like a landscape, and moves on; it moves to [Left out of this import](#left-out), with **Import anyway** to bring it back, and <kbd>⌘Z</kbd> undoes it. Each row has a **Not wildlife** link too. On a narrow window the buttons wrap onto a line of their own, so they're always in view. **Done** or <kbd>Esc</kbd> leaves.
- Each photo zooms on its own. Turn on **Link zoom** to zoom and pan both together.
- If you ticked several photos first, opening compare on one of them confirms them all at once (**Confirm all**).

| Key                          | What it does                                  |
| ---------------------------- | --------------------------------------------- |
| <kbd>←</kbd> <kbd>→</kbd>    | More photos of the species shown              |
| <kbd>↑</kbd> <kbd>↓</kbd>    | Your previous or next photo to confirm        |
| <kbd>1</kbd> to <kbd>5</kbd> | Show that suggested species                   |
| <kbd>Enter</kbd>             | Confirm the species shown                     |
| <kbd>Z</kbd>                 | Switch between the whole photo and the animal |
| <kbd>+</kbd> <kbd>-</kbd>    | Zoom both photos in or out                    |
| Any other letter             | Search for a species to compare               |

### Searching by hand

Click **Type a species…** on a row and type a common name, scientific name, or bird code (eBird or ABA).

To give many photos the same species, tick their checkboxes and use **Assign N selected to:**. It counts only ticked photos without a species. Rows you've assigned are ticked for you. Unticking one clears its species and shows its suggestions again, with your earlier pick highlighted so <kbd>Enter</kbd> puts it back.

### Correcting a pick

Click the species name on a row ("Click to change, or see other suggestions again") to search again or see the suggestions.

After import, open the photo's **⋯** menu on its species page or in the Gallery and choose **Correct the ID**. To fix several at once, use **Select** mode and **Correct ID…**.

### Photos with more than one species

Import the photo under the main species. Then, from its **⋯** menu on the species page, choose **Also features another species…**. The extra species counts as photographed too, and the photo appears on both species' pages.

### When suggestions aren't available

Suggestions need species recognition, a one-time download in **Settings > Offline data**. Without it you still assign species by hand, and [keyword matching](#keyword-matching) still works. See [Species suggestions unavailable](../troubleshooting.md#suggestions-unavailable).

### Faster suggestions {#faster-suggestions}

Suggestions are worked out while you add files, so they're usually ready by the time you reach each row.

- When you open **Import photos** (or change the region), Lifer loads its models and that region's species in the background, so the first photo doesn't wait for them.
- Matching runs separately from the rest of Lifer, so other pages don't slow down while a batch is matched.
- When the desktop app is connected to a server, it can do the matching on your computer whenever that's faster, which it often is against a small NAS. The region box then says "Matching on this computer or the server, whichever is faster". See [Connect the desktop app to a server](../install/connect-desktop-to-server.md#desktop-assisted-matching).

## Photos that aren't wildlife

When species recognition is installed, Lifer flags photos that look like something other than wildlife, such as people, screenshots, documents, paintings, cars, buildings, landscapes or the night sky. On the **Import photos** page the photo moves to [Left out of this import](#left-out), with what it looks like instead; in a trip's scan review the row says "This doesn't look like wildlife (it looks like …), so it won't be imported." Photos whose own tags name a species are never flagged, and a photo is only flagged when Lifer is confident, so a likely animal is never hidden. When Lifer is less sure, the photo stays in the list with a quiet question, like "Might be a landscape. Skip it?": **Not wildlife** leaves it out (<kbd>⌘Z</kbd> undoes it), **Keep** drops the question. Click **Import anyway** to keep it, or **Remove**. Assigning a species by hand also clears the flag.

## RAW files and edited JPEGs {#raw-pairing}

Lifer keeps a RAW file with the edited JPEG made from it, as one photo. It pairs them by:

1. The same file name (like `IMG_4411.CR3` and `IMG_4411.jpg`, ignoring suffixes like `-2`) **and** capture times within one second of each other.
2. If the names differ, the camera's own details: capture time, sub-second time, camera model and serial number. Exported JPEGs often lose the sub-second time and serial number, so Lifer then tries capture time and camera model alone.

Lifer never guesses. A RAW that could belong to more than one photo isn't attached to any of them.

An edited TIFF pairs with its RAW exactly like a JPEG does.

Ways to add RAWs:

- **Together with the JPEGs** in a batch import. RAW rows need a species like any other row, but a RAW that matches a JPEG already in your library joins that photo, under its species. A RAW with no match becomes its own photo, using the preview image inside the RAW.
- **Later, in bulk:** on the **Import photos** page, open **Add RAWs to existing photos** and use **Choose RAW files…** or **Choose a folder…**. Each RAW is matched against photos already in your library and filed into that species' `RAW` folder, with no species picker needed. The list shows "N of N linked" and which species each RAW was filed under. RAWs that don't match anything, or match more than one photo, are left untouched on your drive.
- **From a species page:** click **Upload**, then use the **Upload RAW files** section of the window. **Choose RAW files…** files an unmatched RAW under that species anyway. It shows in a **RAW gallery** section on the page. **Choose a folder…** only adds RAWs that match a photo you already have.

It works the other way too: import a JPEG later and Lifer links it to a matching RAW it already has.

## Prints, edits and exports {#versions}

Prints, black and white copies, edits and exports of one photo are grouped as one photo after the import, so it counts once. Keep them in a folder next to the original, such as `Moose/Prints`, `Moose/Versions` or `Moose/B&W`, with the same file name. See [Photo versions](./photo-versions.md).

## Duplicates {#duplicates}

Lifer checks each photo before importing:

- **Exact duplicates:** the very same file you already imported.
- **Near duplicates:** the same shot re-exported, converted to black and white, or lightly cropped. This needs species recognition.

On the **Import photos** page, duplicates move to [Left out of this import](#left-out), each with the species and date it was imported as. **Import anyway** files it under that species and puts it back in the list.

### Left out of this import {#left-out}

Photos the import won't bring in wait in one folded section at the end of the list, so they never get in the way of the ones to name: **Not wildlife**, **Marked not wildlife** and **Already in your library**, each with its count. The groups above, their counts, the arrow keys, compare and **Import** only cover the photos that will be imported, and the line above the list counts each kind, like "339 files · 312 ready to import · 14 not wildlife · 3 already imported". Open the section to see each photo and why, and choose **Remove from this import** or **Import anyway** (back into the list), or **Remove all** / **Import all anyway**. A photo found to belong there while you work moves there without the photo you're on moving, and a photo you're previewing stays the one shown.

From a species page, a **Possible duplicate** dialog appears instead, with **Skip** and **Import anyway**. With several, it shows "(1 of N)" and asks about each in turn. <kbd>Esc</kbd> means **Skip**.

Videos aren't checked for duplicates.

## Move photos into my library {#move-photos}

On the desktop app, the **Move photos into my library** switch beside the drop area tidies up as you import: once each photo is safely in your library, its original goes to your computer's Trash, so a folder of scattered photos is emptied as they're filed. It's off until you turn it on, and Lifer remembers your choice.

- It works for folders you pick with **Choose a folder** (or a recent folder). Files you drag in or pick with **Choose files** are copied and left where they are, since Lifer can't see where they came from.
- A file goes only after its photo is saved and Lifer has checked its copy. If anything fails, the original stays where it is and its row says why.
- Skipped photos, duplicates and files already in Lifer aren't moved by the import. With the switch on, the files already in Lifer from that folder are cleared in the same pass.
- A RAW and its JPG go together or not at all, with their XMP sidecars. Files inside your library's own folders are never touched.

When it's done, the import's note says what happened, like "Moved 8 photos into your library. Cleared 42 already in Lifer. 3 skipped, still where they were."

## Importing a folder again {#folder-again}

Pick a folder you've imported from before and only its new photos are brought in. Photos you already imported, and photos you left out of an earlier import, are set aside before anything is uploaded, so they don't fill the list. The first line after you pick says how many, like "42 of 50 files are already in Lifer, 8 are new". **Show them** lists them, each with **Import anyway**: the ones already in Lifer with the photo each one became, and apart from them the ones you skipped before, which aren't in your library.

On the desktop app, for a folder you chose with **Choose a folder**, **Clear out the ones already in Lifer** sends those files to your computer's Trash. Lifer says how many first, and only clears a file when your library holds the same photo, its copy is there and readable, and the file isn't inside your library's own folders. A RAW and its JPG go together or not at all, with their XMP sidecars. Files you only skipped before are never cleared. To get one back, put it back from the Trash.

- **Renamed or moved files** are still recognised: Lifer goes by the file's contents, not its name.
- **Edited files** (changed since you imported them) count as new. On the desktop app, the line also says how many look like edited copies of photos you imported.
- **RAW and JPEG pairs and videos** are checked file by file, the same way.

**Photos you leave out stay out.** When you import, the photos you removed from the list, marked as not wildlife, or that Lifer judged not wildlife are remembered, so picking the folder again doesn't offer them. **Review skipped** on the **Import photos** page lists them; **Forget** one to have it offered again next time.

**Recent folders (desktop app).** Folders you've imported from appear under the drop area, each with a count of new photos, such as "12 new photos". The count only compares file names, sizes and dates, so it's quick. Click a folder to import its new photos; Lifer never imports from it until you do.

On a server opened over plain `http://` (not `https://`), your browser can't fingerprint files, so every photo is uploaded and the usual [duplicate check](#duplicates) sets the known ones aside instead.

## Keyword matching from photo tags {#keyword-matching}

If your photos are already tagged in Lightroom, digiKam or another tool, Lifer reads those tags. It looks at:

- IPTC keywords and XMP subject keywords.
- Lightroom hierarchical keywords (like `Birds|Waterfowl|Mallard`) and digiKam tags (like `Birds/Waterfowl/Mallard`). Only the last part (`Mallard`) is used.

A tag matches a species if it's exactly the scientific name, the common name, an alternative common name, an older scientific name from before a taxonomic change, or a bird's eBird or ABA code. Capital letters don't matter.

During a batch import, if the tags name exactly one species, it appears as a 100% suggestion. This works even with suggestions turned off.

## What Lifer reads and writes

**Read from each file:** capture time, GPS location, camera, lens, focal length, aperture, shutter speed, ISO, and star rating. Ratings set in Lightroom or a culling tool come along. A rating of 0 or "rejected" counts as unrated. A culling app's pick or reject and color label are read too, from the file and its `.xmp` sidecar: see [Culling with other apps](./culling-with-other-apps.md).

**Written back to files Lifer stores**, so other tools see your work:

- Keywords: each species' common name, scientific name and codes. Your own keywords are kept.
- A hierarchical keyword: `Species|<group>|<family>|<species>`, like `Species|Birds|Turdidae|American Robin`.
- The title (the species name, in your [naming style](./library-folders.md#naming)) and your star rating.
- The place name, as IPTC **Sublocation** (Lightroom and Bridge show it under that name), next to the region's province or state and country. A [reimport](../settings.md#reimport) brings the place name back for photos that don't have one.

JPEG, PNG, TIFF, DNG, WebP and HEIC files get this written inside the file. For other RAW files, Lifer writes a `.xmp` sidecar next to the file instead of changing it. Both are updated whenever you change a photo's species, rating, featured photo, tags, region or place name, including when you rename or remove a place name for every photo in **Settings > Library > Places**. Photos that stay in your own folders, like a library imported without organizing, aren't written to. For a [trip](./trips.md), only the copies in its `Wildlife` folder are.

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

1. Open **Settings > Library** and find the **Import a library** panel.
2. Enter the **Folder**, or click **Choose…**. If it's another Lifer library, the panel says its seen species, targets, card covers, trips and albums come too.
3. Leave **Move photos into my library** off to add photos where they are, or turn it on to move them in. You can import the same folder again with it on later.
4. Click **Import** and confirm.

Lifer reads photos (JPEG, PNG, WebP, TIFF and HEIC) and RAWs in every subfolder. Video files aren't picked up. It matches each one using its embedded tags, an `.xmp` sidecar, and species names or bird codes in the file or folder name. RAWs are paired with their edited photos by name and time.

A progress bar shows photos and RAW files processed, with a cancel button. At the end, Lifer reports how many photos it recovered and how many RAWs it matched.

Photos it can't match are left alone and listed under **Unmatched photos**. Click **Review** to see each one. When its tags or folder name a species, Lifer suggests it from iNaturalist, like "Looks like Fuzzy-horned Bumble Bee": click **Import**, or **Import all** for every photo with that suggestion. Otherwise it gives the reason, like "No species tag found". Click **Ignore** on any you don't want (a folder of insects, say) and they won't show up in future scans.

On a server, you can only import from the library folder or an [extra library folder](../install/docker.md#extra-library-folders).

To rebuild Lifer's records from its own library after a reinstall, click **Rescan this library** instead. See [Settings > Import a library](../settings.md#reimport).
