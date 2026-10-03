---
title: Introduction
description: What Lifer is, the ideas it's built around, and how to choose between the desktop app and a server.
slug: /
---

# Lifer documentation

Lifer is a free, open-source photo archive and life list for wildlife photographers. It organizes your photos around **species**, and around where, when and on which trip you took them. Your life list and regional checklists fill in from the photos themselves.

![The Collection page, showing a region's checklist](/img/collection.jpg)

Your photos stay on your own drives. There is no Lifer cloud service and no account to sign up for.

:::tip New here?
1. [Install Lifer](./install/desktop.md) on your computer, or [on a server with Docker](./install/docker.md).
2. Follow [Getting started](./getting-started.md) for your first import.
:::

## Key ideas

### Species

Everything in Lifer hangs off a species. Each one has a common and scientific name, its place in the taxonomy, a reference photo, a description and habitat, a rarity tier, and a record of where it's found.

Offline packs come with full regional checklists for:

- **Birds**
- **Mammals**
- **Fish**. The Fish packs also include sharks, rays and marine mammals like whales, dolphins and seals.
- **Reptiles & Amphibians**: reptiles, turtles and amphibians
- **Marine invertebrates**: corals, jellies and anemones, echinoderms, nudibranchs, shells and marine mollusks, cephalopods, and crustaceans

Anything else on iNaturalist, like insects, spiders, plants and fungi, can be added too. Add species one at a time, or paste in a whole list at once. See [Add insects, plants, fungi and more](./guides/inaturalist.md#any-taxa).

### Photos

A photo in Lifer is one shot. It can have an edited photo (a JPEG, PNG, WebP, TIFF or HEIC), the matching RAW file, or both, and it can also be a video (MP4 or MOV). Each photo belongs to a species (it can list extra species too), and carries its date, location, camera details, rating and tags.

![The Lifer gallery](/img/gallery.jpg)

### Your collection means you photographed it

A species counts as **collected** only once you've attached your own photo of it. This isn't a sightings log. If you've seen something but haven't photographed it yet, click **Mark as seen** on its species page or card so it stands apart from species you've never encountered. You can also [import your eBird sightings](./guides/ebird-import.md) to mark everything you've seen at once.

### Life list

Your life list is every species you've collected. On the Collection page, the count under the Lifer logo ("X / Y collected") shows how many species you've photographed out of the checklist you're viewing. Pick a region or a group, like Birds, and the count follows it.

### Rarity tiers

A species' tier is **how hard it is to find and photograph** in the place you're looking at:

- **Common:** an everyday species, seen anywhere, anytime.
- **Occasional:** findable with a little effort in the right habitat.
- **Uncommon:** needs a dedicated search.
- **Rare:** needs travel and patience.
- **Legendary:** once in a lifetime.

A card's plain badge ("Rare") is the worldwide tier, where the species is easiest to find. On a region's checklist, a second badge ("Occasional here") is its tier in that region.

It isn't conservation status: an endangered but easy-to-see bird can be Common, and a widespread but secretive one can be Rare. The IUCN status is shown beside it. Where there's too little data to tell, a species shows **Unrated** (or **Not enough data here** on a region's checklist). Marine invertebrates and species added from iNaturalist aren't rated yet.

See [Collection and checklists](./guides/collection-and-checklists.md#rarity-tiers).

### Regions and checklists

A region is a country, a province or state, or a sea zone for fish. Its checklist is every species recorded there. You browse your collection by region and see what you still need. Checklists are meant to be personal: hide vagrants or archive species you aren't chasing.

### Offline packs

A pack holds a region's checklist, reference photos and descriptions. You download the packs you care about and they work fully offline from then on. See [Offline packs and the map](./guides/offline-packs-and-map.md).

## Desktop app or server?

Lifer runs two ways. Both have the same features, apart from the differences below.

| | Desktop app | Server |
|---|---|---|
| Where it runs | Your own computer: a Mac with Apple Silicon, Windows, or Linux (`.deb` or AppImage) | A NAS or always-on computer, using Docker |
| Who can reach it | Just you, on that computer | Anyone with the address and your login |
| Login | None | One account (email and password) per server |
| Where photos live | On your computer and any external drives | On the server's disks |
| Share links for albums | No | Yes |
| API keys for your own scripts | No | Yes |
| Install guide | [Desktop app](./install/desktop.md) | [Docker](./install/docker.md) |

The desktop app can also be a window onto a server you already run. Connected that way, it signs in to the server's account and gets the server's share links and API keys. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md). You can start on the desktop and move your library to a server later.

## Status

Lifer is in beta. It's actively developed, and some features may change before the first stable release. Bug reports and ideas are welcome on [GitHub Issues](https://github.com/Sparklysparkspark/lifer-app/issues).
