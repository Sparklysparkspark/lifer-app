# Library first: point Lifer at your photos and it does the rest

Drafted 2026-10-22, after looking at Specio (Cyme) and Peakto. Nothing here is decided yet.

## The problem

Lifer can already bulk import (`BulkImportPage`), recognise species and build the life list. But the
first-run and import flow reads as photo-by-photo review, so it looks like you have to do everything one
at a time. Specio's pitch is "point it at your library and it figures out the rest", and that should be
Lifer's front door too.

## The flow

1. **First run: "Where are your wildlife photos?"** Pick folders or drives, or a Lightroom Classic
   catalogue (task #56). Apple Photos would come later. Nothing is copied or moved unless the user asks.
2. **Analysis runs in the background.** It never blocks the app (`ux-rules.md`). A progress strip shows:
   - photos analysed
   - photos with animals
   - species found
   - share confirmed

   The Collection and the home view fill in live as results arrive.
3. **Lifer handles the obvious ones.** A confident identification inside the region's checklist is
   filed automatically. It stays marked "suggested" until the user confirms it, and it counts on the
   life list with that marker (user decides, Lifer handles the rest).
4. **One review queue for the rest: "Review identifications".**
   - It is grouped by species and by encounter, so the user confirms 40 frames of a heron in one action
     rather than 40 times.
   - It is sorted by how much each answer matters: possible lifers first, then low confidence, then
     everything else.
   - It is fully keyboard driven, with a large photo, the top suggestions and a "not sure" option.
   - Progress shows as "312 of 1,940 confirmed". The queue can be left and resumed at any time.
5. **Later imports** go through the same pipeline. Watched folders pick up new photos automatically.

## A home view (Specio's dashboard, in Lifer's own style)

- **Headline counts:** photos, species, places, trips, share confirmed.
- **A map of places,** with photo clusters. Clicking a place shows its species and photos.
- **Taxa group tiles:** each group's species count against the catalogue total ("83 of 11,000+
  birds"), with cover photos chosen by quality.
- **A conservation tally** (critically endangered, endangered, vulnerable). This uses IUCN data, which
  is fine for Lifer as free, non-commercial software.
- **Activity over time:** a timeline of photos by month that can be brushed to filter.
- **Gear:** which bodies and lenses produced which photos.
- **Targets and "still need a photo"** for the user's current or next trip.

## A free Lightroom Classic plugin

Specio's main hook is that it works inside Lightroom Classic: it identifies species and writes them as
keywords into the catalogue. Lifer already writes species to XMP, but Lightroom users want it to happen
in Lightroom without thinking about it.

- **What it does:** a small Lightroom plugin (written in Lua) talks to Lifer's local API and brings in:
  - confirmed species as keywords, with the common name, scientific name and taxonomy hierarchy, in a
    layout the user can choose
  - ratings
  - "lifer", "target" and "still need a better photo" as keywords or metadata
- **Both directions:** a menu item "Send selection to Lifer" sends photos the other way, for
  identification or import.
- **When it runs:** on demand from the Library menu, or automatically when Lightroom imports photos.
- **Together with catalogue import (task #56),** this makes Lifer a companion to Lightroom rather than a
  replacement.
- **Free, like the rest of Lifer.** It never uploads anything; it only talks to Lifer on the same
  computer (or the user's own server).

## Placing photos on a detailed map

Lifer already has a "Set coordinates" dialog (`CoordinatesModal`) and photo maps. But its offline
basemap (`world-z8.pmtiles`) only goes down to zoom 8, so a pin can't be put on a specific pond or
trail. Setting a photo's place should never need iNaturalist or any other account.

- **Detailed maps per region, offline.** A region pack can optionally include a detailed map extract for
  that country (street and trail level, built once with Protomaps and served like the packs). Pack
  sizes are shown before downloading. The app uses the detailed map where one exists and the world
  map elsewhere.
- **Optional online detail anywhere,** off by default: "Load detailed map tiles from the internet when
  zooming in." Tiles are fetched as needed and cached.
  - The setting says plainly that it sends the map area you're viewing to the tile provider.
  - It's never used while placing or viewing sensitive-species photos, so their locations can't leak.
  - It needs a provider whose terms allow app use (MapTiler, Stadia or Protomaps), or our own tile
    hosting. OpenStreetMap's own tile servers don't allow it.
- **Placing photos:**
  - drag one photo or a whole selection onto the map
  - search for a place by name, offline from the region data
  - reuse a saved spot (task #64)
- **Species re-checked after placing.** The new location feeds the regional checklist, so look-alike
  species are told apart (Specio does this). Suggestions change only for unconfirmed photos, and the user
  sees what changed.

## Map and timeline look

These notes are from studying Specio's home screen, to be done in Lifer's own style.

- **A quiet basemap:** a custom style for the existing offline map, desaturated cream and grey (charcoal in
  dark mode), so photos and data carry the colour.
- **Optional subtle shaded relief,** from open elevation data (Copernicus DEM or SRTM), baked in for the
  world zoom levels. Measure the size before deciding.
- **The map as the whole canvas** on the home view, with floating cards. The cards must pass the
  contrast checks; no frosted glass over busy areas, and nothing hiding map points.
- **One colour per taxa group,** used everywhere: group tiles, timeline bars, gear charts, map clusters.
  This is part of the visual language (task #75).
- **Editorial display type** for headings, with simple numbered cluster dots. Hovering a place shows a
  small grid of its photos.
- **Timeline bars stacked by taxa group,** linked both ways with the map: brushing dates filters the
  map, and selecting a place highlights its dates.

## Other ideas worth taking

- **A tree-of-life explorer:** walk class, order, family and genus down to species, with counts and the
  best photo at each level, plus CSV export.
- **Cover images picked by quality,** not by date (the sharpness and subject scores already exist).
- **Natural-language search:** "heron catching a fish at sunset". The CLIP search largely does this
  already; it needs to be put front and centre.
- **One trash across all sources.**

## Visual quality

Specio's look comes from a few deliberate choices:
- an editorial display typeface for headings, paired with a clean UI face
- illustrated taxa artwork
- a calm textured map
- dense but quiet data visualisation
- generous whitespace

For Lifer, in Lifer's own brand (sage, cream and charcoal, flat illustration, never a copy):

1. **Define a visual language first:**
   - a display and text typeface pair
   - an illustration style for the taxa groups
   - map styling
   - chart styling

   Do this before building screens. Prototype it as a design, then implement it in design tokens.
2. **Design the home view and the review queue** as high-fidelity mockups and get the maintainer's
   sign-off before coding.
3. **Hold every screen to `ux-rules.md`** and its checks, the HIG review and the extremes fixtures
   (0 photos, 1 photo, 200,000 photos, very long names), in light and dark.
4. **Make speed part of polish:** the home view and review queue open instantly from local data
   (performance sweep, task #58).
