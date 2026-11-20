---
title: Regions and the map
description: Download regions so checklists and reference photos work offline, keep them updated, and add the offline map.
---

# Regions and the map

A **region download** is everything Lifer needs for one animal group in one country or ocean area: its species checklist (which species occur there and how often), reference photos, descriptions and habitat info. Once downloaded, it works fully offline.

Regions can be downloaded for these animal groups:

- **Birds**, **Mammals** and **Fish**.
- **Reptiles & Amphibians**: **Reptiles**, **Turtles** and **Amphibians**.
- **Marine Invertebrates**: **Corals**, **Jellies & Anemones**, **Echinoderms**, **Nudibranchs**, **Shells & Marine Mollusks**, **Cephalopods** and **Crustaceans**.

Sharks, rays and marine mammals like whales, dolphins and seals are included in the **Fish** download. Sponges and tunicates aren't covered yet. See [What the checklists cover](./collection-and-checklists.md#groups).

A country only offers the groups it actually has, so a landlocked country has no corals to download. Insects, plants, fungi and other groups can't be downloaded by region. Add those from [iNaturalist](./inaturalist.md#any-taxa).

![Species downloads in Settings](/img/offline-packs.jpg)

Open **Settings > Species and import** and click **Download more countries and animal groups** at the top, click a **Download** button on the Collection page, or search for "Species downloads" in [quick search](./gallery-and-search.md#quick-search). To add animal groups for the countries you're already looking at, use **+ Add species > Download animal groups** on the Collection. See [Add more groups from the Collection](./collection-and-checklists.md#add-groups).

## Download regions {#download-packs}

1. Choose one or more countries: click them on the map, click a continent to list its countries (the map moves to show it), or type in **Search for a country…**. Each continent has **Select all**. Selecting a country with overseas territories also lists its **Territories**, which you can add too.
2. Under **Choose animal groups**, pick only the groups you want, for example **Birds** and **Nudibranchs**. **Reptiles & Amphibians** and **Marine Invertebrates** open up to show each group inside, and each has **Select all**. **Download selected** stays off until you pick at least one group.
3. At the bottom, choose a size:
   - **Full** bundles every reference photo, fully usable offline.
   - **Small** includes only the featured photo per species. Extra photos load when you're online.
4. Check the size shown, then click **Download selected**.

The download runs in the background, with its progress at the bottom of the window wherever you are in Lifer. One bar shows what is downloading (the region files, then their photos), with the time left once Lifer can measure it. A region set up meanwhile shows as a note under it. Once nothing is left to download, the bar reads **Setting up on this computer**, which doesn't use the internet. Each region is ready to use as soon as it's set up, without waiting for the rest.

**Cancel** offers two choices: **Stop downloading, finish setting up** keeps the regions already downloaded and sets them up, and **Stop everything** stops at once. Regions that finished before you cancel are kept either way.

While a download runs, you can keep picking countries and animal groups: the button reads **Add to queue** and adds them to the end of the running download, each with the Full or Small choice you made when you added it. Cancel stops the current region and clears everything still waiting in the queue.

Some species come without a photo because none of their iNaturalist photos may be shared in a region download (the photographer kept all rights). Once the regions are in, Lifer fetches those species' main photos from iNaturalist in the background, a few at a time, for your own viewing. You can turn this off in [Settings > Species and import > Species downloads](../settings.md#withheld-photos).

A coastal country's download may also bring in the nearby [ocean areas](./collection-and-checklists.md#sea-zones) it needs. Ocean areas currently hold ocean fish.

In the continent lists, countries you've downloaded are highlighted. A small dot means it's only partly downloaded: some groups are missing, or an update is waiting.

## Keep regions up to date {#keep-packs-up-to-date}

When a downloaded region's checklist data changes, Lifer shows "update available" next to it, and a banner offers **Update all regions**. Updating refreshes which species occur there and how often.

The **Downloaded** list in **Species downloads** lets you:

- **Update** one region, or **Update all**.
- **Get full version** of a Small download.
- **Provinces** (or states, and so on): tick or untick the provinces to keep. Unticking one removes it from that region's checklists. Ticking it again brings it back.
- **Remove** a region, or **Remove selected**, to free space.

## Removing a region {#offloading-a-pack}

Removing a downloaded region deletes its reference photos and checklist data. Lifer first shows how much space you'll get back and how many regions' checklists will need downloading again. **Your own photos are never touched**. Species you photographed, or that another downloaded region still covers, keep their reference photos.

## Species you added {#added-species}

Species you added from iNaturalist, one at a time or by importing a list, aren't part of a region download, but their reference photos still take space. The **Downloaded** list shows them under their country next to its downloaded groups, marked **Added by you**: for example **Insects** under **Canada**, with its size. **Remove** takes that group off the country's lists and deletes their reference photos. Species you have photos of stay, and so does a species on another country's list. They don't come back from the region picker: to get them back, add them again, for example by importing the list again. See [iNaturalist](./inaturalist.md).

## After a reinstall

If you [reimport your library](../settings.md#reimport) and some recovered species are missing reference photos or descriptions, the result links to **see which regions would restore them**. **Species downloads** then lists those regions with their sizes. Click **Select these regions**, then **Download selected**.

## Species catalog updates

Separately from downloaded regions, Lifer's species catalog (rarity, occurrence statistics and endemic labels for every species) gets occasional updates. Check in [Settings > Offline data > Species catalog](../settings.md#species-catalog).

## The offline map {#offline-map}

Maps in Lifer, like **Where to find it** on species pages and the map on this page, come from an offline world map you download once (about 640 MB). It includes shaded relief and terrain for 3D views. Without it, maps don't show, even when you're online. Everything else works the same.

1. Open **Settings > Species and import > Species downloads**.
2. In **Offline map**, click **Download** (about 640 MB).

Until it's downloaded, the region picker says "The offline world map isn't downloaded yet". You can still choose countries with the search box.

On a server, the **Offline map** row only appears once the administrator turns it on with [`MAP_DOWNLOAD_URL`](../install/environment-variables.md#download-sources).

To free the space, click **Remove** in the same row. You can download it again any time.
