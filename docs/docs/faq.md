---
title: FAQ
description: Common questions about Lifer.
---

# Frequently asked questions

## Does Lifer upload my photos anywhere?

No. There's no Lifer cloud service. Your photos stay on your computer, your drives, or your own server. Species suggestions run on your own device. Lifer only goes online to download packs, models, the map, catalog updates and app updates, to load extra reference photos (with Small packs) and to look things up on iNaturalist when you use those features.

## Is this a sightings log?

No. A species is **collected** only when you've attached your own photo of it. You can **Mark as seen** species you've spotted but not photographed, to tell them apart from ones you've never met, and [import your eBird sightings](./guides/ebird-import.md) to do that in bulk. But the life list in Lifer is a photographic life list.

## What do the rarity tiers mean? Is "Legendary" endangered?

No. Tiers (Common, Occasional, Uncommon, Rare, Legendary) are about **how hard a species is to find and photograph** in a place: Common is seen anywhere, anytime; Occasional in the right habitat; Uncommon needs a dedicated search; Rare needs travel and patience; Legendary is once in a lifetime. A species' IUCN conservation status is shown separately. Where there's too little data, it shows **Unrated** (or **Not enough data here** on a region's checklist). Marine invertebrates and species added from iNaturalist aren't rated yet. See [Rarity tiers](./guides/collection-and-checklists.md#rarity-tiers).

## Which animals are covered?

Offline packs have full regional checklists and reference photos for:

- Birds, mammals and fish. The Fish packs also carry sharks, rays and marine mammals.
- Reptiles, turtles and amphibians.
- Marine invertebrates: corals, jellies and anemones, echinoderms, nudibranchs, shells and marine mollusks, cephalopods, and crustaceans.

Insects, plants, fungi and anything else on iNaturalist can be added too: search for one species at a time, or paste a whole list (for example a column copied from a spreadsheet) with **Import a list**. See [Add insects, plants, fungi and more](./guides/inaturalist.md#any-taxa).

## Should I use the desktop app or a server?

Use the desktop app if you use one computer and want the simplest setup. Use a server if your photos live on a NAS, you want to reach your archive from several devices, or you want share links and the API. You can start on the desktop and [move to a server](./install/connect-desktop-to-server.md#migrate) later. See [Desktop app or server?](./intro.md#desktop-app-or-server)

## Will Lifer rearrange my existing photo folders?

Only if you ask it to. Photos you import are copied into Lifer's library in species folders. Your originals elsewhere aren't touched. [Trips](./guides/trips.md) only read your trip folder, and copy the photos you import into a `Wildlife` folder inside it. [Importing an existing library](./guides/importing.md#existing-library) with organizing off references photos where they are and never moves them.

## Does Lifer change my files?

For photos it stores in its library, Lifer writes species keywords, a title and your rating into the file (or an `.xmp` sidecar for RAW files), so Lightroom, digiKam and Immich can read them. The image itself is never changed. See [What Lifer reads and writes](./guides/importing.md#what-lifer-reads-and-writes).

## What if I stop using Lifer?

Your photos are ordinary files in ordinary folders, with the species written into each one. Any photo app can read them. And a fresh Lifer install pointed at the same folder can rebuild your collection from them.

## Do I need to register an external drive?

Only for the desktop app, and only if you want Lifer to save photos to it or keep track of it when it's unplugged. Register it in [Settings > Storage](./settings.md#external-drives). See [Multiple drives](./guides/library-folders.md#drives).

## Does it work offline?

Yes. Once you've downloaded packs, and optionally the models and the map, everything works without internet.

## Can more than one person use a server?

A server has one account. Anyone you give the login to sees the same library. To show photos to others without giving them access, use [share links](./guides/albums-and-sharing.md#share-links).

## Can I share from the desktop app?

Share links need a server, because they need an address other people can reach. [Connect the desktop app to a server](./install/connect-desktop-to-server.md) to use them.

## How do I undo hiding or archiving a species?

Open **Settings > Library** and choose **Hidden species** or **Archived species**. See [Undoing hide and archive](./guides/collection-and-checklists.md#undoing-hide-and-archive).

## Can I script Lifer or connect it to Home Assistant?

Yes, on a server. Create an API key in **Settings > Account > API keys > Manage API keys** and see the [API overview](./api/overview.md) for the endpoints and permissions.

## Can I use Lifer with Immich, Lightroom or digiKam?

Yes, and no API is needed. Point the other app at the folder where Lifer stores your photos (in Immich, add it as an external library). Lifer writes each photo's species into the file as keywords, with a `Species|<group>|<family>|<name>` hierarchy, plus its star rating, so those apps pick them up from the files. See [Keyword matching from photo tags](./guides/importing.md#keyword-matching). Keep making species changes in Lifer, since it rewrites those keywords when a photo's species changes.

## Is there a Windows, Linux or Intel Mac version?

There's a Windows installer, and Linux builds as a `.deb` and an AppImage. Macs are Apple Silicon only for now. See [Install the desktop app](./install/desktop.md).

## What file types and sizes can I import?

Photos in JPEG, PNG, WebP, TIFF and HEIC, RAW files from all the major camera brands, and MP4 and MOV videos. There's no size limit: big RAWs, long videos and gigapixel panoramas all work, and uploads pick up where they left off if your connection drops. See [Supported files](./guides/importing.md#supported-files).

## How much disk space does Lifer need?

Besides your photos: packs vary by country and whether you choose Full or Small (sizes are shown before downloading), the species-matching models are about 620 MB, and the offline map about 550 MB. A server with an NVIDIA GPU also downloads about 2.7 GB for [GPU acceleration](./install/hardware-acceleration.md#nvidia-downloads).

## Does Lifer use my graphics card?

Yes, when it helps. Lifer tests your GPU once and moves species matching onto it if it gives the same results as the CPU and is faster. On a Mac or Windows there's nothing to do. On a Docker or TrueNAS server, pass the GPU into the container. See [GPU acceleration](./install/hardware-acceleration.md).
