---
title: Library folders
description: How Lifer files your photos on disk, the naming options, multiple drives, and moving your library.
---

# Library folders

Lifer keeps your photos in a real, browsable folder tree, not hidden inside a database. You can open it in Finder or Explorer, point other apps like Immich at it, and back it up like any other folder.

## Folder layout

The folder you chose at setup **is** your library. Inside it, photos are filed by group, then species:

```text
<your library>/
  Birds/
    American Robin/
      Adjusted/   your edited JPEGs and PNGs
      RAW/        the matching RAW files
      Video/      MP4 and MOV clips
  Mammals/
  Reptiles/
  Nudibranchs/
  Insects/
```

- There's one group folder for each animal group Lifer has checklists for: `Birds`, `Mammals`, `Fish` (including sharks, rays and marine mammals), `Reptiles`, `Turtles`, `Amphibians`, `Corals`, `Jellies & Anemones`, `Echinoderms`, `Nudibranchs`, `Shells & Marine Mollusks`, `Cephalopods` and `Crustaceans`. A folder only appears once you have a photo in it.
- Species added from [iNaturalist](./inaturalist.md#any-taxa) (insects, plants, fungi and so on) use their iNaturalist group, like `Insects`, `Plants` or `Fungi`. If your [naming style](#naming) puts the scientific name first, it's `Insecta`, and with both it's `Insects - Insecta`.
- Files keep their original names. If two files have the same name, Lifer adds `-2`, `-3` and so on.
- Only photos Lifer stores are filed here. Photos from [trips](./trips.md) are filed the same way in the trip's own `Wildlife` folder, and photos imported from another folder without organizing stay where they are.

## Naming style {#naming}

Choose how species folders (and the tags written into your files) are named in **Settings > Species and import > Name format**. Tick any of these, and use the **↑** **↓** arrows to put them in the order you want:

| Option                  | Example                                                |
| ----------------------- | ------------------------------------------------------ |
| Common name             | `American Robin`                                       |
| Scientific (Latin) name | `Turdus migratorius`                                   |
| eBird code              | `amerob`                                               |
| Full taxonomy tree      | `Aves / Passeriformes / Turdidae / Turdus migratorius` |
| ABA code                | `AMRO`                                                 |

The first one a species has becomes the name, and the rest follow in brackets. For example, Common name then Scientific name gives `American Robin (Turdus migratorius)`. With three or more, the extras are separated by commas, like `American Robin (Turdus migratorius, amerob)`. eBird and ABA codes only apply to birds and are skipped for other species. The ABA code option appears once you download a pack covering North or Central America or the Caribbean.

If two species share a common name, Lifer adds the scientific name so their folders stay separate.

## Folder layout {#organization}

**Folder layout** in **Settings > Library** sets the folders above each photo. The presets file a photo like this:

| Preset                | Example                                                     |
| --------------------- | ----------------------------------------------------------- |
| Species (default)     | `Birds/American Robin/Adjusted/`                            |
| Order, then family    | `Birds/Passeriformes/Turdidae/American Robin/Adjusted/`     |
| Year, then species    | `Wildlife 2025/Birds/American Robin/Adjusted/`              |
| Date (like Lightroom) | `2025/2025-06-14/Adjusted/`                                 |
| Trip                  | `Trips/Alaska 2025/Birds/American Robin/Adjusted/`          |
| Location              | `Canada/Alberta/Pigeon Lake/Birds/American Robin/Adjusted/` |

**Custom** lets you pick and order the levels yourself, from year, month, date, trip, country, province or state, place name, group, order, family and species. Dates go by the camera's own clock. A level the photo has no value for is skipped: a photo outside a trip skips the trip folder, and one with no place name skips that folder. Photos with no date still go under `Wildlife Undated` in the year layout. A trip's own `Wildlife` folder never gets trip or location folders inside it.

With country, province or place folders in the layout, changing a photo's region or place name, or renaming a place in **Settings > Library > Places**, moves its files to match.

## Applying changes to existing photos

Naming and organization settings only apply to new photos. To bring older photos in line:

- **Update photos** (under **Rename existing photos** in **Settings > Species and import**) renames species folders and refreshes the tags in your files.
- **Reorganize** (under **Reorganize existing photos** in **Settings > Library**) moves files into the current folder scheme.

Both confirm first, then report how many files were changed, were already in place, or failed. Empty old folders are removed. Each file stays where it was kept: on its drive or library folder, or in its trip's folder. Files on a drive that isn't plugged in are left for next time.

When you correct a photo's species, its files move to the new species' folder in the same place: the same drive or trip folder, and the same year and location folders.

## Multiple drives {#drives}

A big archive is often spread over several drives. Lifer keeps track of which drive each photo is on and keeps a thumbnail of it, so you can still browse and search when a drive is unplugged. You'll know which drive to go and plug in.

### Desktop app

1. Open **Settings > Storage**.
2. In **External drives**, click **Add a drive** and choose a folder on the drive.
3. Name it, for example "Red 2TB drive", and click **Add drive**.

Lifer recognizes the drive by its hardware ID, so it still works if the drive mounts under a different name. If the drive already holds photos Lifer knew about before, it picks them up again and tells you how many.

Each drive in the list shows whether it's **Connected** (or when it was last seen), with **Rename**, **Make default** and **Remove**. Removing a drive only stops Lifer checking for it. Photos already imported from it stay in your library.

To save new photos to a drive, use the **Save these photos to** choice when you [upload from a species page](./importing.md#species-page). New files go in a `Lifer Originals` folder on that drive, with the same layout. Lifer picks the connected drive that already has most of that species' photos, then your default drive, then the main library. If most of that species' photos are on a drive that isn't plugged in, it says so, so you can plug it in and keep them together. The **Import photos** page always saves to the main library.

### Server

On a server, the administrator adds extra folders with `LIFER_LIBRARY_ROOTS`. **Settings > Storage > Extra library folders** lists them, read-only, with whether each one is found. See [Extra library folders](../install/docker.md#extra-library-folders).

### When a drive isn't connected

- Photos on it show a red dot: "Original unavailable. Connect "Red 2TB drive" to view it".
- The photo's **⋯** menu says **Connect "Red 2TB drive" to view this original**.
- Thumbnails still show. Viewing or downloading the full-size original has to wait until the drive is back.

Plug the drive back in and Lifer notices it on its own.

To bring photos from several drives together later, see [Import a library](../settings.md#reimport).

## Moved photos {#moved-photos}

Move or rename photos with Finder, File Explorer or another app, and Lifer finds them again. It only updates where it looks for each photo. It never moves, renames or changes your files.

It looks a few minutes after it opens, when a photo can't be opened, and when you open a trip with missing photos. Each photo is recognized by its size and a quick check of a small part of it, so thousands of photos are found in moments.

- **Found 12 moved photos** appears with **Undo** when it updates some. Undo puts back the old locations, and Lifer won't pick those files again.
- When two or more files could be the same photo, or one was probably edited in place, Lifer doesn't guess. Open **Settings > Storage**, click **Review** next to **Moved photos to review**, and click **Use this** on the right file, or **Skip** it. Each file shows beside the photo as Lifer has it; click either to see both full size. Skipped one by mistake? Click **Undo** in the message that appears.
- A trip whose photos all turned up in a new folder gets a **Use it** offer for that folder. See [If you move or reorganize photos](./trips.md#moved-photos).

### Settings

In **Settings > Storage** under **Moved photos**:

- **Look for moved photos automatically** is on by default. Turn it off to only look when you ask.
- **Places where photos live** lists the folders you added for Lifer to search, with how many in the heading. Add the folder that holds your photos, such as Family Trips: everything inside it is searched, so one entry is enough. Click **Add folder** to add one, and the remove button (x) on a row to take it off. Lifer only searches inside these folders, and doesn't follow shortcuts that lead outside them.
  - A folder inside one Lifer already searches isn't added again. Lifer says **Already covered by** and names that folder.
  - A folder that holds folders you added before offers to merge them into it. Click **Merge** to keep just the new one, or **Cancel**. **Undo** on the message puts them back.
  - A folder on a drive or network share that isn't connected isn't added. Connect it, then try again.
  - Your library folder, trip folders and watched folders are always searched. One line names how many; click **Show** to list them.
  - Long lists get a filter box. Hover over a folder to see its full path.
- **Look now** searches right away, with progress and **Cancel** at the bottom left.
- **Recently found** lists what Lifer updated, each with **Undo**.

If you moved a whole folder somewhere Lifer doesn't search, **Look now** can't find its photos. When the missing photos were all in one folder, Lifer offers **Moved a folder?** with **Choose folder**, after a look that found nothing, in **Settings > Storage**, and on the **Archive health** page. Pick the folder your photos are in now (the picker opens near where they were). Lifer adds it and looks again right away. It never guesses the new place for you.

Searching is quick after the first time: Lifer only rereads folders that changed since it last looked. Folders it isn't allowed to open are skipped, and it says how many. A photo on a drive that isn't plugged in isn't searched for; plug the drive in instead.

## Moving your library {#moving}

To move one trip's photos rather than the whole library, see [Move a trip's files](./trips.md#move-files). It can also move your own files linked where they are, if you ask: each is copied and checked before the original is removed.

**Desktop app:**

1. Open **Settings > Storage**.
2. In **Library folder**, click **Move** and pick the new place.
3. Confirm **Move and restart**. Lifer moves every file, updates its records and restarts itself on the new folder. Downloads pause and pick up again after the restart. If photos are still importing, Lifer asks you to wait for them first.

**Server:** stop Lifer, move the folder, update `LIFER_STORAGE_DIR` in `.env`, then start it again. See [Volumes](../install/docker.md#volumes).

If you move or delete the library folder while Lifer is running, a "Lifer can't save photos right now" banner appears under the toolbar:

- Put the folder back and click **Check again**. The banner goes away and saving works again, with no restart.
- Or click **Choose new location**, pick where the folder is now, and Lifer restarts on it (desktop app only).
- **Details** shows the full explanation. The close button hides the banner until Lifer next opens or something fails to save.

## Using Lifer alongside other apps

Because Lifer writes species keywords, a hierarchical keyword and your rating into each file it stores, Lightroom, digiKam and Immich can read your species from the files. Point an Immich external library at the Lifer library folder for species-tagged photos in Immich too. Let Lifer be the one that changes species, since it rewrites those keywords.
