---
title: Trips
description: Point Lifer at a trip's folder, pick out the wildlife, and keep it sorted by species next to the trip.
---

# Trips

A trip points at a folder of photos, like everything from a week in Costa Rica. Lifer only reads that folder: it finds the photos, and you pick out the wildlife. The trip page shows what you photographed and how many lifers you got.

Trips are on the **Albums** page, in a row under your own albums: open **Albums** in the sidebar (the top bar in a browser). Scroll the row sideways, or click **See all** for every trip in a grid you can search by name.

## Start a trip

Going on a trip? Start it before you take any photos, and Lifer files your imports into it as you go.

1. Click **Start a trip**.
2. Enter a **Name**, like "Costa Rica 2026". Left empty, the trip is called "Untitled Trip".
3. Check the **Start date** (today by default). Add an **End date** if you know it, or leave it empty while you're still away.
4. Optionally pick a **Region**. It's suggested first when you import the trip's photos.
5. Under **Folder**, keep `Trips/<name>` in your library, or click **Change** to pick another folder Lifer can use, like a trips folder on your NAS. On a server, it must be inside the library folder or an [extra library folder](../install/docker.md#extra-library-folders).
6. Click **Start trip**.
7. The trip opens ready for photos. Drop them into the upload area and assign species as in [batch import](./importing.md#choosing-species). To add the RAWs, use **Upload RAW files** below it. Each RAW is matched to a trip photo you've imported.

### Active trips

A trip is **Active** while today is within its dates. A trip with no end date stays active until you end it. On the trip page, under its name:

- **End trip** sets its end date to today.
- **Mark inactive** stops treating it as current, whatever its dates. **Mark active** does the opposite.
- **Edit dates** (or **Set dates**) changes its dates and region.

Several trips can be active at once.

### Importing during a trip

On **Import photos**, the **Trip** list shows where the batch goes:

- With one active trip, the page says **Adding to** that trip, and it's already picked.
- With several active trips, pick one (or **No trip**) before you add photos. Your last pick is picked for you next time.
- With none, it's **No trip**. You can still pick any trip.

The batch's photos join the trip you pick and are saved in the trip's folder, sorted by your [folder layout](./library-folders.md#organization). Its region is the first suggestion in the region picker.

### Photos taken during a trip

Lifer never adds photos to a trip by itself. When photos taken during a trip's dates aren't in any trip, the trip page says so, for example "18 photos taken during Costa Rica 2026 (May 3 – 10, 2026) aren't in this trip." Click **Review**, tick the photos, then click **Add N to trip** or **Dismiss N**. Dismissed photos aren't suggested for that trip again.

After an import, a short note tells you when some of the photos were taken during a trip they weren't added to, with a **Review** button.

When a photo joins or leaves a trip, Lifer moves its files into the trip's folder, or back to your library, as long as Lifer manages them and the drive is connected. A file is never moved over another one.

## How a trip's files are kept

Your trip folder can be organized any way you like, edits and all. Lifer looks through every subfolder and never moves or changes anything in it.

Each photo you import is copied into the trip's **Save wildlife to** folder, sorted into Birds, Mammals and so on by species, with its RAW when there's one with the same file name. By default that's a `Wildlife` folder inside the trip:

```text
Costa Rica 2026/
  (your own photos, however they're organized)
  Wildlife/
    Birds/
      Resplendent Quetzal/
        Adjusted/   the photo you imported
        RAW/        its RAW
```

## Create a trip from an existing folder

1. Click **Add trip from folder**.
2. Enter a **Name**, like "Costa Rica 2026".
3. Under **Trip folder**, click **Choose a folder…** and pick the trip's folder.
4. Under **Save wildlife to**, keep the suggested `Wildlife` folder or click **Change** to pick another.
5. Click **Create trip**.
6. The trip opens and Lifer scans the folder right away. Photos it already knows are picked up automatically. New ones are listed for review. Photos you rejected in a culling app are left out by default; see [Culling with other apps](./culling-with-other-apps.md#trips).
7. Assign a species to each new photo: click **Type a species…** on its row and type a name, or tick several and use **Assign N selected to:**. Optionally pick a region under **Location for this batch (optional)**. Then click **Import N photos**.

Scanning and importing run in the background with a progress bar and a cancel button, so you can keep using Lifer.

On a server, the folder must be inside the library folder or an [extra library folder](../install/docker.md#extra-library-folders). Otherwise you'll see "Lifer doesn't have access to that folder."

## Adding more photos later

Added new photos to the folder? Open the trip and click **⋯** > **Add more photos** at the end of the toolbar (it says **Scan folder** until the trip has photos). Lifer rescans the folder and only offers photos you haven't imported yet:

- New photos are listed for review.
- Files you moved or renamed inside the folder are relinked by their content.
- Missing files are kept and marked as missing, never deleted.
- New RAW files are linked to their JPEGs.

## Move a trip's files {#move-files}

To put a trip's photos somewhere else, like a bigger drive or your NAS, let Lifer move them:

1. On the trip page, click **⋯** > **Move trip files to**.
2. Under **Move to**, click **Choose a folder** and pick where they should go. A folder inside the trip's folder works too, like a `Wildlife` folder in `Belize 2026`: files already in it stay put, and the rest move into it. Click **New folder** in the picker to make one on the spot.
3. Lifer says how many files will move and how much space they take, and which files it can't find.
4. If some of the trip's photos are your own files, linked where they are rather than saved by Lifer, it says how many. They stay where they are unless you tick **Also move my own linked files**. They then move the same careful way, keeping their place in the trip's folders.
5. Click **Move N files**.

The move runs in the background, with progress and a **Cancel** button at the bottom left of every page. Each file keeps its place in the trip's folders (Birds, Mammals and so on), with its RAW and sidecar. On another drive, each file is copied and checked against the original before the original is removed. Nothing is ever written over: a name that's taken gets "-2". When it's done, you'll see something like "Moved 120 files, 2 skipped, 1 missing", plus how many of them were your own linked files, and **Show details** lists the files that weren't moved and why. New photos for the trip are saved to the new folder from then on, and the message says so. Picking the folder the trip already saves to works too: anything already in it stays put. A folder that contains the trip's folder can't be picked.

Lifer checks before it starts. If it can't save in the folder, or there isn't enough space, it says so and doesn't touch anything.

If you cancel, or Lifer quits partway, every file is either moved or still in its old place, never half done. The trip keeps its old folder until everything has moved. A move cut short by a quit carries on the next time Lifer opens; after a cancel, move the files again to finish.

## Set the wildlife folder {#wildlife-folder}

To change only where new photos for the trip are saved, click **⋯** > **Set wildlife folder**, choose a folder (or make one with **New folder**) and click **Save**. Photos already saved stay where they are; to move them too, use **Move trip files to**.

## If you move or reorganize photos {#moved-photos}

Lifer notices on its own. Moved a trip's photos into new subfolders, renamed a folder, or moved the whole trip folder somewhere else in a place Lifer looks? A few minutes after Lifer opens, and whenever you open a trip with missing photos, it finds them and updates where it looks for them. Lifer never moves, renames or changes your files.

- When it finds them, a short note says "Found 12 moved photos", with **Undo**.
- When most of a trip's photos turned up in a new folder, it asks "The Costa Rica 2026 folder moved to ... Use it?". Click **Use it**, and new photos for the trip are saved there too. **Not now** leaves the trip as it is.
- Lifer never guesses. When two files could be the photo (an exact copy, say), or a photo was probably edited in place, it's listed under **Moved photos to review** in **Settings > Storage** for you to pick.
- To look right away, click **⋯** > **Look for moved photos** on the trip page.

Lifer looks in your library folder, every trip's folder, your watched folders, and the **Places where photos live** you add in **Settings > Storage**. See [Moved photos](./library-folders.md#moved-photos).

## If you moved the folder yourself

Moved the trip's folder in Finder or File Explorer, or to a new computer? Point Lifer at it instead of importing again:

1. Click **⋯** > **Point to where I moved them**.
2. Choose where the trip's folder is now.
3. Lifer looks for each photo at its old place inside that folder, with the same size, and says how many it found, for example "Found 118 of 120 photos there". **Show details** lists the rest.
4. Click **Use this folder (118 of 120 found)**. Only the photos it found are updated. The others keep their old location. New photos for the trip are saved to this folder from then on.

Nothing is moved or copied. For a trip made from a folder, **Change** next to **Trip folder** picks where Lifer looks for new photos; it doesn't move anything either.

Lifer also keeps a small recovery file, `.lifer/index.json`, inside the trip's `Wildlife` folder. After a reinstall, it lets Lifer restore the species you'd assigned when you import the trip again.

## The trip page

- Edit the title and **Add a description…** by clicking them.
- A stats line shows species, lifers, rare and legendary species, and endemics from the trip.
- The toolbar has **View**, **Filters**, **Select** and **⋯** (**Add more photos**, **Move trip files to**, **Point to where I moved them**, **Look for moved photos**, **Set wildlife folder** and **Delete trip**), as on an album page.
- **View** > **Show** switches between **Species** and **Photos**. A trip with photos opens on **Species**, each card showing the trip's own best photo of that species. The search box works in both.
- The Species view has the Collection's toolbar: the same **View** (group, sort, card size, **Photographed first**, **Hide names** and the rest) and **Filters** (**Animals**, **Show**, **Rarity**, **Endemic**), applied to the trip's species. See [Filters, sorting and grouping](./collection-and-checklists.md#filters).
- Click a species card to open its species page. Your photos from this trip come first, under **From** and the trip's name, with **Open trip** to come back; the rest of that species' photos follow under **Other photos**.
- In the Photos view, open **View** to **Group** by species, broad group, family group or rarity, **Sort** by date or rating, change the thumbnail **Size**, or show **Labels**, **Camera info** and **Ratings** (the same choices as every other page with photos), and **Filters**, the same as the Gallery's (**Animals**, **Rating**, **Rarity**, **Region**, **Date**, **RAW files** and the rest) plus **Species**: tick one or more of the trip's species, each listed with its number of photos.
- Set a cover from a photo's **⋯** menu with **Use as trip cover**. The cover photo's menu then has **Cover style**, a **Single photo** or **Quad grid** cover, and for a single-photo cover, **Adjust position** sets the crop.
- A photo's **⋯** menu also has **Rate**, **View species**, **Download original**, **Download RAW** and **Delete photo**. In the full-screen view, the 1 to 5 keys rate the photo too.
- To delete several photos, click **Select**, click the photos, then **Delete selected**. Deleted photos go to the [Trash](./trash.md) for 7 days.
- To take photos out of the trip without deleting them, click **Select**, click the photos, then **Remove from trip**.

To rename or delete a trip, use the **⋯** menu on its card. Deleting a trip doesn't delete its photos. They just aren't grouped under it any more.

Trips can't be shared with a link. To share a trip's best photos, put them in an [album](./albums-and-sharing.md).
