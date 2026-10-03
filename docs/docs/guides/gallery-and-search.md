---
title: Gallery and search
description: Browse every photo, filter and sort, search by species, place, date or what's in the picture, and use quick search.
---

# Gallery and search

The **Gallery** shows every photo in your library, across all species. Open it from **Gallery** in the top bar.

Under the title, Lifer shows how many photos match your filters, like "12,480 photos". Large libraries open quickly: the Gallery loads 200 photos at a time and fetches more as you scroll.

By default, the Gallery shows photos only (no videos) and leaves out photos that have a RAW file. To see those too, change **Media type** and **RAW files** in [Filters](#filters). Lifer remembers these choices on this device.

## Searching your photos {#photo-search}

Type in **Search your photos…** at the top of the Gallery. Results appear once you've typed three characters. Try:

| You type | Lifer finds |
|---|---|
| `bald eagle`, `Haliaeetus leucocephalus`, `BAEA` | That species, by common or scientific name or bird code |
| `raptors`, `shorebirds`, `frog`, `Anatidae` | A whole group, order or family |
| `ducks in Canada 2024` | A group, in a place, in a year |
| `Prince George` | Photos from a region, or with a **Location** you typed at import |
| `last year`, `June`, `winter` | Dates, months and seasons |
| `600mm` | Photos taken at about that focal length |
| a tag you added | Photos with that tag, listed first |
| `owl flying`, `fox playing`, `water bird` | Photos that **look like** that description |

Next to the photo count, Lifer shows how it read your search, for example "ducks · Washington · 2024 · looks like "swimming"". Small spelling mistakes in species names are fine.

Searching by what's in the picture needs the species-matching model from **Settings > Offline data**. Without it, everything else in the table still works.

Search results are sorted by relevance, so the **Sort** menu is off while searching. Your search is part of the page address, so the back button brings it back.

## Filters and display {#filters}

**Sort** offers **Newest first**, **Oldest first**, **Highest rated first** and **Lowest rated first**. Unrated photos sort as if they had 3 stars.

**Filters** has:

- **Top rated** (5 stars) and **Featured** (species cover photos).
- **Media type**: **Both**, **Photos** or **Videos**. This only appears once you have videos.
- **RAW files**: **Any**, **With**, or **Without** a RAW.
- **Date**: a from and to range.
- **Region**, listing only regions you have photos from, plus **No region set yet**.
- **Tag** (once you've added tags) and **Taxon**, including groups you added from iNaturalist.
- **Display** options: **Labels** (species names), **Camera info**, **Ratings** (stars you can click to rate), and **Group by region**.

The number on the **Filters** button counts the filters you've changed, so you can tell why you're seeing fewer photos.

The **Size** slider changes thumbnail size.

### Showing one trip or album {#scoped}

The Gallery can be narrowed to a single trip or album. A chip like **In trip Costa Rica 2026** or **In album Portfolio** appears under the photo count. Click **×** on the chip to go back to your whole library.

You get there from [quick search](#quick-search): on a trip or album page, choose **Search all photos in this trip for "…"** (or album).

Other pages link into the Gallery with a filter already set, too. A tag's photo count in **Manage tags** shows photos with that tag, and **Archive health** on the [Stats](./stats.md) page shows photos missing a date so you can fix them.

## Working with photos

Hover a photo and click its **⋯**, or right-click it, for:

- **View species**
- **Set as featured** (or **Remove from featured**): makes it the species' cover photo.
- **Add to album…**
- **Edit tags…**
- **Correct the ID…**
- **Download original** and **Download RAW**, when there's one.
- **Reveal in Finder**, on the desktop app, for photos kept in your own folders.
- **Delete photo** (or **Delete video**). It goes to the [Trash](./trash.md).

### Selecting many photos {#select}

1. Click **Select** (or press <kbd>S</kbd>).
2. Click photos to select them. <kbd>Shift</kbd>-click selects everything between the last photo you clicked and this one. You can also press and drag across photos.
3. <kbd>Cmd</kbd>+<kbd>A</kbd> (<kbd>Ctrl</kbd>+<kbd>A</kbd> on Windows and Linux) selects everything that matches your search and filters, not just what you've scrolled to. If some photos aren't loaded yet, a small spinner shows while Lifer loads the rest first.

The toolbar shows how many are selected and offers:

- **Correct ID to:** change the species of all of them.
- **Add tag:** tag them all. Click **Done** when you're finished.
- **Add to album**, or create a **New album…**.
- **Delete selected** (or press <kbd>Delete</kbd> or <kbd>Backspace</kbd>). If any of them have a RAW file, you can also tick **Also delete the matching RAW file when this is permanently removed**. Deleted photos go to the [Trash](./trash.md) for 7 days.

Press <kbd>Esc</kbd> or click **Cancel** to leave select mode.

### The photo viewer

Click a photo to open it full screen.

| Key | What it does |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> | Previous or next photo, wrapping around at the ends. In a video, skip 10 seconds. |
| <kbd>1</kbd> to <kbd>5</kbd> | Set the star rating. Press the same number again to clear it. |
| <kbd>F</kbd> | Full screen |
| <kbd>Space</kbd> | Play or pause a video |
| <kbd>Esc</kbd> | Leave full screen, then close |

To zoom, pinch on a trackpad or hold <kbd>Ctrl</kbd> and scroll (up to 4x). Double-click to zoom to 2x, and again to zoom back out. Once zoomed, drag or scroll to move around. The caption shows the species, date, camera settings and file names, and lets you edit tags.

## Tags

Tags are your own labels, like "courtship" or "backyard". Add them from a photo's **⋯** menu, in the viewer, or to many photos at once in select mode. Manage them in **Settings > Library > Manage tags**, where you can rename (or merge) and delete tags.

## Quick search {#quick-search}

Press <kbd>Cmd</kbd>+<kbd>K</kbd> on a Mac or <kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux, from any page (even while typing in a box), to open quick search. Press the shortcut again, click **×** or press <kbd>Esc</kbd> to close it.

Before you type, it shows your **Recent searches**, your **Recent species** (the ones you most recently added photos of), and a **Go to** list: **Import photos**, **Gallery**, **Albums and trips**, **Stats**, **Offline packs**, **Trash** and **Help and user guide**.

Start typing to find, in groups:

| Group | What's in it |
|---|---|
| **Species** | Species by common name, scientific name or bird code |
| **Your photos** | Up to six matching photos as thumbnails (from three characters on), plus **Search all photos for "…"**, which opens the [Gallery search](#photo-search) |
| **Regions** | Countries, states and provinces, also by eBird region code |
| **Trips** and **Albums** | Yours, by name |
| **Settings** | Settings pages, like **Library** or **Integrations** |
| **Go to** | The same pages as before you typed |

Clicking a photo opens its species page. Photo results follow the Gallery's **Media type** and **RAW files** choices, so quick search never shows a photo the Gallery is set to hide.

If [any-taxa search](./inaturalist.md#any-taxa) is on, the **Species** group ends with **Search iNaturalist**, to add a species Lifer has no data for.

### It follows the page you're on

- **On the Collection page or a species page for a region**, a chip like **In British Columbia** appears under the box, and species from that region come first (the group reads "Species, British Columbia first"). Click **×** on the chip to search everywhere instead.
- **On a trip or album page**, an extra group, **Photos in this trip** or **Photos in this album**, shows matching photos from it. Its last entry, **Search all photos in this trip for "…"**, opens the Gallery [narrowed to that trip or album](#scoped).

### Keyboard

Use <kbd>↑</kbd> <kbd>↓</kbd> to move through results (across groups, wrapping at the ends), <kbd>Enter</kbd> to open the highlighted one, and <kbd>Esc</kbd> to close. Choosing a recent search puts it back in the box so you can pick a result. Lifer remembers your last eight searches on this device.
