---
title: Gallery and search
description: Browse every photo, filter and sort, search by species, place, date or what's in the picture, and use quick search.
---

# Gallery and search

The **Gallery** shows every photo in your library, across all species. Open it from **Gallery** in the top bar.

Under the title, Lifer shows how many photos match your filters, like "12,480 photos". The Gallery loads 200 photos at a time and fetches more as you scroll.

By default, the Gallery shows photos only (no videos). A photo you imported as a RAW alone shows like any other, and a RAW imported with its edited copy shows once, as the edited photo. Change **Media type** and **RAW files** in [Filters](#filters) to see videos or narrow the RAWs. Lifer remembers these choices on this device.

## Searching your photos {#photo-search}

Type in **Search your photos…** at the top of the Gallery. Results appear once you've typed three characters. Try:

| You type                                            | Lifer finds                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `bald eagle`, `Haliaeetus leucocephalus`, `BAEA`    | That species, by common or scientific name or bird code                                                                    |
| `raptors`, `shorebirds`, `frog`, `Anatidae`         | A whole group, order or family                                                                                             |
| `ducks in Canada 2024`                              | A group, in a place, in a year                                                                                             |
| `Prince George`, `mallard pigeon lake`              | Photos from a region, or with a place name you typed (case and accents don't matter), on its own or with species and dates |
| `last year`, `June`, `winter`, `last spring`        | Dates, months and seasons. `last spring` is the most recent spring that's over, `this December` is December of this year   |
| `my best eagle shot`, `top owls`, `favorite photos` | Highest rated first (unrated counts as 3 stars)                                                                            |
| `600mm`                                             | Photos taken at about that focal length                                                                                    |
| a tag you added                                     | Photos with that tag, listed first                                                                                         |
| `owl flying`, `fox playing`, `water bird`           | Photos that **look like** that description                                                                                 |

Next to the photo count, Lifer shows how it read your search, for example "ducks · Washington · 2024 · looks like "swimming"". Small spelling mistakes in species names are fine.

### Counting animals {#counts}

Lifer counts the animals in each photo, so you can search by how many: `3 birds`, `pair of eagles`, `group of five`, `a few ducks`, `50 geese`, `herd of deer` or `thousands of birds`. Up to ten is an exact count, larger numbers are a rough one ("about 50"). The detector can miss small, distant animals, so a huge crowd (`hundreds`, `huge flock`) also finds photos that look like one. Photos imported before counting was added are counted in the background, and until then they're judged by how they look.

Collective nouns work too, as a small easter egg: `murder of crows`, `parliament of owls`, `gaggle of geese` or `pride of lions` find two or more of that animal, and `gaggle` on its own means geese. A `murder of crows` includes ravens, jays and the rest of the crow family. With a different animal, the words keep their usual meaning: `murder of ducks` finds ducks being hunted.

### More ways to search {#more-search}

- **Firsts and lifers**: `my first bald eagle` finds the first photo you took of it, `lifers` the first photo of each species. Add a place or date: `lifers in costa rica`, `new species this year`.
- **Rarity**: the rarity tier names find species of that tier (`common`, `occasional`, `uncommon`, `rare`, `legendary`, as in `rare owls` or `rare or legendary`), `endemics` keeps species found in only one country or region, and `rarest` puts the rarest first.
- **Filters as words**: `5 stars`, `4+ stars`, `unrated`, `videos`, `raw`, `edited`, `hidden`, `no location` and `no date` work like the matching filters, and only narrow what the **Filters** menu already shows.
- **Leaving things out**: `ducks not mallards`, `birds except owls`, or `birds without people` to drop photos that clearly show people. `owls or hawks` finds either.
- **Newest and oldest**: `latest owl`, `my last bald eagle` or `oldest photo of a moose` puts that one photo first, with the rest below.
- **Shot type**: `flight`, `behaviour`, `at rest`, `close up` (or `portrait`) and `environmental` work like the **Shot type** filter, and combine: `environmental flight`, `close-up behaviour`, `heron in flight`.
- **Camera**: `R5`, `iphone` or `shot on R50` keeps photos from a camera you've used.
- **File name**: `6F9A8042.CR3` or `IMG_1234` shows just the photo with that file, including its RAW and edited versions. The extension is optional, and part of a name (`6F9A804`) finds every file starting with it, exact names first.
- **Time of day**: `golden hour`, `sunrise`, `sunset`, `night`, `morning`, `midday`, `afternoon` and `evening`. For photos with GPS coordinates, Lifer works out where the sun was. Photos without them are judged by how they look.
- **Photo styles**: `black and white` (or `b&w`, `monochrome`), `minimalist`, `high key`, `low key`, `backlit`, `golden light`, `bokeh`, `motion blur`, `sharp` and `blurry` are judged by how the photo looks. `black and white bird` means a bird with those colours instead.

Searching by what's in the picture needs species recognition from **Settings > Offline data**. Without it, everything else in the table still works.

Search results are sorted by relevance (or highest rated first when you type `best`), so the **Sort** menu is off while searching. Your search is part of the page address, so the back button brings it back.

## View and filters {#filters}

**View** sets how the photos are shown, not which ones:

- **Show as**: **Grid**, or **Map** to see where they were taken (see [Photo map](./photo-map.md)). On the map, the other View choices don't apply.
- **Group**: **No grouping**, **Region**, **Broad group**, **Family group**, **Rarity**, or (with a region filter) **Rarity here**.
- **Sort**: **Newest first**, **Oldest first**, **Highest rated first** and **Lowest rated first** (unrated photos sort as if they had 3 stars), or the Collection's species orders: **Field guide order**, **Common name**, **Scientific name** and **Rarity** (rarest first). The species orders keep each species' photos together, newest first. Albums and trips offer the same sorts; a species page sorts by date and rating only.
- **Size**: the thumbnail size.
- **Labels** (species names), **Camera info** and **Ratings** (stars you can click to rate) under each photo. They start off; turn on the ones you want. Albums, trips and species pages offer the same three, and share your choice.
- **Version labels**: the stack badge like **3 versions** on a photo with versions, and a version's name when it has a card of its own. On by default; turn it off to hide them in every photo grid.
- **Show every version and RAW as its own photo**: lists each print, edit, export and RAW as its own card instead of one per photo (see [Photo versions](./photo-versions.md#how-counts-work)). It appears once any of your photos has versions.
- **Group bursts**: shows each burst as one photo, its highest rated (or its first) with the **+N** badge (see [Bursts and scenes](#bursts)). It starts off and Lifer remembers your choice.

**Filters** sets which photos show:

- **Animals**, including groups you added from iNaturalist.
- **Searching in**: the trip or album the search is limited to, when it is (see [below](#scoped)).
- **Show only**: **Featured** (species cover photos), **Hidden**, **Missing a date** and **Needs placing** (no coordinates, so no dot on the map, even with a country or province).
- **Rating**: **Any rating**, at least 1 to 4 stars (with an optional **Up to** for a range like 3 to 4 stars), exactly **5 stars**, or **Unrated**.
- **Number of animals**: **Exactly** or **At least** a number. Photos not counted yet are left out until they are.
- **Rarity**.
- **Shot type**, read from each photo on two separate scales, the same way Stats counts them:
  - **Action**: **Flying**, **Behaviour** (eating, hunting, fighting, playing, bathing) or **At rest** (perched, standing, swimming, walking).
  - **Framing**: **Close** (a portrait, the animal large in the frame) or **Environmental** (small in a wide scene).

  Pick any number in each. Choices in one group widen it (**Flying** or **Behaviour**); the two groups narrow each other (**Flying** and **Environmental**). Shot type needs species recognition from **Settings > Offline data**.

- **Region**, listing only regions you have photos from, plus **No region set yet**.
- **Place name**: start typing and pick one of your place names (only names used in the **Region** filter's region when one is set). Click **×** on it to clear it.
- **Tag**, once you've added tags.
- **Date**: a from and to range.
- **Media type**: **Both**, **Photos** or **Videos**. This only appears once you have videos.
- **RAW files**: **Show**, **Hide** or **Only** the photos that are just a RAW, with no edited copy, or **Not edited yet** (see [Find photos that still need editing](#editing-backlog)).
- **Edited photos**: **Any**, **With RAW** or **Without RAW**.

The number on the **Filters** button counts the filters you've changed, so you can tell why you're seeing fewer photos. The number on **View** counts a grouping or sort you've changed.

### Showing one trip or album {#scoped}

The Gallery can be narrowed to a single trip or album. A chip like **In trip Costa Rica 2026** or **In album Portfolio** appears under the photo count. Click **×** on the chip to go back to your whole library.

**Open in Gallery** on an area of the [photo map](./photo-map.md#open) adds a chip too, **In a map area**, for the photos taken there.

You get there from [quick search](#quick-search): on a trip or album page, choose **Search all photos in this trip for "…"** (or album).

Other pages link into the Gallery with a filter already set, too. A tag's photo count on the **Tags** page shows photos with that tag, a place on the **Places** page shows the photos with that place name (it shows under **Place name** in **Filters**), and **Library health** on the [Stats](./stats.md) page shows photos missing a date or a region so you can fix them. Photos missing a date each get a date box. Photos missing a region open in select mode: select the ones taken in one place, choose **Set region…**, and repeat until none are left.

### Find photos that still need editing {#editing-backlog}

In **Filters**, set **RAW files** to **Not edited yet**. The Gallery then shows only RAW photos with no edited version: no JPEG, TIFF or PNG beside the RAW, and none linked to it as a [version](./photo-versions.md). Search and the other filters still apply, **Back** returns to it, and **Clear all filters** turns it off. Albums and trips have it in the same **Filters** menu.

Only edits Lifer has linked count. An edit Lifer hasn't grouped with its RAW is a photo of its own, so the RAW stays on this list until you link them (see [Link a version yourself](./photo-versions.md#link-a-version-yourself)). A JPEG your camera saved beside the RAW counts as an edit.

For whole species, open **Filters** on the Collection, or on a trip's or album's species view, and tick **Only RAW photos so far**: it lists the species whose every photo is still a RAW with no edited version. Their cards say **RAW only**, unless something rarer about the species is shown there instead.

## Working with photos

Hover a photo and click its **⋯**, or right-click it, for:

- **Rate**: click a star.
- **View species**
- **Similar photos**: the photo's [near-identical group](#similar-photos), its burst or repeated shots.
- **Set as featured photo** (or **Remove as featured photo**, which goes back to Lifer's own pick): the photo shown on the species' card.
- **Add to album**
- **Edit tags**
- **Correct the ID**: pick the species it really shows. Above the search, **Could also be** lists the other species the photo most likely shows, with how closely each matches (once species matching has compared it). A message says where it moved, with **View** to go there and **Undo** to move it back.
- **Download original** and **Download RAW**, when there's one. A "Preparing download..." message shows while a large file is fetched.
- **Reveal in Finder**, on the desktop app.
- **Hide photo**: keeps a weak photo out of the Gallery, your life list and Stats without deleting it. Find it again under **Hidden** in the Gallery's **Filters**, or click **Undo** on the message, which also makes it the featured photo again if you had picked it as one. A featured photo Lifer chose for you is picked again by the usual rules. See [Hidden photos](./culling-with-other-apps.md#hidden).
- **Delete photo** (or **Delete video**). It goes to the [Trash](./trash.md).

### Selecting many photos {#select}

1. Click **Select** (or press <kbd>S</kbd>).
2. Click photos to select them. <kbd>Shift</kbd>-click selects everything between the last photo you clicked and this one. You can also press and drag across photos.
3. <kbd>Cmd</kbd>+<kbd>A</kbd> (<kbd>Ctrl</kbd>+<kbd>A</kbd> on Windows and Linux) selects everything that matches your search and filters, not just what you've scrolled to. If some photos aren't loaded yet, a small spinner shows while Lifer loads the rest first.

The toolbar shows how many are selected. Each action that needs a choice opens its own small dialog:

- **Compare**, with 2 to 4 selected: see them [side by side](#compare).
- **Correct ID…**: change the species of all of them.
- **Add tag…**: tag them all. Click **Done** when you're finished.
- **Rate…**: give them all the same star rating.
- **Set appearance**: give them all the same life stage, sex, plumage or colour morph. A field left at **Leave as is** keeps each photo's own.
- **Set region…**: pick the country, state or province where they were all taken, by searching for it, drilling in, or clicking a **Suggested:** region. Optionally type a **Place name** for them all too; left blank, each photo keeps its own. A toast offers **Undo** when no place name was set.
- **Add to album…**, or create a **New album…**.
- **Download originals**: saves each selected photo's original, one after another, including photos **Select all** picked that haven't scrolled into view yet.
- **Hide**: hides them all, as **Hide photo** does.
- **Delete selected** (or press <kbd>Delete</kbd> or <kbd>Backspace</kbd>). If any of them have a RAW file, you can also tick **Also delete the matching RAW file when this is permanently removed**. Deleted photos go to the [Trash](./trash.md) for 7 days.

Actions that don't fit the window's width move into **More** at the end of the toolbar. When you open the Gallery from Stats to fix photos missing a region, **Set region…** comes first.

### Fixing a wrong camera clock {#adjust-time}

If your camera's clock was off, or you forgot to change its time zone on a trip, select the photos and choose **More > Adjust date and time…**. Then either:

- **Shift by**: move them all **Later** or **Earlier** by a number of days, hours and minutes, or
- **Set this photo's time**: type the correct date and time for the photo shown (the first one you selected), and every selected photo moves by the same difference.

The dialog shows the earliest and latest photo's time before and after, and how many photos will change. Photos with no date are skipped, and videos move along with photos.

Lifer changes its own dates and writes the new time into your files the way it writes species and ratings: inside a JPEG, TIFF or DNG, and in the `.xmp` sidecar for a RAW or video (the RAW file itself is never changed). Files outside your library that Lifer only links to keep their time. A large selection shows its progress. When it's done, **Undo** in the message moves the same photos back; choosing the opposite shift later does the same. Folders named by date only change when you run **Settings > Library > Reorganize**.

Press <kbd>Esc</kbd> or click **Cancel** to leave select mode.

### The photo viewer

Click a photo to open it full screen.

![The photo viewer](/img/photo-viewer.jpg)

| Key                                         | What it does                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| <kbd>←</kbd> <kbd>→</kbd>                   | Previous or next photo, wrapping around at the ends. In a video, skip 10 seconds.                                                                     |
| <kbd>1</kbd> to <kbd>5</kbd>                | Set the star rating. Press the same number again to clear it.                                                                                         |
| <kbd>F</kbd>                                | Full screen (hidden when Lifer is already full screen)                                                                                                |
| <kbd>Option</kbd>+<kbd>←</kbd> <kbd>→</kbd> | Previous or next version of the photo (<kbd>Alt</kbd> on Windows and Linux). See [Photo versions](./photo-versions.md#seeing-and-switching-versions). |
| <kbd>Cmd</kbd>+<kbd>0</kbd>                 | Fit the photo to the window again after zooming (<kbd>Ctrl</kbd>+<kbd>0</kbd> on Windows and Linux)                                                   |
| <kbd>Space</kbd>                            | Play or pause a video                                                                                                                                 |
| <kbd>Esc</kbd>                              | Leave full screen, then close                                                                                                                         |

To zoom, pinch on a trackpad or hold <kbd>Ctrl</kbd> and scroll (up to 6x), or press <kbd>+</kbd> and <kbd>-</kbd>. Zooming centres on the pointer. Double-click to zoom to 2.5x, and again to zoom back out. The viewer and compare zoom the same way. Once zoomed, drag or scroll to move around; the photo stops at its edges, and the controls hide until you zoom back out. The caption shows the species, date, star rating, camera settings and file names, and lets you edit tags. Click a star to rate, or **Correct the ID** to move the photo to another species.

**Add appearance** under the stars records how the animal looks: its life stage (egg to adult), sex, plumage (like breeding or eclipse) and colour morph (like a dark morph), so a juvenile or a rare morph that looks nothing like the usual adult is easy to tell apart. What you set shows as small labels in the viewer, and a species page lists the stages and morphs among your photos of it. Appearance syncs with a linked server like other edits; it isn't written into the photo files.

### Adding coordinates {#coordinates}

For a photo your camera didn't place, click **Add location coordinates** under it in the viewer (or **Edit coordinates** to change a point). For many photos, select them and choose **More > Add location coordinates…**. Paste or type a latitude and longitude in any of these forms:

- Decimal degrees: `49.2827, -123.1207`
- Google Maps' degrees, minutes and seconds: `49°16'57.7"N 123°07'14.5"W`
- Apple Maps: `49.2827° N, 123.1207° W`
- Degrees and decimal minutes: `49 16.962 N, 123 7.242 W`

The fastest way for many photos is the map: select them and choose **Place on map** (see [Placing photos](./photo-map.md#placing)). The dialog suits a point you already have as text.

The dialog shows how it reads what you typed, or why it can't use it. If the photos have no region yet, it offers the region the point falls in as a checkbox; nothing is set unless you tick it. **Clear coordinates** removes the point.

Lifer writes the point into your files like species and ratings: inside a JPEG, TIFF or DNG (replacing the camera's own GPS there), and in the `.xmp` sidecar for a RAW or video. Files outside your library that Lifer only links to keep theirs.

## Bursts and scenes {#bursts}

A **burst** is the photos one camera took in one press of the shutter. A **scene** is the bursts you took one after another at one sighting. In the grid, a photo that is part of a burst shows **+N** in its corner, for the other photos in it.

In the photo viewer, a strip under the caption shows the photo's burst and the scene around it. The open burst shows every photo; each other burst is one photo with its count. Click a photo, or a burst to open it, and the viewer moves there. With the strip focused, <kbd>←</kbd> <kbd>→</kbd> move along it and <kbd>Home</kbd> <kbd>End</kbd> jump to its ends. A photo with nothing taken around it has no strip. When you open a photo the grid doesn't show (a filter hides it), the viewer's arrows then step through that scene's photos until you close it.

How Lifer groups them, from the capture time, camera, lens, location and the picture itself:

- **Bursts**: photos from the same camera taken less than half a second apart. For a photo whose time Lifer has only to the second (most photos), it's one second. A burst is cut where the picture changes completely, and two parts up to 15 seconds apart that look almost the same are joined.
- **Scenes**: a new scene starts after a gap of more than 5 minutes, a move of more than 200 m (when the photos have coordinates), or when the next burst shows something else. A photo not yet compared by species matching is kept apart by a change of camera or lens, or a gap well over your usual gap between bursts (at least 2 minutes).
- Videos and sound recordings aren't part of bursts. A RAW and its JPEG are one photo, and so are a photo's versions.
- The strip holds up to the 300 photos nearest the open one, and says so when a scene has more.

Lifer works the groups out as you look, from the photos already in your library. Nothing is changed or written to your files.

## Similar photos {#similar-photos}

Bursts and repeated shots pile up near-identical frames. Lifer groups photos of one species taken within 15 seconds that look almost the same, or within 3 minutes that look nearly identical, by comparing the pictures themselves (the same comparison species matching uses). Photos with no date, and new photos still waiting for species matching, aren't grouped.

- **One photo's group**: choose **Similar photos** from its **⋯** menu, or in the viewer's caption. The Gallery shows just that group, under a **Similar photos** chip; click the chip's **×** (or go back) to return to your search and filters as they were.
- **Every group**: in the Gallery, click **⋯ > Find similar photos** (or search for it in [quick search](#quick-search)). Groups are listed largest first, with their species, when they were taken and how many photos they hold. Click one to open it.

In a group, select photos to **Compare**, rate, hide or delete them as usual. Lifer only suggests the groups: it never hides or deletes anything by itself.

The first look through a large library can take a few seconds. After that, only the groups a new import or change touched are worked out again.

### Compare {#compare}

Select 2 to 4 photos and click **Compare** to see them side by side, with the date to the second, camera settings and rating under each. Zooming or moving one zooms and moves them all to the same spot, so you can check which frame is sharpest. Pinch, hold <kbd>Ctrl</kbd> and scroll, or double-click to zoom; drag or scroll to move around; click **Fit** to zoom back out.

| Key                          | What it does                                                              |
| ---------------------------- | ------------------------------------------------------------------------- |
| <kbd>←</kbd> <kbd>→</kbd>    | Move the outline to the previous or next photo                            |
| <kbd>1</kbd> to <kbd>5</kbd> | Rate the outlined photo; the same number again clears it                  |
| <kbd>0</kbd>                 | Clear the outlined photo's rating                                         |
| <kbd>F</kbd>                 | Set the outlined photo as the featured photo                              |
| <kbd>C</kbd>                 | Make the outlined photo the album cover (in an album)                     |
| <kbd>+</kbd> <kbd>-</kbd>    | Zoom in or out                                                            |
| <kbd>Cmd</kbd>+<kbd>0</kbd>  | Fit every photo again (<kbd>Ctrl</kbd>+<kbd>0</kbd> on Windows and Linux) |
| <kbd>Esc</kbd>               | Close                                                                     |

On a phone, Compare shows two photos at a time: tap the better one and it meets the next, until one is left. Then you can use it as the featured photo or album cover, rate it, or start over.

## Tags

Tags are your own labels, like "courtship" or "backyard". Add them from a photo's **⋯** menu, in the viewer, or to many photos at once in select mode. Manage them from **Settings > Library > Tags**, where you can rename (or merge) and delete tags.

Lifer also writes your tags into the photo files it keeps, as ordinary keywords, so Lightroom, digiKam and other apps show them, and a [reimport](../settings.md#reimport) brings them back. Renaming or deleting a tag updates the files too. Keywords you added in other apps are left alone. Photos kept in your own folders (linked, not copied) are never changed.

## Quick search {#quick-search}

Press <kbd>Cmd</kbd>+<kbd>K</kbd> on a Mac or <kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux, from any page (even while typing in a box), to open quick search. Press the shortcut again, click **×** or press <kbd>Esc</kbd> to close it.

Before you type, it shows your **Recent searches**, your **Recent species** (the ones you most recently added photos of), and a **Go to** list: **Import photos**, **Gallery**, **Albums**, **Trips**, **Stats**, **Species downloads**, **Trash** and **Help and user guide**.

Start typing to find, in groups:

| Group                    | What's in it                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Species**              | Species by common name, scientific name or bird code                                                                                                    |
| **Your photos**          | Up to six matching photos as thumbnails (from three characters on), plus **Search all photos for "…"**, which opens the [Gallery search](#photo-search) |
| **Regions**              | Countries, states and provinces, also by eBird region code                                                                                              |
| **Trips** and **Albums** | Yours, by name                                                                                                                                          |
| **Settings**             | Settings pages, like **Library** or **Integrations**                                                                                                    |
| **Go to**                | The same pages as before you typed                                                                                                                      |

Clicking a photo opens its species page. Photo results follow the Gallery's **Media type** and **RAW files** choices, so quick search never shows a photo the Gallery is set to hide.

If [Search iNaturalist for other species](./inaturalist.md#any-taxa) is on, the **Species** group ends with **Search iNaturalist**, to add a species Lifer has no data for.

### It follows the page you're on

- **On the Collection page or a species page for a region**, a chip like **In British Columbia** appears under the box, and species from that region come first (the group reads "Species, British Columbia first"). Click **×** on the chip to search everywhere instead.
- **On a trip or album page**, an extra group, **Photos in this trip** or **Photos in this album**, shows matching photos from it. Its last entry, **Search all photos in this trip for "…"**, opens the Gallery [narrowed to that trip or album](#scoped).

### Keyboard

Use <kbd>↑</kbd> <kbd>↓</kbd> to move through results (across groups, wrapping at the ends), <kbd>Enter</kbd> to open the highlighted one, and <kbd>Esc</kbd> to close. Choosing a recent search puts it back in the box so you can pick a result. Lifer remembers your last eight searches on this device.
