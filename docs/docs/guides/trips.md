---
title: Trips
description: Point Lifer at a trip's folder, pick out the wildlife, and keep it sorted by species next to the trip.
---

# Trips

A trip points at a folder of photos, like everything from a week in Costa Rica. Lifer only reads that folder: it finds the photos, and you pick out the wildlife. The trip page shows what you photographed, how many lifers you got, and more.

Open **Albums & trips** in the top bar, then the **Trips** tab.

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

1. Click **Import trip**.
2. Enter a **Name**, like "Costa Rica 2026".
3. Under **Trip folder**, click **Choose a folder…** and pick the trip's folder.
4. Under **Save wildlife to**, keep the suggested `Wildlife` folder or click **Change** to pick another.
5. Click **Create trip**.
6. Lifer scans the folder. Photos it already knows are picked up automatically. New ones are listed for review. Photos you rejected in a culling app are left out by default; see [Culling with other apps](./culling-with-other-apps.md#trips).
7. Assign a species to each new photo: click **Type a species…** on its row and type a name, or tick several and use **Assign N selected to:**. Optionally pick a region under **Location for this batch (optional)**. Then click **Import N photos**.

Scanning and importing run in the background with a progress bar and a cancel button, so you can keep using Lifer.

On a server, the folder must be inside the library folder or an [extra library folder](../install/docker.md#extra-library-folders). Otherwise you'll see "Lifer doesn't have access to that folder."

## Build a trip from scratch

Use this when the photos are still on a memory card.

1. Click **Build a trip**.
2. Enter a **Name**, and under **Where should the trip folder go?** choose a parent folder. Lifer creates `<name>/Wildlife` inside it.
3. Click **Create folder & start**.
4. Drop the trip's photos into the upload area and assign species as in [batch import](./importing.md#choosing-species), with suggestions and keyboard shortcuts. The files are saved into the trip's folder.
5. To add the RAWs, use **Upload RAW files** below it. Each RAW is matched to a trip photo you've imported.

## Adding more photos later

Added new photos to the folder? Open the trip and click **Add more photos**. Lifer rescans the folder and only offers photos you haven't imported yet:

- New photos are listed for review.
- Files you moved or renamed inside the folder are relinked by their content.
- Missing files are kept and marked as missing, never deleted.
- New RAW files are linked to their JPEGs.

## If the folder moves

Click **Relocate…** next to the folder path on the trip page and choose the new location. This only updates the path Lifer has saved. It rescans and relinks your photos by their content, without moving or copying any files.

Lifer also keeps a small recovery file, `.lifer/index.json`, inside the trip's `Wildlife` folder. After a reinstall, it lets Lifer restore the species you'd assigned when you import the trip again.

## The trip page

- Edit the title and **Add a description…** by clicking them.
- A stats line shows species, lifers, rare and legendary species, and endemics from the trip.
- Switch between **Gallery** and **Species view**, and use **Search this trip's species…**.
- In the Gallery view, **Sort** by date or rating, open **Filters** for **Top rated**, **RAW files**, **Date** and **Labels**, and change the thumbnail **Size**.
- **Cover style** chooses a **Single photo** or **Quad grid** cover. Set a cover from a photo's **⋯** menu with **Set as featured photo**. For a single-photo cover, **Adjust position** sets the crop.
- A photo's **⋯** menu also has **View species**, **Download original**, **Download RAW** and **Delete photo**.
- To delete several photos, click **Select**, click the photos, then **Delete selected**. Deleted photos go to the [Trash](./trash.md) for 7 days.

To rename or delete a trip, use the **⋯** menu on its card. Deleting a trip doesn't delete its photos. They just aren't grouped under it any more.

Trips can't be shared with a link. To share a trip's best photos, put them in an [album](./albums-and-sharing.md).
