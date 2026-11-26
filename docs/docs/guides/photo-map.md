---
title: Photo map
description: See where your photos were taken, preview and open them on the map, and place the photos that have no location yet.
---

# Photo map

The photo map shows where the photos in your [Gallery](./gallery-and-search.md) were taken. Open it from **Map** in the sidebar, or from **View > Show as > Map** in the Gallery. It shows the same photos as the grid: your filters, and a trip or album the Gallery is narrowed to, apply to the map too. A search doesn't; the map says so when one is active. To go back, choose **Show as > Grid**. Lifer remembers the choice in the page address, so reloading or coming back keeps the map. The map stays where you left it: changing a filter or the view, switching to the grid and back, or reloading never moves it. It only frames your photos the first time you open it, and moves when you ask: clicking a country, picking a place in the search or the list, or leaving a region.

## What it shows {#what-it-shows}

- **Photos with coordinates** are dots at the spot they were taken. Dots close together merge into a larger circle.
- **Photos with only a country or province** (no coordinates) are hollow rings at the region's centre, with a count. They aren't placed yet, so they never show as a dot, and a placed photo is never counted in a ring.
- As you zoom out, nearby dots and rings merge into circles with the total. A circle of only rings stays hollow; a filled circle with an extra outline ring holds some photos with no exact location.
- **Countries** with photos, placed or not, have a firmer outline. Circles of dots show how many photos they hold.
- **Saved spots** are rings with a coloured edge.
- Under the map, **Photos by country** lists the counts, largest first. It's the way to use the map from the keyboard or a screen reader: picking a country there frames it, just as a click on the map does.

A photo is **placed** only when it has coordinates. The line above the map says how many are, such as **1,204 of 1,556 photos placed.**, and a button names the rest: **352 need placing** opens the [Needs placing](#needs-placing) list. **Show photos without a location** opens them as a grid instead.

Rest the pointer on a dot, circle, ring or spot (or press and hold on a touch screen) and a card opens beside it with its best photos and how many there are, split into placed and no exact location where it holds both. Move the pointer onto the card to use it: click a photo to open it in the viewer (the arrow keys step through every photo at that mark, Esc comes back to the map as you left it), or **Show all** for the panel. You don't have to land exactly on a small dot: the nearest one within reach is the one a click takes, and a ring around it shows which. Over land with no dot nearby, the country (or, in a country's view, the province) under the pointer is tinted and named instead.

## Seeing the photos at a place {#open}

Click a dot, a circle, a ring, a country, a province or a saved spot and its photos open in a panel beside the map, best rated first. The map moves onto a dot, ring or spot in one smooth step, a little closer, and onto a circle just far enough for it to split into its dots; a country or a province also frames that region (see [Countries and provinces](#regions)). Double-click to zoom in. Click a photo to open it in the viewer, and press Esc to come back. It's the same viewer as in the Gallery, with **Full screen**, the **⋯** photo menu and **×** in its corner, and the arrow keys step through every photo the panel holds, loading more as you go. The panel has:

- **Open in Gallery**, which shows the same photos as the grid, with the **Region** filter or an **In a map area** chip set.
- The **⋯** menu: **Move these photos** (place them somewhere else), **Remove location** and, for a single dot, **Save as a spot**.
- For a circle that holds rings, its photos with no exact location are in the same list, tagged **No exact location**, and the **⋯** menu offers **Place the ones in British Columbia** (or the ring's region).

Esc or **×** closes the panel. The panel is part of the page address, so reloading or going back keeps it. Drag the panel's edge to make it wider; Lifer remembers the width. In a narrow window the panel sits under the map.

## Needs placing {#needs-placing}

The **Needs placing** list holds every photo without coordinates, grouped the way you shot them: trips first, then sessions (a new one starts after a gap of more than an hour, or when the region or the day changes). Photos with no date are grouped by trip and region. **All**, **Region only** and **No location** switch between them; region-only photos and photos with no location never share a group.

Each group shows a few photos, its date and its region. Click a photo, in the group's thumbnails or under **Show photos**, to see it bigger; the arrow keys move through the rest of the group, and Esc comes back. From the viewer you can add its coordinates, correct the ID or delete it. To place only some of a group, click **Select** (or Cmd-click or Shift-click a photo; Ctrl-click on Windows and Linux): then a click ticks a photo, Shift-click ticks a range, the **Select** menu picks all or none, and **Done** leaves select mode.

### Fixing a region {#change-region}

If a group is filed under the wrong country or province, click **Change region** on it and pick the right one, such as Canada or British Columbia. It changes only that group, or only the photos you ticked in it, and leaves any point alone. The group moves under its new region in the list, the counts update, and the toast has **Undo**. In the Gallery, select photos and choose **Set region**; for one photo, its location in the viewer or photo menu does the same.

Once every group of a trip is in the list, the trip's heading has **Place all** and **Change region** for the whole trip. **Place** and **Change region** on a group only touch that group.

## Placing photos {#placing}

Photos from a camera or phone with GPS are on the map already. For the others, put a pin down, then place:

1. Open **Needs placing**, then click the map where the photos were taken, click a saved spot, or pick a search result. Drag the pin to adjust it; **Lift pin** or Esc removes it.
2. Click **Place 14 photos here** on a group (or on the photos you ticked). The pin stays for the next group. Without a pin, **Place** drops one in the middle of the map for you to drag.
3. Or drag a group from the list onto the map: it's placed where you drop it, or under the saved spot you drop it on.

Placing never changes a photo's region. If the pin is outside a group's region, the group says so (**This point is outside British Columbia.**) but still lets you place it. Placing on a saved spot files the photos under the spot's name and region, and says first when that moves them to another region.

To place photos picked in the Gallery, select them and choose **Place on map**. If some already have a location, Lifer says how many: **Only photos without a location** (the default) leaves those as they are; **Replace all** moves them too. Camera and typed points are never replaced unless you choose **Replace all**.

**Save as a spot** keeps the pin's point for next time; manage spots in **Places**. Lifer writes the point into your files the same way as [typed coordinates](./gallery-and-search.md#coordinates). Placing sends nothing about your photos anywhere: iNaturalist only reads these locations when you send a photo there.

### Named places {#places}

A saved spot is a named place: a centre, a size (100 m unless you change it) and a town or area. Choose one from the place list in **Needs placing** or in a photo's coordinates. With nothing typed, the list shows **Nearby** places first (when the photos are inside one, **This looks like King Fisher Pond** leads), then **Recent** and **All places**. **New place from the map** is the last row.

When you add a place, **Town or area** searches towns and provinces (online too, when allowed). Picking one fills in the text only and never moves the pin or changes the coordinates; choose **Move the pin here** if you do want the pin at that town. Typing your own text works as well. Left empty, Lifer fills it in from the pin.

Choosing a place gives the photos its name and region. A photo with its own GPS keeps its point; a photo without one takes the place's centre. When some were taken more than a kilometre outside the place, Lifer asks first: **File here** keeps their points, **Move these too** moves them.

In **Places**, **Edit** changes a place's name, size, town or area, notes and iNaturalist privacy. Renaming a place also renames it on its photos unless you untick **Also rename it on 42 photos**, and **Undo** puts both back. The map shades each place's size, and the list says when photos near a place aren't in it yet.

When you send to iNaturalist, a photo inside a place, or filed under its name, takes that place's privacy (the strictest, if it's in two). A hidden or private place never sends its name, only its town or area. iNaturalist hides the locations of threatened species by itself, whatever Lifer sends.

On the map, a place's photos are one mark with its name and count, at every zoom, whether they were placed before or after you named it: Lifer goes by whether the point is inside the place. Click it to see them in the panel.

**Needs naming** (beside the map's Needs placing list, and in **Places**) suggests spots you went back to: at least 3 photos, taken on 2 or more days, close together, with no place within about 100 m. **Name this place** opens Add a saved spot with the nearest town and a size that covers them; filing the photos under it stays your choice. **Dismiss** turns a suggestion down for good (Undo in the toast). Lifer works the suggestions out on your computer in the background, from the town list it already has, and sends nothing anywhere.

To find a place, type in the search field above the map or in any place list. Your saved spots and the regions Lifer has come first, then towns of about 1,000 people or more, all offline. A new place's town is the nearest of those within 25 km, else its province. When you're online, towns, parks, lakes and addresses found online follow under **Online results**, from [Photon](https://photon.komoot.io) (OpenStreetMap data); pick one the same way. Only the text you type and the middle of the map (rounded to about 10 km) are sent; the first time, a note says so, with **Turn off**. **Online place names and search** under **Settings > General > Map and places** turns it off.

An online result isn't one of your places yet: picking one fills in the point, and saving it as a place starts from its name and town.

## Undo {#undo}

Every location change (placing, removing, filing under a spot, typed coordinates, a region changed from Needs placing) goes on one history. The toast after a change has **Undo**, and Cmd+Z on a Mac (Ctrl+Z elsewhere) on the map walks back up to 20 changes, putting back each photo's point, region, place name and accuracy. The history lasts until Lifer quits.

Placing more than 5,000 photos at once runs in the background, with progress and **Cancel** above the map. You can keep using Lifer meanwhile; a toast with **Undo** says when it's done.

## Countries and provinces {#regions}

Click anywhere inside any country's outline, with photos or without and at any zoom, and the map flies to a fixed view of it, the same fit as the country picker on the packs page: the whole country fills the map with a small margin, the rest of the world is dimmed, and panning stays near it. Its provinces or states then become clickable too; click one to go into it the same way. The path above the map, such as **World / Canada / British Columbia**, goes back up a level, as does a click on the dimmed world, and **Reset view** (Cmd+0 on a Mac, Ctrl+0 elsewhere) brings the view back after you zoom or pan.

Once you've zoomed in past a region's view, clicking that region's own land no longer changes the region (a click on another country still frames it), so the end of a drag or a look around never takes you elsewhere; dots, circles, rings and spots still open their photos. The end of a drag, a pinch or a scroll never counts as a click.

Zooming out stops at the region's view. Keep zooming out (a further pinch, a few more scroll steps or another press of the minus key) and the map lets go, one level up: from a province to its country, then to the whole world, in one movement if you like. **Keep zooming out to leave British Columbia** shows meanwhile. The region is part of the page address, so Back returns to it and a saved link opens on it. Picking a country or province in the search frames it the same way.

Far-off islands and overseas parts are left out of a country's view so the mainland fills the map, such as Svalbard for Norway or Hawaii for the United States. **Also in Norway** beside the path lists them; pick one to fly there. **Reset view** or the path takes you back to the whole country.

## How the map looks {#look}

The map is always north up and flat, and is drawn to stay quiet under your photos: pale land (charcoal in dark mode), soft blue water, a hint of green for forest, thin borders, and relief shaded from several sides so slopes facing any way stand out. As you zoom into a region, high ground takes on a tint: tan, then brown, then white on the highest peaks. Country names show at world zoom; province names, province borders and towns of about 50,000 people or more appear as you zoom into a region. Names are in English.

## Satellite and online detail {#online}

The offline map is sharp to about a region's towns. When you zoom in closer and are online, Lifer loads street and trail detail by itself, on every map (including the small maps for placing photos and adding a spot): woods, rivers, quiet roads, trails and village names from [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap data), in the same calm look, down to street level. From about a province's zoom, sharper relief loads from [Mapterhorn](https://mapterhorn.com) the same way. Zoom back out, or lose the connection, and the offline map is back. What this sends is on the [Privacy](../privacy.md#map-tiles) page: only which area you're viewing, never your photos.

The layers button at the top right of the map (a stack of sheets) holds the choices, and Lifer remembers them:

- **Map**, with **Online detail** set to **Automatic** (the default) or **Off**. Off never uses the internet for the map.
- **Satellite** shows [EOxCloudless](https://cloudless.eox.at) imagery from the Sentinel-2 satellites, with place names on top. It is about 10 m per pixel: fields, forest edges, lakes and coastlines, not single trees or paths. The panel names the provider.
- **Your own imagery.** For sharper imagery, paste a tile address from a provider you have an account with (it usually includes your key) under **Settings > General > Map and places > Satellite imagery URL**. It is saved only on that device. Check the provider's terms: some, such as Mapbox, limit which apps may use their tiles.

The same choice (Automatic, Off or Satellite) is in **Settings > General > Map and places**, and on the [Collection map](./collection-and-checklists.md#species-pins), where the layers button appears when you hover over the map; one choice applies to both. A small dot on the button shows while online tiles are showing. If they can't load, the offline map stays and a short line under the button says so.

The small (i) button in the bottom-right corner lists every map source's full credit and licence, those on screen first; the first map you open also names OpenStreetMap beside it for a few seconds. Click it, or rest the pointer on it; it closes by itself when you move the map, click elsewhere or leave it alone.

## Without the offline map {#no-basemap}

The map draws coastlines, rivers and roads from the [offline map](./offline-packs-and-map.md#offline-map). Until it's downloaded, countries show as plain outlines and the photo map offers **Download map**, which opens **Settings > Species and import > Species downloads**.

## Large libraries {#large-libraries}

Lifer groups photos taken within about 100 metres of each other into one dot before sending them to the map, so bursts and repeated shots from one spot are a single dot with a count. In a very large library, when that would still be more than 20,000 dots, Lifer groups them more coarsely (about 1 km, then 10 km) and says so above the map.
