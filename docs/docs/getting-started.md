---
title: Getting started
description: Your first run of Lifer, from choosing a library folder to your first import.
---

# Getting started

This walks you through your first session: setting up, downloading a region, and importing your first photos. It takes about 15 minutes, plus download time.

## 1. Set up

### Desktop app {#desktop}

1. Open Lifer. The **Set up Lifer** window asks how you want to use it.
2. Click **Pick Local Storage Folder**. (Already run a Lifer server? Click **Connect to a Server** instead. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md).)
3. Choose a folder for your photo library, for example `Pictures/Lifer`. Lifer files your photos into species folders inside it. See [Library folders](./guides/library-folders.md).
4. Wait while Lifer sets up ("this can take a minute the first time").

You land on the Collection page with a **Welcome to Lifer** card. Continue with [step 2](#regions).

### Server {#server}

1. [Create the account](./install/docker.md#first-account) in your browser.
2. Lifer walks you through setup:
   - **Offline map:** leave **Download the offline map (recommended)** ticked to get the maps showing where each species is found (about 550 MB), then click **Continue**. You can skip it and add it later.
   - **Species matching:** click **Enable species matching** to download the models that suggest species while you import (about 620 MB, downloads in the background), or **Not now**.
   - **Download a region:** pick at least one country, optionally choose taxon groups, and click **Download N regions**. When it's done, click **Continue to Lifer**. This is the same as step 2 below.
   - **You're all set:** **Open the getting started guide** opens a short in-app tour, or click **Skip**.

## 2. Download your regions {#regions}

Lifer needs at least one region before there's anything to collect.

1. Click **Download a pack** on the welcome card, or go to **Settings > Library > Offline packs**.
2. Pick the countries you photograph in. Click them on the map, use the continent buttons, or type in **Search for a country…**.
3. Optionally, pick taxon groups (for example only Birds). Leave them all unselected to get every group. Reptiles & Amphibians and Marine Invertebrates open up to show their individual groups. Sharks, rays and marine mammals come with **Fish**.
4. Choose **Full** (every reference photo, fully offline) or **Small** (one photo per species, the rest load when you're online). Small versions aren't published for every country yet. If the size shown for Small is 0 B, use Full.
5. Click **Download selected**.

When it's done, go back to the Collection page. You'll see the country's checklist, with species you haven't photographed or marked seen shown dimmed.

Want insects, plants, fungi or other groups the packs don't cover? Add them from iNaturalist, one at a time or as a pasted list. See [Add insects, plants, fungi and more](./guides/inaturalist.md#any-taxa).

More in [Offline packs and the map](./guides/offline-packs-and-map.md).

## 3. Turn on species suggestions (optional) {#models}

Lifer can suggest the species in each photo as you import. It runs entirely on your computer or server, and your photos never leave it.

1. Open **Settings > Offline data**.
2. In **Species-matching model**, click **Download models (~620 MB)**.
3. Check that **Settings > Species and import > Suggest species while importing photos** is ticked. It's on by default, and greyed out until the model is downloaded.

The same download also lets you search the Gallery by describing a photo, like "owl flying".

If your computer or server has a graphics card, Lifer tests it and uses it for faster matching on its own. On a server, see [GPU acceleration](./install/hardware-acceleration.md) to pass it into the container.

## 4. Import your first photos {#first-import}

1. Click **Import** in the top bar to open the **Bulk import** page.
2. Optionally, type a **Location** for this batch, like "Prince George".
3. If suggestions are on, choose the **Region for species suggestions**.
4. Drag photos onto the page, or click **choose files** or **choose a folder**. You can include RAW files alongside the edited JPEGs; Lifer pairs them up.
5. For each photo, click a suggestion or click **Type a species…** and search. With the keyboard: use the arrow keys to pick a suggestion and press **Enter** to accept it and move to the next photo. <kbd>↑</kbd> reopens the previous photo if you accepted one by mistake.
6. Click **Import N photos**, or press **Enter** once every photo has a species.

Your photos appear on their species' pages, those species count as collected, and your life list grows. The full details are in [Importing photos](./guides/importing.md).

![Importing photos](/img/import.jpg)

## 5. Explore {#explore}

- **Collection** (the home page): your checklists by region. Filter to **Not yet collected** to see what you still need. See [Collection and checklists](./guides/collection-and-checklists.md).
- **Gallery**: every photo you've taken, searchable. See [Gallery and search](./guides/gallery-and-search.md).
- **Albums & trips**: group photos by theme, or point Lifer at a trip's folder. See [Trips](./guides/trips.md) and [Albums and sharing](./guides/albums-and-sharing.md).
- **Stats**: what your archive adds up to. See [Stats](./guides/stats.md).
- Press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux) to jump to a species, photo, region, trip, album or settings page. See [Quick search](./guides/gallery-and-search.md#quick-search).

Already have a big library? [Import an existing library](./guides/importing.md#existing-library) brings it in by reading the species tags already in your files.
