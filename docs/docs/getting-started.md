---
title: Getting started
description: Your first run of Lifer, from choosing a library folder to your first import.
---

# Getting started

This walks you through your first session: setting up, choosing your regions, and importing your first photos. It takes about 15 minutes, plus download time. Every setup step has a **Back** button, so you can change your mind.

## 1. Set up

### Desktop app {#desktop}

1. Open Lifer. **Welcome to Lifer** explains what it does. Click **Get started**.
2. **Where should your library live?** Click **On this Mac** (or **On this computer**). Already run a Lifer server? Click **On my Lifer server** instead. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md).
3. Choose a folder for your photo library, for example `Pictures/Lifer`. Lifer files your photos into species folders inside it. See [Library folders](./guides/library-folders.md).
4. Wait while Lifer sets up. A progress bar shows how far along it is; this only happens the first time.

Lifer then walks you through the three setup steps below. If the folder already holds a Lifer library, from an earlier install, setup says so, chooses the countries and animal groups it had, and at the end brings back its photos by itself, with your seen and target species, card covers and crops.

### Server {#server}

1. [Create the account](./install/docker.md#first-account) in your browser.
2. Lifer walks you through the three setup steps below.

### The setup steps {#setup-steps}

1. **Where do you photograph wildlife?** Click countries on the map, search for one, or click the suggestion for your own country. Click a chosen country again to remove it. Click **Continue**. On a first launch the countries appear once Lifer has its species list ready. It shows **Loading…** at first, then the time left once it can measure it.
2. **Which animals do you photograph?** Nothing is chosen to start with: pick the groups you photograph (or **Add all**), then click **Download**. A progress bar shows what is downloading, with the time left once Lifer can measure it. Once nothing is left to download it reads **Setting up on this computer**, which doesn't use the internet. A few tips about Lifer (each with a link to its guide) keep you company while you wait. Once the downloads have started, **Continue in the background** takes you to your collection straight away.
3. **You're all set.** This appears as soon as your first country's first animal group is set up. Click **Go to my collection** or **Import your first photos**. The other groups and countries carry on in the background, with their progress at the bottom left of the window. Short hints appear the first time a feature matters.

Meanwhile, the offline map (about 640 MB) and species recognition (about 680 MB) download in the background by themselves, with their progress shown at the bottom of setup. You can remove the map later in **Settings > Species and import > Species downloads**, and species recognition in **Settings > Offline data**.

## 2. Download your regions {#regions}

Setup downloads your first regions. To add more later:

1. Open **Settings > Species and import > Species downloads**.
2. Pick the countries you photograph in. Click them on the map, use the continent buttons, or type in **Search for a country…**.
3. Pick the animal groups you photograph (for example only Birds), or click **Select all** for every group. At least one is needed. Reptiles & Amphibians and Marine Invertebrates open up to show their individual groups. Sharks, rays and marine mammals come with **Fish**.
4. Choose **Full** (every reference photo, fully offline) or **Small** (one photo per species, the rest load when you're online). Small versions aren't published for every country yet. If the size shown for Small is 0 B, use Full.
5. Click **Download selected**.

When it's done, go back to the Collection page. You'll see the country's checklist, with species you haven't photographed or marked seen shown dimmed.

Want insects, plants, fungi or other groups the downloaded regions don't cover? Add them from iNaturalist, one at a time or as a pasted list. See [Add insects, plants, fungi and more](./guides/inaturalist.md#any-taxa).

More in [Regions and the map](./guides/offline-packs-and-map.md).

## 3. Species suggestions {#models}

Lifer suggests the species in each photo as you import. It runs entirely on your computer or server, and your photos never leave it. Species recognition downloads by itself during setup (about 680 MB); there's nothing to turn on.

If you'd rather not use it, open **Settings > Offline data** and click **Remove** in **Species recognition**. It stays removed until you click **Download** again. **Settings > Species and import > Suggest species while importing photos** turns the suggestions off without removing anything.

The same download also lets you search the Gallery by describing a photo, like "owl flying".

If your computer or server has a graphics card, Lifer tests it and uses it for faster species recognition on its own. On a server, see [GPU acceleration](./install/hardware-acceleration.md) to pass it into the container.

## 4. Import your first photos {#first-import}

1. Click **Import photos** in the toolbar (or press Command-I in the desktop app) to open the **Import photos** page.
2. Optionally, type a **Location** for this batch, like "Prince George".
3. If suggestions are on, choose the **Region for species suggestions**.
4. Drag photos onto the page, or click **choose files** or **choose a folder**. You can include RAW files alongside the edited JPEGs; Lifer pairs them up.
5. For each photo, click a suggestion or click **Type a species…** and search. With the keyboard: use the arrow keys to pick a suggestion and press **Enter** to accept it and move to the next photo. <kbd>↑</kbd> reopens the previous photo if you accepted one by mistake.
6. Click **Import N photos**, or press **Enter** once every photo has a species.

Your photos appear on their species' pages, those species count as photographed, and your life list grows. The full details are in [Importing photos](./guides/importing.md).

![Importing photos](/img/import.jpg)

## 5. Explore {#explore}

- **Collection** (the home page): your checklists by region. Filter to **Not yet photographed** to see what you still need. See [Collection and checklists](./guides/collection-and-checklists.md).
- **Gallery**: every photo you've taken, searchable. See [Gallery and search](./guides/gallery-and-search.md).
- **Albums**: your own albums of photos grouped by theme, and below them your **Trips**, each built from a trip's folder or started before you go. See [Albums and sharing](./guides/albums-and-sharing.md) and [Trips](./guides/trips.md).
- **Stats**: what your archive adds up to. See [Stats](./guides/stats.md).
- Press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux) to jump to a species, photo, region, trip, album or settings page. See [Quick search](./guides/gallery-and-search.md#quick-search).

### Take the tour {#tour}

The tour points at each main part of Lifer in turn, in a few short steps. Start it from **Take the tour** at the end of setup, in **Settings > General > Tips**, or by searching for it with <kbd>Cmd</kbd>+<kbd>K</kbd>. Use **Next** and **Back** or the arrow keys; <kbd>Esc</kbd>, **Skip** or clicking any page ends it.

Already have a big library? [Import an existing library](./guides/importing.md#existing-library) brings it in by reading the species tags already in your files.
