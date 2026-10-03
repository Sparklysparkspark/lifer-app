---
title: Offline packs and the map
description: Download region packs so checklists and reference photos work offline, keep them updated, and add the offline map.
---

# Offline packs and the map

A **pack** is everything Lifer needs for one animal group in one country or sea zone: its species checklist (which species occur there and how often), reference photos, descriptions and habitat info. Once downloaded, it works fully offline.

Packs are available for:

- **Birds**, **Mammals** and **Fish**.
- **Reptiles & Amphibians**: **Reptiles**, **Turtles** and **Amphibians**.
- **Marine Invertebrates**: **Corals**, **Jellies & Anemones**, **Echinoderms**, **Nudibranchs**, **Shells & Marine Mollusks**, **Cephalopods** and **Crustaceans**.

Sharks, rays and marine mammals like whales, dolphins and seals are included in the **Fish** packs. Sponges and tunicates aren't covered yet. See [What the checklists cover](./collection-and-checklists.md#groups).

A country only offers the groups it actually has, so a landlocked country has no coral pack. Insects, plants, fungi and other groups don't come in packs. Add those from [iNaturalist](./inaturalist.md#any-taxa).

![The Offline Packs page](/img/offline-packs.jpg)

Open **Settings > Library > Offline packs**, click a **Download** button on the Collection page, or search for "Offline packs" in [quick search](./gallery-and-search.md#quick-search).

## Download packs

1. Choose one or more countries: click them on the map, click a continent to list its countries, or type in **Search for a country…**. Each continent has **Select all**. Selecting a country with overseas territories also lists its **Territories**, which you can add too.
2. Optionally, under **Choose taxon groups**, pick only the groups you want, for example **Birds** and **Nudibranchs**. **Reptiles & Amphibians** and **Marine Invertebrates** open up to show each group inside, and each has **Select all**. With none picked, you get every group.
3. At the bottom, choose a size:
   - **Full** bundles every reference photo, fully usable offline.
   - **Small** includes only the featured photo per species. Extra photos load when you're online.
4. Check the size shown, then click **Download selected**.

The download runs in the background with a progress bar and a cancel button. Packs that finished before you cancel are kept.

A coastal country's pack may also bring in the nearby [sea zones](./collection-and-checklists.md#sea-zones) it needs. Sea zones currently hold ocean fish.

In the continent lists, countries you've downloaded are highlighted. A small dot means it's only partly downloaded: some groups are missing, or an update is waiting.

## Keep packs up to date

When a pack's checklist data changes, Lifer shows "update available" next to it, and a banner offers **Update all packs**. Updating refreshes which species occur there and how often.

The **Downloaded** list on the Offline Packs page (also in **Settings > Offline data > Downloaded packs**) lets you:

- **Update** one pack, or **Update all**.
- **Get full version** of a Small pack.
- **Provinces** (or states, and so on): tick or untick the provinces to keep. Unticking one removes it from that pack's checklists. Ticking it again brings it back.
- **Offload** a pack, or **Offload selected**, to free space.

## Offloading a pack

Offloading removes the pack's reference photos and checklist data. Lifer first shows how much space you'll get back and how many regions' checklists will need downloading again. **Your own photos are never touched**. Species you photographed, or that another downloaded pack still covers, keep their reference photos.

## After a reinstall

If you [reimport your library](../settings.md#reimport) and some recovered species are missing reference photos or descriptions, the result links to **see which packs would restore them**. The Offline Packs page then lists those packs with their sizes. Click **Select these regions**, then **Download selected**.

## Species catalog updates

Separately from packs, Lifer's species catalog (rarity tiers, occurrence statistics and endemic labels for every species) gets occasional updates. Check in [Settings > Offline data > Species catalog updates](../settings.md#species-catalog).

## The offline map {#offline-map}

Maps in Lifer, like **Where to find it** on species pages and the map on this page, come from an offline world map you download once (about 550 MB). Without it, maps don't show, even when you're online. Everything else works the same.

1. Open **Settings > Offline data**.
2. In **Offline map**, click **Download offline map (~550 MB)**.

Until it's downloaded, the Offline Packs page says "The offline world map isn't downloaded yet". You can still choose countries with the search box.

On a server, the Offline map card only appears once the administrator turns it on with [`MAP_DOWNLOAD_URL`](../install/environment-variables.md#download-sources).

To free the space, click **Offload** on the same card. You can download it again any time.
