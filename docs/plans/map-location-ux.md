# Map and location UX plan

Status: planned, nothing built. Drafted 2026-11-04. Follows the conventions of
`lifer-1.0-implementation-plan.md`: its [Standing rules](lifer-1.0-implementation-plan.md#standing-rules),
[Sub-agent briefing](lifer-1.0-implementation-plan.md#sub-agent-briefing) and
[Review step](lifer-1.0-implementation-plan.md#review-step) apply to every package here, and the reviewer
split (Opus for data, engine and anything that writes files or talks to the network; Sonnet for copy,
docs and simple UI) holds.

This plan replaces what is left of V-13 (placing photos on the map). V-11 (offline map extracts),
V-12 (optional online tiles), V-14 (saved spots, built) and V-15 (re-check species, built) stay as they
are; nothing here adds map data beyond them except the small gazetteer in Wave 2.

## Summary

The map should be **the place to see and set locations**. Today it is a view of the Gallery: clicking a
dot sends you back to a filtered grid, you can't see a photo without clicking, place search knows only
saved spots and region names, and placing photos starts with a Gallery selection. The status line also
reads as if photos that have only a region are on the map, because their province bubbles sit beside the
real dots.

The fix, in three waves:

1. **Quick wins:** honest precision counts and a "Needs placing" count; clicking a dot opens a panel over
   the map; hovering previews the photos; a "Needs placing" tray so you place photos straight from the
   map, place first or photos first, with one undo history. Beside them, a livelier but calm map
   palette and a curated, top-down region view when you click into a country or province.
2. **Search:** a small bundled offline gazetteer (towns, parks, lakes, peaks) so "Tofino" or "Point
   Pelee" works offline; then an optional, off-by-default online address search.
3. **Polish:** box select on the map, "place with the rest of this session" suggestions, nearest-town
   labels, saved spots list on the map, narrow-window and extreme-library sweep.

### Principles

1. **Stay on the map.** Nothing on the map navigates away unless the user picks "Open in Gallery".
   Photos open in the Lightbox over the map, and Back returns to the same view (N1).
2. **Precision is honest.** A photo is placed only when it has coordinates. Region-only photos are shown
   as approximate, counted as needing placement, and keep their region.
3. **No pre-selection.** The map itself offers the photos that need placing, grouped the way they were
   shot. A Gallery selection is one way in, not the only one.
4. **Local by default.** Search, previews and placement all work offline. The online geocoder sends only
   the typed text, only after the user turns it on.
5. **Never lose a pin.** Camera, typed and iNaturalist coordinates are never replaced unless the user
   says "Replace"; every change is undoable without a confirm dialog (D2, F3).
6. **Built for extremes.** 200,000 photos, 20,000 dots, 500 saved spots, 300-character names, a
   360-pixel-wide window.

## Research

Sources: vendor manuals and help pages where reachable (Mylio manual, darktable manual, digiKam manual,
Adobe help search results, Immich release notes and source notes, PhotoPrism docs and issues). Rows
marked * are from product knowledge and were **not re-verified** for this plan; check before relying on
a detail.

| Product | Does well | Does badly | Lifer should steal |
|---|---|---|---|
| Apple Photos (Places, Info "Assign a Location") | Type a place in the Info panel with autocomplete; Copy and Paste Location; Revert to Original Location; clusters show a photo with a count | Assigning needs Apple Maps online; no built-in "no location" view (users make a smart album); no drag onto the map | "Revert to original" as a per-photo action; cluster markers that show a photo |
| Google Photos * | "Estimated location" labelled as such and removable; panning the map updates a photo grid below it | Online only; estimates are made silently from location history | Label approximate locations visibly; a photo list that follows the map |
| Lightroom Classic Map module | Search box over the map; drag from the filmstrip onto the map; Saved Locations with a radius and a Private option; filter bar for Visible on map, Tagged, Untagged; pin preview with arrows through the photos at a pin (click, hover detail unverified) | Map tiles and search need Google online; GPX tracklog step is heavy | Untagged filter beside the map, saved spots with radius, in-place preview that cycles a cluster |
| digiKam Geolocation Editor | Separate editor: image list plus map, drag images onto the map, bookmarks in a tree, Search tab (GeoNames, OSM), Undo and Redo tab, changes applied at the end | Modal editor window, apart from browsing; search needs the internet | A real undo history for location edits; bookmark tree idea for many spots |
| darktable map view | Drag from the filmstrip onto the map; drag a photo back to the filmstrip to remove its location; Ctrl+Z undo; "find location" search (OSM); "map locations" shapes used as filters | Thumbnails on the map get cluttered; drag-drop broke on Windows in an older release | Drag off the map to remove; undo on the map with Mod+Z |
| Mylio Photos | "Untagged" button on the map lists photos with no location; drag one or many onto the map; search a place, drop, then confirm the pin with a check mark; long-press on touch | Two-step confirm adds a click per drop | The untagged list living on the map, and long-press for touch |
| Immich | Map side panel (2.6) shows a mini timeline of a selected cluster with batch actions, without leaving the map; Change Location modal with place search from local geodata tables; a geolocation utility with a timeline of photos missing coordinates | Clusters can merge across borders; no undo | Cluster panel over the map; a timeline of photos missing coordinates; local place tables for offline search |
| PhotoPrism | Labels a location's source (estimate, manual, metadata); manual edits block estimates | "Estimates" copies a location from other photos the same day and can put photos in the wrong city | Show source; offer the "same session" idea only as a suggestion the user confirms |
| Flickr Organizr map | Drag many photos from a strip onto the map at once; drag off to remove; zoom level at drop sets an accuracy level (world, country, region, city, street) | Accuracy inferred from zoom surprises people; old Yahoo map detail | A stored precision level separate from the point |
| iNaturalist location chooser (checked from a screenshot of the observation editor) | A place box that searches as you type; a pin with an accuracy circle; a readout of latitude, longitude and accuracy in metres with an Edit link for typing exact values; Map and Satellite toggle; geoprivacy (open, obscured, private) on the same screen | Satellite and place search need the internet (Google), and the picker works on one observation at a time | Show the readout (lat, lon, accuracy) with a typed-values edit beside the map, the accuracy circle, and a satellite option only as an opt-in online layer; geoprivacy stays per spot |
| eBird location picker * | "Choose from my locations", hotspots on the map, nudges against too-general locations | Online only | Saved spots first in search; warn when a point is only a region centre |
| GeoSetter * | Thumbnail list plus map; select images, click "assign marker"; favourites; filter to images without coordinates; edits pending until saved, discardable | Windows only; online maps and reverse geocoding | Filter to unplaced; place a whole selection with one action |
| Photo Mechanic * | Fast IPTC city, state, country fields and templates; GPS from tracks | No interactive placement map that I could confirm | City, state, country text is region-level, not a point: matches Lifer's region-only state |

What nobody does well and Lifer can: grouping unplaced photos by shooting session and trip, and placing a
whole session in one drop, fully offline.

## Proposed UX

### Map page layout

Desktop, 1280 pixels and up. The page is the Gallery's map view (sidebar "Map"), filters still apply.

```
+--------------------------------------------------------------------------------------+
| Map                                      [ Search places, e.g. Tofino         ] [View]|
| 1,204 of 1,556 photos placed.   [ 352 need placing ]                                  |
+------------------------------------------------------------+-------------------------+
|                                                            | Needs placing      [x]  |
|     ( 312 )  <- hollow ring: region only, British Columbia | [All 352|Region 312|None 40]
|                    .                                       | Sun 14 Sep, Tofino trip |
|          (23)  o  o                                        |  [][][][] 14 photos     |
|                 o       (ring) saved spot                  |  within an hour   [Place]|
|                                                            | Sat 13 Sep              |
|                         [+] [-]  [3D]                      |  [][][][] 6 photos      |
|                                                            | ...                     |
+------------------------------------------------------------+-------------------------+
| Photos by country: Canada 1,402  United States 154  ...                               |
+--------------------------------------------------------------------------------------+
```

- **Search** sits in the page toolbar (review rule: search in the toolbar), with a W10 placeholder.
- **Status line:** "1,204 of 1,556 photos placed." The button names the count: "352 need placing". It
  opens the tray; when it is 0 the button is gone (A1) and the line reads "All 1,556 photos placed."
- **Side column** holds one panel at a time: the Needs placing tray, or the photos of a clicked dot. It
  is resizable, remembered (N3), and closing it gives the space back to the map (L8).
- **Region-only bubbles** are hollow dashed rings with the count, drawn only for photos with no
  coordinates, so a precise photo is never drawn twice (today it is: bubbles count every photo in the
  province while the dots are also drawn below zoom 5).

### Hover preview

```
        +---------------------------+
        | [img][img]  Tofino area   |
        | [img][img]  42 photos     |
        |             12 to 14 Sep  |
        +---------------------------+
                   o  <- dot or cluster under the pointer
```

- After 250 ms of hover on a dot, cluster, region ring or spot: a popover with the best-rated photo (one
  photo) or up to four (cluster, 2 by 2), the place name (spot name, region, or "Near Tofino" once the
  gazetteer lands), count and date range. Region rings say "312 photos with only a region".
- Uses the shared Tooltip as a rich tooltip (U-08 style), never steals focus, stays inside the window
  (M1). Thumbnails load progressively (P4); results cached per cell for the session.
- Touch: long-press shows the same preview; lift to dismiss, tap opens the panel.
- Keyboard: focusing a dot through the "Photos by country" list or the panel shows nothing extra; the
  panel is the keyboard path.

### Click: a panel over the map

```
+------------------------------------------------------------+-------------------------+
|                                                            | Tofino area   42 photos |
|                         o <- selected, accent ring         | 12 to 14 Sep            |
|                                                            | [img][img][img]         |
|                                                            | [img][img][img]  ...    |
|                                                            |                         |
|                                                            | [Open in Gallery] [ ... ]|
+------------------------------------------------------------+-------------------------+
```

- Click on a dot, cluster, region ring, country or spot opens the panel; the map does not move.
  Double-click zooms (MapLibre default), so clusters no longer zoom on a single click.
- The panel lists the photos as the shared justified grid, virtualised, best rated first. Clicking a
  photo opens the Lightbox over the map; Back or Esc returns to the panel.
- Actions: "Open in Gallery" (secondary, today's behaviour), and the overflow menu: Select these photos,
  Move these photos (starts placing them, Wave 3 box select uses the same path), Remove location
  (undoable), Save as a spot (single dot only).
- The selection lives in the URL (`at=` cell, cluster bbox, region or spot id), so Back and reload keep
  it (N1, N3).

### Needs placing tray

```
| Needs placing (352)                                   [x] |
| [ All 352 | Region only 312 | No location 40 ]            |
| Suggested                                                  |
|  [][][][]  14 photos within an hour, Sun 14 Sep            |
|            Same session as 9 placed photos  [Place there]  |
| Tofino trip, 12 to 15 Sep  (88)                        [v] |
|  [][][][]  31 photos, Fri 12 Sep 07:10 to 08:02  [Place]   |
|  [][][][]  57 photos, Sat 13 Sep                 [Place]   |
| No trip                                                    |
|  [][][][]  6 photos, Mon 3 Mar 2014, Alberta     [Place]   |
|  ...  (paged, 50 groups at a time)                         |
```

- Groups, in order: **Suggested** (Wave 3: sessions that also have placed photos), **trips** (existing
  trips table), then **sessions**: photos with no gap of an hour or more, the rule
  `suggestedEncounters` already uses, split at a region change. A session over a day splits by day.
- Each group: up to four thumbnails, a plain label ("14 photos within an hour, Sun 14 Sep"), region if
  any, and a Place button that is live once a pin is down. Expanding a group shows its photos; click
  toggles a photo, Shift-click selects a range (M4, M8), with Select all and Deselect all (D4).
- The segmented filter splits region-only from no-location photos. Groups never mix the two states.
- Extremes: groups are paged from the API; a group's photo ids are fetched only when it is placed.
  10,000 unplaced photos is 10,000 / ~20 per session, so around 500 rows, which the panel virtualises.
- Placed groups leave the tray at once (F5) and the count updates.

### Place-first and photos-first flows

Either order works, with no Gallery selection:

1. **Place first.** Search a place, click a saved spot, or click the map: a draggable pin drops and the
   tray's Place buttons read "Place 14 here". Click one; the photos are placed, the pin stays for the
   next group, Esc lifts it.
2. **Photos first.** Drag a group (or selected photos) from the tray onto the map: they are placed where
   they are dropped, at once, with an Undo toast. While dragging, the drop point shows a pin and the
   saved spot under the pointer highlights; dropping on a spot files them under the spot.
3. **From the Gallery.** "Place on map" opens the map with the tray narrowed to that selection (today's
   entry, kept).

Rules:

- Photos that already have coordinates are left alone unless the user turns on "Replace" for that action
  (today's Only missing / Replace all control, kept on the placing summary).
- Placing never changes a photo's region. Placing on a saved spot does (it files photos under the spot,
  as today); the summary says so first when it moves any: "Also moves 3 photos from Alberta to British
  Columbia."
- A pin outside a region-only photo's region shows an inline note, not a block: "This point is outside
  British Columbia."
- Big placements (over 5,000 photos) run as a background job with progress in the tray row (F2, F4).
- Touch and the server web app at phone width: no drag; tap a group, then tap the map, then Place.

### Saved spots on the map

- Spots are rings (today). The search lists matching spots first. Wave 3 adds a Spots tab in the side
  column: searchable, spots in the current view first, then by name, virtualised for 500 spots, names
  wrap (S8). Clicking a spot flies there and puts the pin on it.
- "Save as a spot" stays on the placing summary and on a single dot's panel.

### Undo

- Every location change (place, drop, spot apply, remove, replace) goes on one undo history per user:
  toast Undo for the latest, and Mod+Z on the map page (outside text fields) walks back up to 20 changes.
  Today there are two separate one-step undos (coordinates and spot apply) that can't see each other.
- Undo restores lat, lon, region, label, source and accuracy exactly, and rewrites the files as today.
- Held in memory, as today (the existing `shortcut:` comment applies): it doesn't survive a restart.

### Keyboard

| Action | Key | Note |
|---|---|---|
| Focus map search | Mod+F on the map page | Open decision 4; elsewhere Mod+F stays Find |
| Pan, zoom | Arrows, + and - when the map has focus | MapLibre built-ins, listed in the `?` sheet |
| Move through tray groups and photos | Up, Down; Left, Right inside a group | Shared list behaviour |
| Peek at a photo | Space | Existing shortcut |
| Drop pin at map centre, then place | Enter on a focused group: first Enter drops the pin at the centre, second places | Lets keyboard users place without a mouse |
| Undo last location change | Mod+Z | New entry in `lib/keymap.ts` |
| Close, back | Esc peels: Lightbox, then pin, then selection, then panel | M3 |
| Box select (Wave 3) | Shift-drag on the map | Replaces MapLibre's Shift box zoom |
| Reset to the region's framing | Mod+0 | Existing "Fit to window" meaning |

All new bindings go through `apps/web/src/lib/keymap.ts` and `keyboard-shortcuts.md`.

### Narrow windows

- Under 900 pixels the side column becomes a bottom sheet over the map with a drag handle; the status
  button opens it. Under 600 pixels (server web at phone width) the sheet is full width and the hover
  preview is replaced by long-press.
- The search field takes the full toolbar row; the status line wraps; counts never truncate.

## Precision model

### States

| State | Rule | Shown as | Counts as |
|---|---|---|---|
| Placed | `lat` and `lon` set | Dot | Placed |
| Region only | No coordinates, `region_id` set | Hollow ring at the region centre | Needs placing |
| No location | No coordinates, no region | Only in the tray and the count | Needs placing |

- **Needs placing** means exactly: no coordinates, whatever the region. That is today's
  `missingCoordinates=1` filter, so the filter keeps its meaning and saved smart albums keep working; only
  its label changes from "No location" to "Needs placing".
- Where coordinates came from stays in `location_source` (NULL camera or Lifer, `inaturalist`) and
  `location_accuracy_m`. No new column is needed for the three states.
- `location_accuracy_m` gets one more writer: placing at a gazetteer result's centre without moving the
  pin stores a rough radius (open decision 2). The hover and panel show "About 5 km" when it is set.

### Status line and API

- `/gallery/map` gains `regionOnly` (no coordinates, has a region) next to `withoutCoordinates`, and each
  region gains `regionOnlyCount`, which the rings use instead of `ownCount`.
- Copy (en.json, with en.context.json entries):
  - "{placed} of {total} photos placed." / "All {total} photos placed." / "None of these photos are placed
    yet."
  - Button "{count} need placing" (one: "1 needs placing").
  - Tray filter "All {n}", "Region only {n}", "No location {n}".
- New endpoint `GET /gallery/map/unplaced` (Gallery filters plus `state=all|region|none`, `cursor`):
  groups `{ key, kind: trip|session, label parts, regionId, count, coverPhotoIds[4], from, to }`. Ids
  for a group come from the existing `/gallery/ids` with the group's filters (trip, time range, region,
  `missingCoordinates=1`), so no new id route.
- Hover and panel reuse `/gallery` with `bbox`, `regionIds` or `places` plus `limit`; no new route.

### Migration

None for Waves 1 and 3. Wave 2 needs one catalog-side table for the gazetteer (next free migration,
needs approval since it is outside the current specs; see MAP-07). Open decision 3 would add one nullable
column if the maintainer wants "Region is enough".

## Search design

### Offline gazetteer

- **Source:** GeoNames, CC BY 4.0 (attribution "Place names from GeoNames" in the map's attribution and
  `docs/docs/credits.md`). Natural Earth keeps feeding `example_city` as today.
- **Base set, bundled with the catalog:** GeoNames `cities5000` (about 50,000 towns, population over
  5,000 or a first-level seat). Trimmed to id, name, ASCII name, up to five Latin-script alternate names,
  feature code, country and province region id, lat, lon, population. Estimated 1 to 2 MB compressed;
  MAP-07 measures it and stops if over 3 MB.
- **Per-region detail, inside the region pack the user already downloads:** that country's GeoNames
  file filtered to wildlife-relevant features: all populated places, parks and reserves (`L.PRK`,
  `L.RESN`, `L.RESF`, `L.RESW`), lakes, marshes, bays and beaches (`H.LK*`, `H.MRSH`, `H.BAY`, `T.BCH`),
  peaks, capes and islands (`T.MT`, `T.PK`, `T.CAPE`, `T.ISL`). Assigned to the pack's region by point in
  polygon. Budget: under 5% of the pack or 2 MB, whichever is smaller; capped by dropping the smallest
  populated places first. Pack manifests already allow extra fields, so this is a `places` array.
- **Build:** a `gazetteer` step inside the existing `places` stage of
  `packages/data-pipeline/src/scripts/refresh.ts`, so it stays one parameterised, resumable command:
  `npm run refresh -w data-pipeline -- --stages places`. Downloads go through `fetchCached`, per country
  items are logged in `pipeline_runs` so `--resume` skips finished countries, and `--countries` limits a
  run. Publishing waits for the maintainer's go-ahead as usual, and rides the next catalog republish
  rather than forcing one.
- **Storage:** one table `gazetteer_places` (catalog data, not user-owned, no sync tracking), filled from
  the catalog seed and from pack installs, removed with the pack. Index on `lower(ascii_name)`
  (`text_pattern_ops`) for prefix search.

### Ranking

`/places/locate` keeps its shape and adds `kind: town | nature`, `detail` ("British Columbia, Canada")
and `bbox` where known. Order:

1. Saved spots (exact, then prefix, then contains).
2. Exact name or alias match of a region, town or feature.
3. Prefix matches, ranked by: inside the current map view (the client sends the view as `near`, which
   stays local), then in a country the library has photos in, then kind (region, town, nature), then
   population, then shorter name.
4. Contains matches last. Eight results, as today. Matching follows the shared search rules (Q2, Q4:
   accents, case, apostrophes).

Results show the shared result rows with a kind icon, the name, and the detail line, wrapping long
names. Picking one flies there; a town or feature drops a pin at its point, a region frames its outline.
No results is a true empty state, with the hint "Download British Columbia for parks and small towns"
when the view's region pack is missing (S6).

### Optional online address search

- **Off by default.** Setting under Settings, Online services: "Search addresses online". One sentence:
  "Sends what you type in map search to Photon, a free search run by komoot. Photos and locations are
  never sent."
- **Provider:** Photon public endpoint (`photon.komoot.io`), Apache 2.0 software over OpenStreetMap data
  (ODbL; attribution "Search by Photon, data from OpenStreetMap contributors" under the results). It is
  built for search as you type and needs no key. Its public terms are fair use with throttling and no
  availability promise, so the endpoint is editable for a self-hosted Photon. Nominatim's public server
  is not the default: its policy caps an application at about one request per second across all users
  and (from memory, check) disallows autocomplete; it can be offered as "Nominatim compatible" for
  self-hosted instances with search on Enter only. Pelias via Stadia needs a key, so it is not offered as
  a default.
- **What is sent:** only the typed text, a language of `en`, and a Lifer User-Agent. No map view bias, no
  coordinates, no photo data. Sensitive-species rules are unaffected because nothing about a photo leaves.
- **When:** after 3 characters and a 500 ms pause, or on Enter; at most one request per second per
  install, throttled in the API; online rows appear under the offline rows as "Online results".
- **Where:** the API makes the request (desktop and server alike), so the desktop CSP doesn't change.
  Results cached in memory for 24 hours (500 queries). Offline or failed: one quiet row "Online search
  isn't available right now" (S9), offline results still show.

## Map look and region view

The maintainer finds the map dull and wants a curated view when clicking into a country or province,
like Specio's.

### What to borrow

| Map | What it does | Borrow |
|---|---|---|
| Specio (specio.life, screenshots of its Map view, Trips and range map) | Near-monochrome map: pale paper land with **strong, crisp hillshade**, flat cool grey sea, no labels or borders at continent zoom; dark theme is charcoal land, near-black sea. The map fills the whole window, with panels floating over it. Every map is **top-down and north-up**: no tilt in any screenshot. Trip cards frame each trip tightly. Colour comes from pins, thumbnails and the taxa cards, not the map. Pins are small charcoal discs with white numerals | Strong relief over a quiet base, full-bleed map, tight framing per region, numerals on clusters, colour left to the data |
| eBird Status and Trends, Merlin range maps * | Light grey basemap with bold, saturated abundance colours | The basemap stays low-chroma so taxa colours read |
| Outdoor topo styles (Gaia GPS, Outdooractive style maps) * | Hillshade plus a faint green forest and park tint, soft blue water | A hint of landcover (forest, ice, scrub) and a water hue gives "nature" without noise |
| Apple Maps (terrain and 3D regions) * | Landcover tints (green forest, tan arid, white snow), smooth fly-to between places, 3D as a deliberate mode | Landcover tints, animated region entry, tilt as an opt-in |

I could not see Specio's camera transitions or whether it offers any tilt: the site has screenshots only
(a YouTube channel is linked but I did not review video). "Top-down" is what every screenshot shows; the
fly-to below is my proposal, not a copy.

### Why Lifer's map reads dull today

From `apps/web/src/lib/mapStyle.ts`, `pmtiles.ts`, `theme.css` and `PhotoMap.tsx`:

1. **Land and water are nearly the same colour.** Light land `#ece3cd` vs water `#d6d8d0` is 1.13:1 and
   the water is grey-green, not a water hue; dark `#232627` vs `#161819` is 1.17:1. Coastlines barely read.
2. **Weak relief.** Hillshade exaggeration is 0.35 with a brown shadow (`#6b6048`) on cream land, so
   mountains are a smudge. The elevation archive stops at zoom 5, so it softens further at province zoom.
3. **Everything else is dropped.** `KEEP` keeps only background, earth, water and borders: no landcover
   (forest, ice, scrub), no parks, no labels (no glyphs are bundled), so the map has no texture.
4. **The country choropleth greys the land.** PhotoMap paints every country with `--color-ink` at 3 to 45%
   opacity by photo count, and region bubbles in ink at 15%: the more photos you have, the muddier the map.
5. **The tilt fights the framing.** `tiltTerrain` ramps the pitch to 48 degrees from zoom 3.5 to 7 on
   every zoom, so a region always arrives tilted, its far half recedes into haze and the framing changes
   with every scroll.
6. **A small box.** The map sits in a bordered panel `min(70vh, 36rem)` tall, not the window.

### Palette

Richer but calm: a water hue, a hint of forest, stronger relief, crisp borders, small labels. Ratios were
computed for this plan (WCAG relative luminance). Taxa pins against land, water and forest stay at least
3.68:1 in light and 5.1:1 in dark, above the 3:1 rule for graphics; labels are at least 4.9:1.

| Token (`theme.css` and `designTokens.ts`) | Light | Dark | Use |
|---|---|---|---|
| `--color-map-land` (changed) | `#f1ebdd` | `#2b2e2c` | Earth |
| `--color-map-water` (changed) | `#c4d3da` | `#141d26` | Sea, lakes, background |
| `--color-map-forest` (new) | `#d6e0c3` | `#33402f` | Landcover forest, parks at region zoom |
| `--color-map-scrub` (new) | `#e8e6d2` | `#30332d` | Grass, scrub, farmland |
| `--color-map-ice` (new) | `#f8f9f7` | `#3a3e3e` | Glacier, snow |
| `--color-map-line` (changed) | `#9c937c` | `#636963` | Country borders, 0.8 px |
| `--color-map-line-province` (new) | `#c9bfa6` | `#474c48` | Province borders, dashed, region view only |
| `--color-map-relief` (changed) | `#4d4a40` | `#050606` | Hillshade shadow |
| `--color-map-relief-highlight` (new) | `#fffdf7` | `#4b504c` | Hillshade highlight |
| `--color-map-label` (new) | `#4f5652` | `#c8cbc4` | Place labels, with a land-coloured halo |

- Land to water rises to 1.29:1 (light) and 1.24:1 (dark), with the hue doing the rest.
- Hillshade exaggeration 0.6 on the world map, 0.75 in region view, light from the north-west.
- Landcover comes from the Protomaps `landcover` layer already in the basemap package (check it is in
  Lifer's `world-z8.pmtiles` build; if not, the forest token waits for V-11 extracts).
- The choropleth goes: countries are no longer tinted by count (the list under the map and the hover
  carry counts). Countries with photos get the province-line colour as a slightly heavier outline.
- Labels: country names at world zoom, province names and towns over about 50,000 people in region view,
  in a bundled open-licence font (Noto Sans, OFL; Latin ranges only, estimated under 1 MB). Cluster
  counts become white numerals on the taxa-coloured discs, as Specio and Lightroom do.
- The map fills the content area under the toolbar (full-bleed), side column floating over it.
- Every map (PhotoMap, RegionMap, PacksMap, SpeciesHotspotMap) uses the same tokens, so the look is
  consistent (C3, T1). V-03's "quiet basemap" intent stays; this is the tuned version of it.

### Curated region view

| Moment | Camera | Map |
|---|---|---|
| World and continents | Flat, north up, free pan and zoom | Country outlines, country labels, region-only rings, clusters |
| Entering a region (click a country or province ring, pick a region in search, or open the map with one region filtered) | Animated fly-to (900 ms, ease-out; jump with reduced motion) to the region's framing: its outline's bounds, padded for the side column, **north up, top-down**. With 3D on: pitch 40, terrain exaggeration 1.3 (1.5 for regions over 1,000 km across) | Outside the region dims under a mask (surface colour at 55%), the outline draws in the accent colour at 1.5 px, province borders and labels appear, relief at 0.75 |
| Panning and zooming inside | Free inside the region: pan is held to the region's bounds plus 25%, zoom in freely, zoom out stops at the framing zoom minus 0.5 | Unchanged |
| Getting back | **Reset view** button, and Mod+0 (the existing "Fit to window" shortcut), returns to the framing. A breadcrumb in the toolbar, "World / Canada / British Columbia", goes up a level. Back returns to the previous view (region in the URL, N1) | |
| 3D | A deliberate toggle (the existing 3D button), remembered, **off by default**. It tilts only in region view; the world stays flat. The zoom-driven tilt ramp is removed. Manual Ctrl-drag tilt still works and Reset view undoes it | Terrain only while tilted, as today |

Clicking a country or province does both: it enters the region view and opens the panel with that
region's photos (MAP-02). Clicking the dimmed area outside goes back up a level.

**Framing rule.** Bounds of the region's outline, ignoring far-flung parts: keep polygons covering 95% of
the area or lying within 1,500 km of the largest, and frame those. Computed once per process from the
outline, like `boundaryCentroid` in `gallery/map.ts`.

**Regions that need hand-tuned framing** (start of the override list):

- Antimeridian: Russia, Fiji, Kiribati, Tuvalu, New Zealand (Chatham Islands), USA and Alaska (Aleutians).
  MapLibre frames these by expressing the east edge past 180 degrees.
- Island-spanning or with far parts: USA (Hawaii, Alaska), France (overseas regions), Netherlands
  (Caribbean), Spain (Canaries), Portugal (Azores, Madeira), Ecuador (Galapagos), Chile (Easter Island),
  Norway (Svalbard), Denmark (Faroes, if they sit under it), Indonesia, Philippines, Japan, French
  Polynesia, Hawaii, Nunavut.
- Very elongated: Chile, Norway, Vietnam, Japan, Malawi, Italy. These frame well but may want a smaller
  padding so they don't become a thin sliver.

**Overrides** live in one reviewed file, `packages/shared/data/region-framing.json` (path to confirm),
keyed by the region's external code, each entry `{ bounds: [w, s, e, n], pitch?, exaggeration? }`. The API
returns `framing` with the region (no migration). Bearing stays north up everywhere; no entry may rotate.

## Work packages

Field guide as in the 1.0 plan. Prefix `MAP`. Every package: shared components only, `check:*` scripts
pass, ux-rules named, screenshots at the smallest window, 27 inch, light and dark, and seeded extremes
(0, 1 and 200,000 photos; 20,000 dots; 500 spots; 300-character names).

### Wave 1: quick wins

#### MAP-01 Precision counts and wording

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus check the counts add up on the extreme seed (U1).
- **Goal:** complaint 5: region-only photos count and show as needing placement.
- **Scope:** in: `regionOnly` and per-region `regionOnlyCount` on `/gallery/map`; rings use
  `regionOnlyCount` and a hollow dashed style; status line and "need placing" button copy; filter label
  "Needs placing"; guide update. Out: the tray (MAP-04).
- **Files:** `apps/api/src/gallery/map.ts`, `map.integration.test.ts`, `apps/web/src/components/PhotoMap.tsx`,
  `PhotoMap.test.tsx`, `apps/web/src/locales/en.json`, `apps/web/src/i18n/en.context.json`, regenerated
  `schema.gen.ts` and `openapi.gen.json`, `docs/docs/guides/photo-map.md`.
- **Depends on:** none.
- **Tests:** integration: precise photo in BC is a cell and not in the BC ring; region-only photo is in
  the ring and in `regionOnly`; counts sum to `total`. Unit: status copy for 0, all, some.
- **UX checks:** U1, W8, W9, W11, T5, A1.
- **Risks:** country shading still counts every photo in a country; that is intended and the guide says so.
- **Parallel with:** MAP-02, MAP-04.

#### MAP-02 Click opens a panel over the map

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** complaint 2: seeing a dot's photos keeps you on the map.
- **Scope:** in: side column component (resizable, remembered, bottom sheet under 900 px); photo panel
  for dot, cluster, ring, country, spot using the shared grid with `/gallery?bbox|regionIds|places&limit`;
  Lightbox over the map; "Open in Gallery" secondary; overflow menu (Remove location, Save as a spot,
  Select these photos); selection in the URL; single click no longer zooms a cluster. Out: hover (MAP-03),
  tray (MAP-05).
- **Files:** `PhotoMap.tsx`, new `apps/web/src/components/map/MapSidePanel.tsx` and
  `MapPhotoPanel.tsx`, `pages/GalleryPage.tsx` (map wiring), locales.
- **Depends on:** none.
- **Tests:** component: click a cell opens the panel and doesn't navigate; Open in Gallery sets the bbox
  filter. e2e: click dot, open photo, Esc, Back keeps the panel.
- **UX checks:** N1, N3, N5, L1, L8, M3, M7, P1, P4, S7.
- **Risks:** 20,000-photo clusters: panel pages through `/gallery`, never loads all ids.
- **Parallel with:** MAP-01, MAP-04.

#### MAP-03 Hover preview

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** complaint 3.
- **Scope:** in: 250 ms hover popover on dots, clusters, rings and spots (1 or 4 thumbnails, name, count,
  dates); long-press on touch; session cache per cell; extend the shared Tooltip if it can't anchor to a
  map point. Out: nearest-town names (MAP-12).
- **Files:** `PhotoMap.tsx`, `apps/web/src/components/Tooltip.tsx` (extend), new
  `apps/web/src/components/map/MapHoverPreview.tsx`, locales.
- **Depends on:** MAP-02 (shared fetch for a selection's photos).
- **Tests:** component: hover shows after delay, leaves on mouseout, one request per cell.
- **UX checks:** M1, M5, M9, P4, T3, Y3 (reduced motion).
- **Risks:** request bursts while sweeping the pointer; cancel on leave, cache hits.
- **Parallel with:** MAP-04.

#### MAP-04 Needs placing tray and groups endpoint

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus query plans on the 200,000-photo seed.
- **Goal:** complaint 4, data side: the map lists what needs placing, grouped as shot.
- **Scope:** in: `GET /gallery/map/unplaced` (Gallery filters, `state`, cursor paging; trips, then
  sessions by one-hour gaps split at region and day changes); tray UI in the side column with the state
  filter, group rows, expand to photos, click and Shift-click selection, Select all and Deselect all.
  Out: placing actions (MAP-05), suggestions (MAP-11).
- **Files:** new `apps/api/src/gallery/unplaced.ts` and integration test, route registration,
  `apps/web/src/components/map/NeedsPlacingTray.tsx`, locales, generated schema.
- **Depends on:** MAP-01 (counts), MAP-02 (side column).
- **Tests:** integration: two sessions an hour apart are two groups; a trip groups its photos; region
  only and no location never share a group; paging is stable. Budget: first page under 200 ms on the
  extreme seed.
- **UX checks:** C2, D4, M4, M8, S7, S8, P3, W11.
- **Risks:** photos with no date: one "No date" group per region, paged.
- **Parallel with:** MAP-03.

#### MAP-05 Place-first and photos-first placement

- **Model:** Sonnet 5.5. **Review:** Opus 5.5 (writes files through the location routes).
- **Goal:** complaint 4, flow side.
- **Scope:** in: pin from search, spot or map click; Place buttons on groups and selections; drag from
  the tray onto the map and onto spots; Gallery "Place on map" narrows the tray; Only missing or Replace
  control; spot apply summary when regions change; outside-region note; touch tap flow; keyboard Enter
  flow. Replaces the floating placing card. Out: undo history (MAP-06).
- **Files:** `PhotoMap.tsx`, `NeedsPlacingTray.tsx`, `pages/GalleryPage.tsx`, `hooks/useSavedSpots.ts`,
  `lib/keymap.ts`, `docs/plans/keyboard-shortcuts.md`, locales, `docs/docs/guides/photo-map.md`.
- **Depends on:** MAP-04.
- **Tests:** e2e: drag 20 photos from the tray onto a pond, Undo; place first then two groups in a row;
  camera-located photos untouched unless Replace; keyboard-only placement.
- **UX checks:** M6, D3, D5, D7, F1, F3, W8, A4.
- **Risks:** HTML drag over a WebGL canvas on Windows and Linux webviews (darktable hit this); test early
  on all three, keep the tap flow as fallback.
- **Parallel with:** MAP-07.

#### MAP-06 One location undo history and big placements in the background

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check every write path snapshots before writing.
- **Goal:** one undo for every location change; placements over 5,000 never block.
- **Scope:** in: a per-user in-memory history (20 entries) shared by `/captures/coordinates`, saved spot
  apply and remove; `POST /captures/location/undo` restores lat, lon, region, label, source, accuracy and
  follows the file write; coordinates over 5,000 photos run as a job like spot apply; Mod+Z on the map.
  Out: persistence across restarts.
- **Files:** `apps/api/src/captures/routes.ts`, `apps/api/src/places/savedSpots.ts`, a small shared
  `apps/api/src/captures/locationHistory.ts`, tests, `PhotoMap.tsx`, `lib/keymap.ts`.
- **Depends on:** none (MAP-05 uses it).
- **Tests:** integration: place, spot apply, remove, then three undos restore each exactly; another
  user's history is separate; 6,000-photo place runs as a job with one undo.
- **UX checks:** F2, F3, F4, D2.
- **Risks:** undo racing a running apply job: undo waits for or cancels it, never interleaves.
- **Parallel with:** MAP-01 to MAP-04.

#### MAP-14 Map palette, landcover and labels

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus contrast tests for every new pair and a size report
  for the bundled glyphs.
- **Goal:** the map stops reading dull, in both themes, on every map.
- **Scope:** in: the token table above in `theme.css` and `designTokens.ts`; `quietLayers` keeps
  landcover and the province boundaries and styles them; hillshade exaggeration and highlight; drop the
  count choropleth and ink bubbles in PhotoMap; bundled Latin glyphs and country, province and town
  labels; numerals on clusters; full-bleed map container. Out: camera (MAP-15), detailed extracts (V-11).
- **Files:** `apps/web/src/theme.css`, `packages/shared/src/designTokens.ts`, `apps/web/src/lib/mapStyle.ts`,
  `pmtiles.ts`, `PhotoMap.tsx`, glyph assets served by `apps/api/src/settings/assets.ts` (or the web
  bundle), `contrast.test.ts`, `docs/docs/credits.md` (Noto Sans).
- **Depends on:** none. Coordinate `PhotoMap.tsx` edits with MAP-01 and MAP-02 (run after them or agree
  hunks).
- **Tests:** contrast unit tests (taxa on land, water, forest; labels on all three; both themes); map
  keeps one instance and doesn't blink; screenshots world, Canada, BC, light and dark.
- **UX checks:** T1, T2, T3, T5, Y3, C3, C5, L1.
- **Risks:** the archive may lack landcover at low zoom; ship the rest and leave the forest token unused
  until V-11. Label collisions over dense clusters: labels sit under the photo layers and yield.
- **Parallel with:** MAP-03 to MAP-06.

#### MAP-15 Curated region view

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check antimeridian and island regions on screenshots.
- **Goal:** clicking into a country or province lands on a designed, stable framing; 3D is a choice.
- **Scope:** in: region framing helper (rule above plus overrides file) returned by the regions API;
  fly-to on region entry with padding for the side column; outside mask and accent outline; pan bounds and
  zoom floor while in a region; Reset view button and Mod+0; breadcrumb; region in the URL; remove the
  zoom-driven tilt from `tiltTerrain`, 3D toggle tilts only in region view, off by default; reduced
  motion jumps. Used by PhotoMap and RegionMap. Out: hand-tuning every country (start with the list above).
- **Files:** `apps/web/src/lib/pmtiles.ts` (`tiltTerrain`), new `apps/web/src/lib/regionCamera.ts`,
  `PhotoMap.tsx`, `RegionMap.tsx`, a regions API response (framing field), new overrides JSON, `lib/keymap.ts`,
  `keyboard-shortcuts.md`, `docs/docs/guides/photo-map.md` (Flat or 3D section).
- **Depends on:** MAP-02 (panel opens with the region). Better after MAP-14 so screenshots show the final look.
- **Tests:** unit: framing for Chile, Fiji, USA, France, Norway matches the rule or override; e2e: click
  Canada, then BC, pan to the edge (held), Reset view, Back to the world; reduced motion jumps.
- **UX checks:** N1, N3, N5, P2, Y3 (motion), A4.
- **Risks:** fitBounds across the antimeridian; mask polygon cost for detailed outlines (simplify once,
  cache).
- **Parallel with:** MAP-04 to MAP-06.

### Wave 2: search

#### MAP-07 Offline gazetteer data

- **Progress (2026-11-04):** base set built. Migration 183 `gazetteer_places`; its own `gazetteer` stage
  in the refresh command (after `places`), `packages/data-pipeline/src/pipeline/gazetteer.ts`; in the
  catalog seed and its install merge. Maintainer decision: `cities1000` (171,771 towns, cap 8 MB)
  instead of `cities5000` (70,000), so Tofino-size towns are found. First run on the Docker `lifer`
  database 2026-11-04: every town has a country, 99.6% a province; 6.2 MB compressed in the seed; 61 MB
  installed (28 MB of it indexes); a search takes 1 to 18 ms. Not yet published
  (next-catalog-republish.md 5i). Per-region pack features are still to do.

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus licence and attribution check. **Approval gate:** the
  `gazetteer_places` migration (next free number). **Publish gate:** the maintainer's go-ahead.
- **Goal:** complaint 1, data side: towns and wildlife places searchable offline.
- **Scope:** in: `gazetteer` step in the `places` stage (base `cities5000` into the catalog seed;
  per-region feature lists into packs), resumable per country; `gazetteer_places` table filled on seed
  and pack install, removed with the pack; size report per pack. Out: search UI (MAP-08).
- **Files:** `packages/data-pipeline/src/pipeline/places.ts`, `src/scripts/refresh.ts`, `pipeline/packs.ts`,
  `apps/api/src/offlinePacks/apply.ts` and `remove.ts`, `schemas.ts`, `apps/api/scripts/fetch-catalog-seed.js`
  if the seed format needs it, migration, `docs/docs/credits.md`.
- **Depends on:** none.
- **Tests:** pipeline test on one small country; pack install then remove leaves no rows; base set under
  3 MB compressed or the package stops and reports.
- **UX checks:** none (MAP-08 shows it).
- **Risks:** pack size creep for lake-heavy countries (Canada, Finland); cap and report.
- **Parallel with:** MAP-05, MAP-06.

#### MAP-08 Place search over the gazetteer

- **Progress (2026-11-04):** API done. `/places/locate` lists up to five `kind: "town"` results after
  spots and regions (`apps/api/src/places/gazetteer.ts`, ranking unit-tested). The picker rows and the
  empty-state hint are still to do on the web side.

- **Model:** Sonnet 5.5. **Review:** Opus 5.5 (ranking).
- **Goal:** complaint 1, app side.
- **Scope:** in: `/places/locate` searches spots, regions and `gazetteer_places` with the ranking above
  and `near`; result kinds and detail lines; pin at a town or feature; "Download this region for more
  places" empty hint; placeholder "Search places, e.g. {example_city}". Out: online search (MAP-09).
- **Files:** `apps/api/src/places/locate.ts` and test, `apps/web/src/components/PlaceSearch.tsx`,
  `RegionPicker.tsx` (result rows, if it needs a kind icon), locales.
- **Depends on:** MAP-07.
- **Tests:** "tofino" finds Tofino first in BC view; "point pelee" finds the park with the Ontario pack;
  saved spot named "Tofino mudflats" ranks first; accents and apostrophes per Q4; 200-character query.
- **UX checks:** Q1, Q2, Q3, Q4, W10, S6, S8.
- **Risks:** duplicates between a region and a same-named town (Quebec); keep both, detail tells them apart.
- **Parallel with:** MAP-10.

#### MAP-09 Optional online address search

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a privacy review: with the setting off a network
  capture shows no geocoder request; with it on only the text is sent.
- **Goal:** addresses, off by default.
- **Scope:** in: setting with the one-sentence notice and editable endpoint (Photon default, Nominatim
  compatible option on Enter only); `GET /places/online` proxy with throttle, User-Agent, 24 h cache,
  timeout; "Online results" rows with attribution; offline and failure rows. Out: reverse geocoding
  online (never: it would send coordinates).
- **Files:** new `apps/api/src/places/onlineSearch.ts` and test, settings route and pane, `PlaceSearch.tsx`,
  locales, `docs/docs/guides/photo-map.md`, privacy page in docs.
- **Depends on:** MAP-08.
- **Tests:** unit: throttle, cache hit, timeout; integration with a fake endpoint; setting off returns 404
  and sends nothing.
- **UX checks:** W5, W6, S1, S9, F6.
- **Risks:** Photon's public terms change or it throttles; the endpoint field and offline results cover it.
- **Parallel with:** MAP-10, MAP-11.

### Wave 3: polish

#### MAP-10 Box select on the map

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** take the photos at dots without a Gallery visit, to move or fix them.
- **Scope:** in: Shift-drag draws a box (replaces box zoom), selects photos at the dots inside via
  `/gallery/ids?bbox`, shows them in the panel with Move and Remove location; drag the selection to a new
  point. Out: lasso (box covers the need; revisit if asked).
- **Files:** `PhotoMap.tsx`, `MapPhotoPanel.tsx`, `lib/keymap.ts`, `keyboard-shortcuts.md`.
- **Depends on:** MAP-02, MAP-05, MAP-06.
- **Tests:** e2e: box 3 dots, move them, undo.
- **UX checks:** M4, M8, F3, Y1.
- **Parallel with:** MAP-08, MAP-09.

#### MAP-11 "Place with the rest of this session" suggestions

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check nothing is placed without a click.
- **Goal:** the strongest offline hint: unplaced photos from a session that also has placed photos.
- **Scope:** in: Suggested section in the tray; the suggested point is the median of the session's placed
  photos; "Place there" places with one click and Undo. Never automatic (PhotoPrism's estimates show why).
  Out: guesses from other days.
- **Files:** `apps/api/src/gallery/unplaced.ts`, `NeedsPlacingTray.tsx`, locales.
- **Depends on:** MAP-04, MAP-05.
- **Tests:** a session with 9 placed and 14 unplaced suggests the median; a session split across two
  places 30 km apart offers no suggestion (spread over 2 km).
- **UX checks:** D5, F3, W11.
- **Parallel with:** MAP-09, MAP-12.

#### MAP-12 Nearest-town names, offline

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** hover and panel titles say "Near Tofino" instead of "This area".
- **Scope:** in: nearest gazetteer place within 25 km for a cell or cluster centre, computed locally in
  the API; falls back to the region name. Out: writing it to files or labels.
- **Files:** `apps/api/src/places/` (lookup), `MapHoverPreview.tsx`, `MapPhotoPanel.tsx`.
- **Depends on:** MAP-07, MAP-03.
- **Tests:** unit on lookup; empty gazetteer falls back.
- **UX checks:** S5, W11.
- **Parallel with:** MAP-11.

#### MAP-13 Saved spots tab, narrow windows and the extremes sweep

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** finish: spots list on the map, bottom sheet behaviour, docs, and an extremes pass.
- **Scope:** in: Spots tab (search, in-view first, virtualised, wrapping names); narrow-window sheet
  checks; guide rewrite for the new flows; e2e on the extreme seed (200,000 photos, 20,000 dots, 500
  spots, 300-character names, 360 px width) across macOS, Windows and Linux.
- **Files:** `apps/web/src/components/map/`, `SavedSpots.tsx`, `docs/docs/guides/photo-map.md`, e2e specs.
- **Depends on:** Waves 1 and 2.
- **Tests:** the e2e set above; Q-10 page budgets for the map.
- **UX checks:** L1, S7, S8, X4, C9, T1.
- **Parallel with:** none (last).

### Order

```
Wave 1:  MAP-01 --+                 MAP-06 (parallel, any time)
         MAP-02 --+--> MAP-03
                  +--> MAP-04 --> MAP-05
         MAP-01, MAP-02 --> MAP-14 (look) --> MAP-15 (region view)
Wave 2:  MAP-07 (starts beside MAP-05) --> MAP-08 --> MAP-09
Wave 3:  MAP-10, MAP-11, MAP-12 --> MAP-13
```

Rebuild the desktop dev app only between waves, when no worker is editing `apps/web` or `apps/api`.

## Open decisions

1. **Single click on a cluster:** open the panel without zooming (recommended; double-click zooms), or
   keep today's zoom-and-select?
2. **Placing at a searched town without moving the pin:** store a rough accuracy (about 1 km for a
   feature, 2 to 10 km for a town by population) and still count it as placed (recommended), or refuse to
   count it as placed until the pin is moved?
3. **"Region is enough":** let the user mark photos (old scans, captive animals) so they leave the tray
   and the count, stored as one nullable column on captures, undoable. Recommended **yes**, otherwise the
   count never reaches 0 for many libraries and becomes a nag (F6). It needs a migration outside the
   current specs. Alternative: no marking, and the count stays informational only.
4. **Mod+F on the map page** focuses place search instead of opening the palette. Recommended yes
   (search in the page toolbar is the expected Find there; I could not confirm Lightroom's Map module
   does this). Alternative: no shortcut, search is the first Tab stop.
5. **Online geocoder default when turned on:** Photon public with an editable endpoint (recommended), or
   no default at all and the user must enter an endpoint (most private, least useful).
6. **Gazetteer size:** base `cities5000` in the catalog plus feature lists in packs (recommended), or
   `cities1000` in the base (about 130,000 places, roughly 2.5 times the size) and no pack lists.
7. **Drop the count choropleth:** stop tinting countries by photo count (recommended: it is the main
   reason the map looks muddy, and the list and hover carry counts), or keep it at a much lower range.
8. **Region view tilt:** top-down by default with 3D as a remembered toggle (recommended, matches Specio
   and keeps framing stable), or tilted by default in region view only.
9. **Region view lock:** pan held to the region plus 25% with Reset view and a breadcrumb (recommended),
   or free roaming once inside with only Reset view.
10. **Labels on the map:** country, province and town labels with a bundled font, under 1 MB
    (recommended), or stay label-free like Specio's continent view and rely on hover and search.
11. **Palette sign-off:** the hex values above are a proposal; the maintainer should see light and dark
    screenshots from MAP-14 before they are final (V-01's sign-off rule).
