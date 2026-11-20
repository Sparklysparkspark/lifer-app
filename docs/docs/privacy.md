---
title: Privacy
description: What Lifer sends over the network, to whom, and why. Lifer has no telemetry and never sends anything by itself.
---

# Privacy

Lifer has **no telemetry, no analytics and no ads**, and never sends anything by itself. Nothing about you or your library is sent to the Lifer project. If Lifer crashes, you can choose to send a [crash report](#crash-reports), which holds only the crash details, never anything about your photos or collection. Your photos and your database stay on the drives and server you choose.

Lifer does download public data from a few services, and some features talk to them directly. Each one sees your IP address and what was asked for, like any website you visit. This page lists every connection Lifer makes.

## Downloads of Lifer's data and updates: GitHub

Lifer's own data and updates are published as GitHub releases of [the Lifer repository](https://github.com/Sparklysparkspark/lifer-app):

- **The species catalog** (`catalog-latest`), the first time Lifer starts and when you update the catalog.
- **Downloaded regions and their photos** (`packs-latest`, `photos-latest`), when you download a region.
- **The offline map** (`map-latest`), only if you download it.
- **Species recognition models** (`models`), only if you turn species recognition on.
- **Update checks:** the desktop app checks for a new version, and the web app's update banner asks GitHub for the latest release.

Only the file being downloaded is requested; nothing about your library is sent.

## Species recognition on a GPU {#species-matching-on-a-gpu}

Only if species recognition is on and Lifer finds a GPU it can use:

- The full-precision photo model comes from **Hugging Face** (huggingface.co).
- GPU runtime libraries come from the **npm registry**, **PyPI** or **NuGet**, depending on your system.

Matching itself always runs on your own computer or server. Your photos are never sent anywhere to be identified. `LIFER_GPU=off` keeps matching on the CPU and skips these downloads.

## Species information and photos: iNaturalist, GBIF and Wikimedia

To fill in species details Lifer doesn't have yet, it looks species and places up by name:

- **iNaturalist** (api.inaturalist.org, with photos from inaturalist-open-data.s3.amazonaws.com and static.inaturalist.org): reference photos and descriptions when you open a species, the main photo of species in your downloaded regions whose photos couldn't be included for licensing reasons ([turn this off](./settings.md#withheld-photos)), and the matching iNaturalist place for a region.
- **GBIF** (api.gbif.org): taxonomy and occurrence counts for species and regions that aren't covered by your downloaded regions.
- **Wikimedia Commons** (upload.wikimedia.org): some reference photos.
- **GitHub** (raw.githubusercontent.com): country and province outlines from Natural Earth, when a region outside your downloaded regions is first shown.

What's sent is the species or place being looked up, never your photos or your library.

## Map tiles and place search: OpenFreeMap, EOX and Photon {#map-tiles}

- **Map detail:** when you zoom the photo map in past what the offline map shows and are online, Lifer loads map tiles from **OpenFreeMap** (tiles.openfreemap.org). Each request is only the map square being drawn, so the provider sees the area you're viewing and your IP address, never your photos or species. Set **Online detail** to **Off** in the map's layers button or under [Settings > General > Map and places](./settings.md#map) to keep the map fully offline.
- **Satellite:** only if you pick it, imagery comes from **EOX** (tiles.maps.eox.at) the same way, with place names from OpenFreeMap. A satellite address you add yourself goes to that provider instead.

- **Place search and place names:** when you're online, the map's place search also looks online, at **Photon** by komoot (photon.komoot.io): it gets the text you type and the middle of the map rounded to about 10 km, to rank nearby places first. Naming a place from a point (such as "Prince George, British Columbia, Canada") sends that point rounded to about 100 m. Photon sees your IP address; no photos or species are sent. The first time, a note by the search field says so, with **Turn off**. Set **Online place names and search** to **Off** under [Settings > General > Map and places](./settings.md#map) (or in the map's layers button) to keep place search on your device; your saved spots and regions are always searched offline.

Tiles and place results are loaded only as needed, and kept in the normal browser cache.

## Only when you choose to

- **Sending observations to iNaturalist:** if you link your iNaturalist account and send photos as observations, the photos, dates, locations and species you choose are sent to iNaturalist under your account. Nothing is sent until you do.
- **eBird import:** Lifer never connects to eBird. You export your data from eBird yourself and import the file.
- **Share links** (servers only): a share link shows exactly the album or trip you shared, to whoever has the link, until you delete it.

## Crash reports {#crash-reports}

If Lifer crashes, it offers to send a report the next time it opens. It goes to the Lifer project (reports.liferwildlife.com) only if you click **Send report**. It holds Lifer's version, your operating system and processor type, the error and where in Lifer's code it happened, and the note you add, if any. Paths, file names, names, keys, emails and coordinates are removed first, and **Show what will be sent** shows the report exactly. On a server, the reports appear for the signed-in account. Packagers can turn crash reports off with `LIFER_CRASH_REPORTS=off`.

## Companion apps

Lifer itself never contacts any companion app's maker. Apps you add to Lifer run on your computer, can only use the parts of your library you approved, and may make their own network calls, which their makers describe.

A suggested app downloads only when you press **Install** on its page, from the address that page names, with nothing that identifies you in the link. Turn off **Show suggested apps** in Settings > Integrations > Connected apps to hide every suggestion.

## On a server

Your browser talks only to your own Lifer server, which makes the connections above, except map tiles and online place search: the browser asks those providers itself. Everything you can change about them (download sources, the map, GPU use) is in [environment variables](./install/environment-variables.md), so a server can point them at your own mirrors.

## This website

The documentation site is hosted on GitHub Pages, which keeps its own access logs. It has no analytics or tracking.
