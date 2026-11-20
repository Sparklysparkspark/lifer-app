# Map detail and satellite

Plan packages V-12 (optional online detail tiles, built here) and V-11 (detailed offline extracts, scoped
here as a follow-up). Privacy rules from `map-location-ux.md` (local by default, plain words on what is
sent) apply throughout. Researched 2026-11-04.

## The problem

The built-in basemap is the world PMTiles archive, zoom 0 to 8 (relief to 5). Past about zoom 10 the
map only enlarges zoom 8 tiles, so it goes soft, and there is no satellite view. The maintainer: "you
can't zoom in to dynamically see higher res tiles and you can't switch to satellite view".

## Decision

| Need                               | Chosen                                                                  | Licence and terms                                                                                                                           | Limits                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vector detail above zoom 8, online | OpenFreeMap (`tiles.openfreemap.org/planet`)                            | OSM data under ODbL; schema OpenMapTiles (BSD and CC BY 4.0 for the schema); no key, no account, no cookies; commercial and app use allowed | Tiles to zoom 14, drawn sharper to zoom 18 (vector overzoom). No SLA: may be withdrawn without notice.                                                                 |
| Satellite imagery, online          | EOxCloudless (Sentinel-2 cloudless 2025, `tiles.maps.eox.at`) by EOX    | CC BY-NC-SA 4.0 for non-commercial use: Lifer is free, AGPL and non-commercial, so it qualifies; a commercial companion app must never use it       | About 10 m per pixel. Native to zoom 14, shown to zoom 16. Good for habitat, coasts, lakes, forest edges and field patterns; not individual trees, paths or buildings. |
| Better imagery                     | The user's own provider URL (key kept in that browser's local settings) | The user's account and that provider's terms                                                                                                | Whatever the provider gives, to zoom 19                                                                                                                                |
| Street detail offline              | Per-country PMTiles extracts (V-11, follow-up below)                    | OSM under ODbL; Protomaps tools BSD                                                                                                         | Not built in this package                                                                                                                                              |

Plainly: **no key-free source gives sharp, high-zoom imagery worldwide.** Sentinel-2 at 10 m is the best
legal key-free global option. Anyone who wants sub-metre imagery can paste their own provider's tile
URL.

### Vector detail: options checked

- **OpenFreeMap (chosen).** Public instance with "no registration, no user database, no API keys, and no
  cookies" and "no limits on the number of map views or requests". The terms (openfreemap.org/tos) limit
  offline downloads (3,000 tiles or 50 MB, 4 parallel requests, a unique User-Agent) and automated
  collection; Lifer does neither, it loads only the tiles in view. Required attribution: "OpenFreeMap
  © OpenMapTiles Data from OpenStreetMap" (the TileJSON carries it and MapLibre shows it). Requests pass
  through Cloudflare. TileJSON: `https://tiles.openfreemap.org/planet`, zoom 0 to 14. Heavy users are
  asked to sponsor; worth a note in credits.
- **Protomaps hosted API.** Needs an API key: rejected (a bundled key in an open-source app is not
  acceptable).
- **Protomaps daily planet builds** (`build.protomaps.com`, about 120 GB). Meant for download, not as a
  live tile CDN for apps. Right source for V-11 extracts, wrong for online viewing.
- **VersaTiles** (`tiles.versatiles.org`). Also key-free and OSM based, Shortbread schema. A fallback if
  OpenFreeMap goes away; not checked in depth.
- **OpenStreetMap's own tile servers.** Their tile usage policy does not allow this kind of app use, and
  they are raster only: rejected (already ruled out in the 1.0 plan).

Schema and look: the bundled archive uses the Protomaps schema, OpenFreeMap uses OpenMapTiles, so the
detail layers are their own small set (`detailLayers` in `apps/web/src/lib/mapStyle.ts`) painted with
the same `--color-map-*` tokens: water, woods, grass, ice, parks, rivers, quiet roads from zoom 10,
dashed trails from zoom 12, and town, village and water names with the same font and halo. No buildings,
POIs or icons, as in the calm style. Names use `name:latin` because the bundled glyphs are Latin only.

### Satellite: options checked

- **EOxCloudless by EOX (chosen).** Licence summary: "You may use EOxCloudless freely for non-commercial
  purposes" under CC BY-NC-SA 4.0, "as long as the attribution is preserved". Attribution:
  "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel
  data 2025)". WMTS layer `s2cloudless-2025_3857`, matrix set `g`; tiles answer with
  `Cache-Control: max-age=604800` and open CORS. Tiles past zoom 14 are only upscaled server side, so the
  source stops at 14 and MapLibre enlarges to 16 (fewer requests, same picture). Heavy or bulk use goes
  through `cloudless@eox.at`; Lifer never prefetches.
- **Esri World Imagery.** Esri's terms tie basemap use to an ArcGIS account (API key or sign-in), and
  older permissions for non-Esri apps were conditional and have since changed: rejected.
- **NASA GIBS.** Key-free and open, but the global true-colour layers are 250 m daily (MODIS, VIIRS),
  cloudy, and stop around zoom 9 to 12. Worse than Sentinel-2 for this use.
- **USGS National Map imagery.** Public domain and sharp (about 1 m, to zoom 16), but United States only,
  so not a global default. A user in the US can paste it as their own URL.
- **Own-key providers** (for the custom URL): MapTiler Satellite (free tier needs an account and key, its
  terms cap free use and require attribution), Stadia Maps (account key; satellite is a paid product),
  Mapbox Satellite (access token; its terms limit some APIs to Mapbox SDKs, check before use). The key
  lives only in that browser's local settings (localStorage under `lifer:photo-map-satellite-url`), never
  in the repo or on the Lifer server.

## Privacy and network use

Maintainer decision (2026-11-04): online detail is automatic, like the app's other non-photo
downloads, and disclosed with them on the Privacy page rather than asked for on the map.

- **Three choices**, in the map's layers button and in Settings > General > Map and places: **Automatic** (the
  default), **Off** (the map never uses the network) and **Satellite** (picking it is the consent; the
  panel says once, under the choice, who provides the imagery and what it sees). Remembered per browser with
  `usePersistedState`; the old opt-in switch migrates (an explicit off stays Off, on becomes
  Automatic).
- **Automatic** loads detail only when the map is zoomed past 8 (the bundled map's maximum, beyond
  which it only enlarges its tiles) and `navigator.onLine` is true. It applies on every map, not just
  the photo and Collection maps: `addMapCredits` adds `MapOnlineDetail` to each map with its credits
  (the dialog maps for placing photos and adding a spot get satellite too when it's picked; the packs
  and hotspot maps get only the sharper map), and the layers button only reads what that publishes. The source is added the first time the map reaches that zoom, so the
  world view sends nothing, not even the TileJSON; every detail layer has `minzoom` 8, so zoomed back
  out MapLibre marks the source unused and requests no tiles, and the bundled map shows again.
  Offline, the online layers are removed and nothing is requested.
- **What is sent:** only tile coordinates for the area on screen (plus the IP address and the Lifer
  origin as Referer). No photo, species or photo location is part of any request. Disclosed on
  `docs/docs/privacy.md#map-tiles` beside the GitHub, iNaturalist and GBIF downloads, in the guide, and
  in one line under the choice in the panel and in Settings.
- **Failure:** the bundled map stays underneath, plus one quiet line, "Online map unavailable. Showing
  the offline map." The same line shows while offline if online tiles are wanted. A weak connection
  is slow, not down: slow tiles just arrive later (after 5 s without a tile a quiet "Loading map
  detail" shows); only five or more hard tile errors over at least 10 s with no tile arriving count as
  unavailable. Meanwhile the online layers are re-added in the background (5 s, doubling to 60 s),
  never turned off, and the first tile that arrives clears the line. Place search and naming wait up
  to 15 s ("Searching online" meanwhile) before saying online search is unavailable.
- **Polite use:** only the viewport's tiles, MapLibre's tile cache and the providers' HTTP cache
  headers, no prefetch, no offline download of online tiles. A page cannot set its own User-Agent.

### Credits

Maintainer feedback (2026-11-04): first the long always-visible line, then even a short line, muddied
the map. Every map now has one small (i) button in the bottom-right corner
(`components/map/MapCredits.tsx`, with MapLibre's `attributionControl: false`; MapLibre's own compact
control is not used). It opens on a click, Enter or Space, or a 300 ms mouse hover, and closes by
itself: 1.5 s after a hover ends, on Esc, on a click elsewhere (the layers button included), when the
map moves, and after 8 s untouched (the pointer or focus inside holds it). The popover lists each
source's full citation and links, those on screen first, the rest under "Also used"
(`lib/mapCredits.ts`). While satellite is on, the first entry is EOX's own sentence word for word,
"EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel
data 2025)", with the CC BY-NC-SA 4.0 link. While relief shows, the Terrain Tiles entry is near the
top with every source notice in full (Crown copyright, Kartverket and the rest), plus the link to the
full list. `docs/docs/credits.md` and `THIRD_PARTY_NOTICES.md` keep the complete text.

What each provider asks, and whether credits one click away meet it (an honest reading, not legal
advice):

| Source                            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Behind the (i) button                                                                                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenStreetMap                     | ODbL attribution. The OSMF Attribution Guidelines (osmfoundation.org/wiki/Licence/Attribution_Guidelines): the credit "should typically appear in a corner of the map", and "the attribution format should not require individuals to interact with the map ... to see the attribution". It may then fade or collapse "automatically on map interaction such as panning, clicking, or zooming" or "automatically after five seconds", as long as "the user must still be able to find the licence information if they look for it", for example "an '(i)' button in the corner of the map"; it "does not need to be presented to the user every time" | Yes, as built: the first map of each session shows "© OpenStreetMap contributors" beside the (i) for five seconds (gone sooner if the map moves), then only the (i) button, which gives the full credit and the copyright link                                                          |
| OpenMapTiles schema (OpenFreeMap) | CC BY 4.0: credit in a reasonable manner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Yes (CC BY 4.0 section 3(a)(2) allows any reasonable manner for the medium, including a link or a control that shows it)                                                                                                                                                                |
| OpenFreeMap                       | Its own name is optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Yes                                                                                                                                                                                                                                                                                     |
| EOX Sentinel-2 cloudless          | CC BY-NC-SA 4.0, and EOX's licence page gives the exact sentence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Decided (maintainer, 2026-11-04): the full sentence first in the popover while satellite is on is enough. CC BY-NC-SA 4.0 section 3(a)(2) lets the credit be given in any reasonable manner based on the medium, which for an interactive map can be a control that shows it on request |
| Terrain Tiles and its sources     | Each source's notice (open-government licences, Crown copyright, Kartverket)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Shown in full in the popover while relief shows, under its own entry near the top, and on the credits page                                                                                                                                                                              |
| Protomaps                         | BSD-3-Clause for code and style                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Yes, no on-map credit required                                                                                                                                                                                                                                                          |
| Natural Earth                     | Public domain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Yes                                                                                                                                                                                                                                                                                     |
| Photon                            | Fair use; ODbL data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Yes, also credited under its search results                                                                                                                                                                                                                                             |

### Sensitive species

Decided by the maintainer (2026-11-04): no pause of automatic tiles for sensitive-species photos.
A tile request carries only the map square and the IP address; the provider can't know a species is
involved.

## Online place search and names (Photon)

Maintainer request (2026-11-04): the map's place search also searches online when connected, and
reverse place names (for PLACE-05 locality inference) go through the same switch.

- **Provider: Photon by komoot** (`photon.komoot.io`). Key-free, built for search-as-you-type, CORS
  open (`Access-Control-Allow-Origin: *`), answers with `Cache-Control: max-age=3600`. Terms on the
  site: "You can use the API for your project, but please be fair - extensive usage will be
  throttled", and no availability guarantee. No numeric limit is published. Data is OpenStreetMap
  under ODbL, so results carry "Photon (komoot), © OpenStreetMap contributors". Nominatim is not
  used for this: its usage policy bans autocomplete.
- **Setting:** "Online place names and search", Automatic (default) or Off, per browser
  (`lifer:places-online`), in Settings > General > Map and places and in the layers panel. Off means
  no network use for places at all; the library's own spots and regions are always searched.
- **One-time notice:** the first time an online search goes out, a line under the results says what
  is sent (the typed text to Photon, which sees the IP address; no photos), with Got it and Turn off.
  Remembered (`lifer:places-online-noted`) once either is clicked.
- **What is sent:** forward search sends the typed text and the map's centre rounded to one decimal
  (about 10 km); reverse naming sends the point rounded to three decimals (about 100 m). Never a
  photo or a species. The maintainer decided (2026-11-04) not to add a sensitive-species refusal
  here or a pause of automatic tiles: the services only see coordinates and an IP address and can't
  know a species is involved. The sensitive-species protections that remain are for iNaturalist
  uploads (geoprivacy raised), a different thing.
- **Polite use:** 350 ms debounce, three characters minimum, in-flight requests cancelled, results
  cached per query for the session (200 entries), six results per query. A 429 or 5xx pauses every
  online place request for 30 seconds, doubling to 10 minutes; offline results keep working and one
  quiet line says "Online search unavailable".
- **Results:** library places first, then an "Online results" group, deduped by name within 5 km of
  anything already listed, each with its place type and region ("Tofino Inlet, Town, British
  Columbia, Canada"). Picking one flies the map there (to its extent when Photon gives one) or drops
  the pin, exactly like a library result.
- **Code:** `apps/web/src/lib/onlinePlaces.ts` (`searchPlaces`, `reversePlaceName`,
  `dedupePlaces`, `PHOTON_ATTRIBUTION`) and `apps/web/src/hooks/useOnlinePlaces.ts` (setting,
  `enabled`, notice state). Reverse naming is exported for the places work but not wired in yet;
  callers check `useOnlinePlaces().enabled` and show the same notice.

## Content Security Policy

- The web UI, in the browser and in the desktop app, is served by the API, whose helmet CSP already has
  `img-src 'self' data: blob: https:` and `connect-src 'self' https: ipc: http://ipc.localhost`
  (`apps/api/src/index.ts`). The tile hosts load with no change.
- The Tauri CSP in `apps/desktop/src-tauri/tauri.conf.json` covers only the bundled pages (picker,
  startup), which never show a map. No change; the capabilities in `capabilities/default.json` are about
  IPC commands, not network hosts.
- The policy is static: a header can't follow a per-user switch, so the gate is in the app (no online
  source exists in the map until the switch is on, which a test checks). Narrowing `https:` to named
  hosts (OpenFreeMap, EOX, iNaturalist photo hosts and the rest) would harden it but breaks a custom
  satellite URL and needs an audit of every other online feature: open decision, not done here.

## Zoom

- Offline or Off: unchanged (MapLibre's default maximum).
- Detail in use: maximum zoom 18. Satellite: 16 (EOX), or 19 with a custom URL.

## Build notes

- `apps/web/src/lib/mapStyle.ts`: `ONLINE_PROVIDERS`, `detailLayers`, `satelliteLayers` (raster plus
  light labels over imagery), `onlineMaxZoom`, `BASEMAP_ATTRIBUTION`. The bundled layers are unchanged.
- `apps/web/src/hooks/useOnlineMap.ts`: the prefs (with the migration) and `useOnlineBasemap`, which
  adds or removes the online sources and layers under the photo and region layers without reloading
  the style, so switching doesn't flash.
- `apps/web/src/components/map/MapLayersControl.tsx`: the icon-only layers button (a neutral
  house IconButton through FilterPopover, tooltip "Map layers", a small accent dot while online
  tiles are in use, fading in on hover on the Collection map) and the failure line under it.
- `apps/web/src/components/map/MapCredits.tsx` and `apps/web/src/lib/mapCredits.ts`: the (i) credits
  button on every map.
- Satellite keeps the photo layers legible: region rings get a frosted fill and a firmer stroke over
  imagery; dots and clusters keep their surface stroke. The region dim mask sits above the imagery.

## Follow-up package: V-11 detailed offline extracts

Not built now. What it takes:

- **Cut.** A `maps` stage in `refresh` that runs `pmtiles extract` against a pinned Protomaps daily
  build, per country (region outline as the clip), maxzoom 14 or 15. Resumable and incremental: skip a
  country whose build date and outline hash are unchanged. One command, per the single-command rule.
- **Sizes (estimates, measure in V-11).** The planet at zoom 15 is about 120 GB, mostly in dense,
  well-mapped places. Expect tens of MB for a small or sparsely mapped country, a few hundred MB for a
  mid-sized one, and several GB for the largest (United States, Canada, Russia, Germany), which split by
  province or state as the plan says.
- **Packs.** A new pack kind "map" in `apps/api/src/offlinePacks` (manifest entry with size and
  checksum like region packs, download and remove through the same jobs, size shown before download with
  free space, P-03), listed in `DownloadedPacksList` beside the region it covers.
- **Serving and style.** The API (and `apps/desktop/src-tauri/src/api.rs`) serves the extract like the
  world archive; `pmtiles.ts` adds it as a second Protomaps-schema source with `minzoom 8` and the
  extract's bounds, styled by `quietLayers` so it looks the same as the world map, plus roads and
  trails. Where an extract exists, offline zoom goes to 15 without online detail, and the "More detail"
  hint offers the download for that country as well as the online switch.
- **Attribution.** OSM ODbL on every map (already shown) and in credits.
