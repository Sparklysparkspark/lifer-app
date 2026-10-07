---
title: Privacy
description: What Lifer sends over the network, to whom, and why. Lifer has no telemetry and no Lifer-hosted service.
---

# Privacy

Lifer has **no telemetry, no analytics, no ads and no Lifer-run service**. Nothing about you or your library is sent to the Lifer project, because there's no Lifer server to send it to. Your photos and your database stay on the drives and server you choose.

Lifer does download public data from a few services, and some features talk to them directly. Each one sees your IP address and what was asked for, like any website you visit. This page lists every connection Lifer makes.

## Downloads of Lifer's data and updates: GitHub

Lifer's own data and updates are published as GitHub releases of [the Lifer repository](https://github.com/Sparklysparkspark/lifer-app):

- **The species catalog** (`catalog-latest`), the first time Lifer starts and when you update the catalog.
- **Offline packs and their photos** (`packs-latest`, `photos-latest`), when you download a pack.
- **The offline map** (`map-latest`), only if you download it.
- **Species-matching models** (`models`), only if you turn species matching on.
- **Update checks:** the desktop app checks for a new version, and the web app's update banner asks GitHub for the latest release.

Only the file being downloaded is requested; nothing about your library is sent.

## Species matching on a GPU

Only if species matching is on and Lifer finds a GPU it can use:

- The full-precision photo model comes from **Hugging Face** (huggingface.co).
- GPU runtime libraries come from the **npm registry**, **PyPI** or **NuGet**, depending on your system.

Matching itself always runs on your own computer or server. Your photos are never sent anywhere to be identified. `LIFER_GPU=off` keeps matching on the CPU and skips these downloads.

## Species information and photos: iNaturalist, GBIF and Wikimedia

To fill in species details Lifer doesn't have yet, it looks species and places up by name:

- **iNaturalist** (api.inaturalist.org, with photos from inaturalist-open-data.s3.amazonaws.com and static.inaturalist.org): reference photos and descriptions when you open a species, the main photo of species in your downloaded packs whose photos couldn't be included for licensing reasons ([turn this off](./settings.md#withheld-photos)), and the matching iNaturalist place for a region.
- **GBIF** (api.gbif.org): taxonomy and occurrence counts for species and regions that aren't covered by your packs.
- **Wikimedia Commons** (upload.wikimedia.org): some reference photos.
- **GitHub** (raw.githubusercontent.com): country and province outlines from Natural Earth, when a region outside your packs is first shown.

What's sent is the species or place being looked up, never your photos or your library.

## Only when you choose to

- **Sending observations to iNaturalist:** if you link your iNaturalist account and send photos as observations, the photos, dates, locations and species you choose are sent to iNaturalist under your account. Nothing is sent until you do.
- **eBird import:** Lifer never connects to eBird. You export your data from eBird yourself and import the file.
- **Share links** (servers only): a share link shows exactly the album or trip you shared, to whoever has the link, until you delete it.

## On a server

Your browser talks only to your own Lifer server; the server makes the connections above. Everything you can change about them (download sources, the map, GPU use) is in [environment variables](./install/environment-variables.md), so a server can point them at your own mirrors.

## This website

The documentation site is hosted on GitHub Pages, which keeps its own access logs. It has no analytics or tracking.
