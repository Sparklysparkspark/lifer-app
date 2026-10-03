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

Choose how species folders (and the tags written into your files) are named in **Settings > Species and import > Species naming**. Tick any of these, and use the **↑** **↓** arrows to put them in the order you want:

| Option | Example |
|---|---|
| Common name | `American Robin` |
| Scientific (Latin) name | `Turdus migratorius` |
| eBird code | `amerob` |
| Full taxonomy tree | `Aves / Passeriformes / Turdidae / Turdus migratorius` |
| ABA code | `AMRO` |

The first one a species has becomes the name, and the rest follow in parentheses. For example, Common name then Scientific name gives `American Robin (Turdus migratorius)`. With three or more, the extras are separated by commas, like `American Robin (Turdus migratorius, amerob)`. eBird and ABA codes only apply to birds, so other species just skip them. The ABA code option appears once you download a pack covering North or Central America or the Caribbean.

If two species share a common name, Lifer adds the scientific name so their folders stay separate.

## Year and location folders {#organization}

In **Settings > Library > Photo library organization** you can add two more levels:

- **Year folders:** files each photo under `Wildlife <year taken>`, using the year the photo was taken. Photos with no date go under `Wildlife Undated`.
- **Location folders:** adds an outermost folder named after the **Location** you typed when importing. Photos without one stay where they'd otherwise go.

With both on, a photo lands in `Prince George/Wildlife 2025/Birds/American Robin/Adjusted/`.

## Applying changes to existing photos

Naming and organization settings only apply to new photos. To bring older photos in line:

- **Update existing photos to match** (under Species naming) renames species folders and refreshes the tags in your files.
- **Reorganize existing photos now** (under Photo library organization) moves files into the current folder scheme.

Both confirm first, then report how many files were changed, were already in place, or failed. Empty old folders are removed.

## Multiple drives {#drives}

A big archive is often spread over several drives. Lifer keeps track of which drive each photo is on and keeps a thumbnail of it, so you can still browse and search when a drive is unplugged. You'll know which drive to go and plug in.

### Desktop app

1. Open **Settings > Storage**.
2. In **External drives**, click **Add a drive…** and choose a folder on the drive.
3. Name it, for example "Red 2TB drive", and click **Register this folder**.

Lifer recognizes the drive by its hardware ID, so it still works if the drive mounts under a different name. If the drive already holds photos Lifer knew about before, it picks them up again and tells you how many.

Each drive in the list shows whether it's **Connected** (or when it was last seen), with **Rename**, **Set as default** and **Remove**. Removing a drive only stops Lifer checking for it. Photos already imported from it stay in your library.

To save new photos to a drive, use the **Save these photos to** choice when you [upload from a species page](./importing.md#species-page). New files go in a `Lifer Originals` folder on that drive, with the same layout. Lifer picks the connected drive that already has most of that species' photos, then your default drive, then the main library. If most of that species' photos are on a drive that isn't plugged in, it says so, so you can plug it in and keep them together. The **Bulk import** page always saves to the main library.

### Server

On a server, the administrator adds extra folders with `LIFER_LIBRARY_ROOTS`. **Settings > Storage > Library folders** lists them, read-only, with whether each one is found. See [Extra library folders](../install/docker.md#extra-library-folders).

### When a drive isn't connected

- Photos on it show a red dot: "Original unavailable. Connect "Red 2TB drive" to view it".
- The photo's **⋯** menu says **Connect "Red 2TB drive" to view this original**.
- Thumbnails still show. Viewing or downloading the full-size original has to wait until the drive is back.

Plug the drive back in and Lifer notices it on its own.

To bring photos from several drives together later, see [Reimport library](../settings.md#reimport).

## Moving your library {#moving}

**Desktop app:**

1. Open **Settings > Storage**.
2. In **Storage location**, click **Choose a different folder…** and pick the new place.
3. Confirm. Lifer moves every file and updates its records.
4. Restart Lifer.

**Server:** stop Lifer, move the folder, update `LIFER_STORAGE_DIR` in `.env`, then start it again. See [Volumes](../install/docker.md#volumes).

If you move or delete the library folder while Lifer is running, every page shows a "Lifer can't save photos right now" banner until you put it back or choose its new location, then restart.

## Using Lifer alongside other apps

Because Lifer writes species keywords, a hierarchical keyword and your rating into each file it stores, Lightroom, digiKam and Immich can read your species from the files. Point an Immich external library at the Lifer library folder for species-tagged photos in Immich too. Let Lifer be the one that changes species, since it rewrites those keywords.
