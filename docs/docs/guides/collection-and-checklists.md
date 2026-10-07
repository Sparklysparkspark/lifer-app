---
title: Collection and checklists
description: Browse regional checklists for birds, mammals, fish, reptiles, amphibians and marine life, track what you've photographed and seen, set targets, and hide or archive species.
---

# Collection and checklists

The Collection page is Lifer's home screen. It shows the species checklist for a region, with everything you've photographed in full color.

![The Collection page](/img/collection.jpg)

## What the checklists cover {#groups}

Lifer's checklists aren't just for birders. Each country's checklist is split into groups, and you download only the groups you care about from [Offline packs](./offline-packs-and-map.md):

| Group | What's in it |
|---|---|
| **Birds** | Every bird species |
| **Mammals** | Land mammals |
| **Fish** | Bony fish, plus nearby [sea zones](#sea-zones) for coastal regions |
| **Reptiles & Amphibians** | **Reptiles**, **Turtles** and **Amphibians**, each its own group |
| **Marine Invertebrates** | **Corals**, **Jellies & Anemones**, **Echinoderms**, **Nudibranchs**, **Shells & Marine Mollusks**, **Cephalopods** and **Crustaceans** |

Sharks, rays and marine mammals like whales, dolphins and seals are included in the **Fish** packs. Sponges and tunicates aren't covered yet. The Offline Packs page only offers the groups that have data for the countries you pick.

Marine invertebrates aren't given a [rarity tier](#rarity-tiers) yet, since there aren't enough records to rate them fairly. Their species page shows IUCN status instead, where it's known.

For anything else, like insects, spiders, plants or fungi, add species from iNaturalist. See [Insects, plants and other groups](#other-taxa).

## Choosing a region {#regions}

- With no region chosen, click **Browse by region →** or one of your downloaded countries.
- Once you're in a region, the breadcrumb at the top (**All species / World / continent / country**) takes you back out.
- **Drill in:** lists the provinces, states or other areas inside it. Some countries have a **Show provinces/states** button.
- World and continent views combine the checklists of the countries you've downloaded, marked "(downloaded countries only)".
- With the [offline map](./offline-packs-and-map.md#offline-map) downloaded, **Show map** / **Hide map** next to the breadcrumb shows the region's outline.

Lifer remembers the last region you viewed. Filters, sorting and grouping are part of the page address, so you can bookmark a view.

If a region's pack isn't downloaded, the page offers a button to **Download** it. Species you've photographed there, or [added to its checklist yourself](#add-to-checklist), still show below the button.

## Reading your progress

The top bar shows **X / Y collected** for the view you're looking at: the region, and any groups you've filtered to. Inside a region, a progress bar shows **N collected · N seen · N total** for that region. When the view includes birds, there's also a link to the region's **eBird Illustrated Checklist**.

When a filter hides some cards, the toolbar says **Showing N of M**.

Species cards look different depending on your status:

| Card | Meaning |
|---|---|
| Full color | **Collected**: you have your own photo of it |
| Grey with a ✓ | **Seen**: you've seen it but not photographed it yet |
| Dimmed | Not seen yet |

Archived and extinct species never count toward totals.

## Seen, targets, hide and archive {#card-actions}

Open a species card's **⋯** menu:

- **Mark as seen** / **Mark as unseen**: for species you've seen but not photographed. To mark all your birds at once, [import your eBird data](./ebird-import.md).
- **Add to targets** / **Remove from targets**: species you're going after. This works for collected species too, if you want a better photo.
- **Archive**: stops counting a species toward your to-collect total everywhere, for species you're not interested in.
- **Hide from this region**: takes a species off this region's checklist only, for example a one-off vagrant. In a province you can tick the province, **All of** the country, or both. Hiding it from a country also hides it from every province in that country. Its photos and its place on other checklists aren't affected.
- **Remove from this checklist**: only for species you added to this checklist yourself. See [Adding a species to a checklist](#add-to-checklist).
- **Remove species**: only for species you added from iNaturalist. See [Other groups](#other-taxa).

To archive a whole family at once, set **Group** to **Family group** and click **Archive group** on the family's heading.

You can't hide or archive species you've already collected.

### Undoing hide and archive

- **Settings > Library > Hidden species** lists everything you've hidden, by country and province. Click **Unhide**, or **Unhide all shown**.
- **Settings > Library > Archived species** lists archived species by family. Click **Unarchive**, or **Unarchive all** for a family. You can also click **Archived (unarchive)** on the species page.

## Adding a species to a checklist yourself {#add-to-checklist}

A checklist can miss a species you know is there, like an insect you imported by hand for one province that you also find in the next, or a sea turtle off a coast whose [sea zone](#sea-zones) lists only fish. You can add any species Lifer has to any country's, province's or sea zone's checklist.

**From the checklist:** open the region and click **+ Add a species** next to its totals. Search by name, then pick the species (or use the arrow keys and <kbd>Enter</kbd>). If you've ticked sea zones under **Include nearby water:**, choose under **Add it to** whether it goes on the region's checklist or one of the zones'.

**From the species page:** click **Add to another checklist**, then either:

- choose **Country or province**, and pick the country or the province or state, or
- choose **Sea zone**, and search for the zone by name.

Then click **Add to** it. World and the continents have no checklist of their own, so pick a region inside them.

A species you added:

- Shows on that checklist with an **Added by you** label, and counts toward its totals. One added to a province also shows on its country's checklist.
- Shows even if its group's pack isn't downloaded, or **Hide obscure species** would hide it, since you asked for it. On a region whose pack isn't downloaded yet, it shows below the **Download** button.
- On a sea zone, shows on a coastal region's checklist when that zone is ticked under **Include nearby water:**, like the zone's own fish. A zone you've added species to is offered there even without the region's fish pack. World and continent views combine countries' checklists only, so they don't include sea zone additions.
- Stays when you update the catalog or download, update or remove an offline pack.
- Is only on your own checklists. Other people on the same server don't see it.

Species you [import from iNaturalist](#other-taxa) work the same way: importing one adds it to the region you pick, marked **Added by you**.

Adding a species you'd hidden from that region also unhides it there.

To take one off again, open its card's **⋯** menu and click **Remove from this checklist**, or click **×** next to the checklist under **Added by you to:** on the species page. This only removes your addition: if the catalog lists the species there too, it stays. On the species page, a sea zone is marked **(sea)**, and its name opens a nearby region's checklist with just that zone ticked.

## Filters, sorting and grouping {#filters}

- **Search this area…** filters the cards by common name, scientific name, other names, or bird code.
- **Group:** **No grouping**, **Broad group** (like Raptors, Owls, Shorebirds, Snakes or Bats), **Family group**, **Rarity tier**, or (in a region) **Rarity here**.
- **Sort:** **Taxonomic** (the default), **Name**, **Rarity**, and in a region, **Rarity here** or **Most likely this month**.
- **Size** changes the card size.

**Filters** opens more options:

- **Taxon:** show only some groups, like Birds, Reptiles or Nudibranchs. Tick as many as you like. Only groups you've downloaded for this region are listed, plus a group for each kind of species you've added from iNaturalist (like Insects or Plants).
- **Collected first** (on by default), **Seen first** and **Targets first** pin those species to the top.
- **Show:** **All**, **Collected**, **Seen only**, **Targets**, or **Not yet collected** (species you haven't seen or photographed).
- **Likely this month:** only species that are regularly recorded in this region in the current month.
- **Found in year:** species you photographed in a particular year.
- **Hide labels**, **Hide names** and **Hide scientific names** for a cleaner view, or to quiz yourself.
- **Ghost only** and **Lost only** appear when the list has such species (see [badges](#badges)).

## Sea zones {#sea-zones}

For fish, a coastal region can include nearby sea zones: the named seas, gulfs, bays and straits of the International Hydrographic Organization's *Limits of Oceans and Seas*, such as the North Sea, the Gulf of Mexico or the Coral Sea. Where a coast faces open ocean, its zone is that country's part of the ocean instead, such as the Portuguese part of the North Atlantic Ocean or the Chilean part of the South Pacific Ocean. Under **Include nearby water:**, tick the zones you want, or **Select all**. Once a zone is ticked, untick **Include (region)'s own species** to see only the zone's fish.

- Sea zones only add fish, so the control shows when you're viewing all groups or Fish, once the region's fish pack is downloaded. It also shows whenever you've [added species](#add-to-checklist) to one of the zones yourself.
- If a region has no fish of its own, Lifer ticks its zones for you.
- A country pack may bring in the sea zones its fish checklist needs. You can also download zones from [Offline packs](./offline-packs-and-map.md).

## Rarity tiers {#rarity-tiers}

A tier is **how hard a species is to find and photograph** in a place. There are five:

| Tier | What it means |
|---|---|
| **Common** | An everyday species, seen anywhere, anytime (House Sparrows, Mallards, crows). |
| **Occasional** | Findable with a little effort in the right habitat (an Osprey over a lake, a Great Blue Heron in a marsh). |
| **Uncommon** | Needs a dedicated search. It won't turn up on a casual outing. |
| **Rare** | Needs travel and patience. Getting a shot is a notable achievement. |
| **Legendary** | Once in a lifetime: very local or extremely elusive (a Wolverine, a vagrant far from home). |

**Common** is kept tight on purpose, to genuine everyday species, so each tier means something in the field instead of most species piling up at the easy end.

### Tiers here and worldwide

A species card can show two tiers:

- **The plain badge** ("Rare") is the **worldwide** tier: how hard the species is where it's easiest to find, one step harder when its whole range is tiny.
- **The "here" badge** ("Occasional here") is its tier **in the region you're viewing**. It only appears on a region's checklist. **Rarity here** in Group and Sort uses it.

A bird that's Common worldwide can be Rare here at the edge of its range.

### How a tier is worked out

- In each province or state, a species is compared with the most-reported species of its group there (the average of the top five). Birds are rated on eBird and GBIF sightings; mammals, reptiles, amphibians and fish on iNaturalist research-grade photos, with an allowance for famous animals people photograph far more often than they find them (a Jaguar). Reported about half as often as the top species or more is Common; the other tiers follow at about 1 in 12, 1 in 50 and 1 in 330.
- The same species can differ from place to place. Great Blue Herons are Common in Florida, where they stand on every pond, and Occasional in most other states.
- A **country's** tier is its easiest well-surveyed province: where you'd go to find it.
- A **vagrant** (records bunched into a year or two, far from its usual range) is Legendary there, with a **Vagrant here** badge. An **introduced** species with an established population is rated like any other, with an **Introduced here** badge.
- Tap a tier badge to see the numbers behind it. Under **Your own tier** you can set a different tier if you know better; the card then shows "(yours)".

### What a tier isn't

- **Not conservation status.** An endangered wader can be on every mudflat, and a species of no concern can be Legendary if it lives in one hard-to-reach spot. The IUCN status is shown beside the tier.
- **Not a guess.** Where there are too few records or photos to tell, the species shows **Unrated**, or **Not enough data here** on a region's checklist.
- **Marine invertebrates** and species added from iNaturalist aren't rated yet. Their pages show IUCN status instead, where known.

Tiers are refreshed with [catalog updates](../settings.md#species-catalog).

## Badges {#badges}

On species cards:

| Badge | Meaning |
|---|---|
| **Endemic** | Only ever recorded in one country |
| **Vagrant** | Records here are concentrated in very few years, so it's an irregular visitor |
| **Ghost** | Rarely documented anywhere, but still out there to find |
| **Lost** | Not recorded anywhere in over 25 years |
| **Rediscovered** | Was a Ghost or Lost species when you photographed it, but isn't any more |
| **Added by you** | You added it to this checklist yourself. See [Adding a species to a checklist](#add-to-checklist) |

Species pages can also show **Invasive here**: an established population in this region that's non-native and considered invasive.

## Obscure species

By default, Lifer hides species almost nobody will encounter from checklists:

- Fish that live deeper than recreational diving depth (60 m). Turn on [Technical diving](../settings.md#technical-diving) to use 120 m instead.
- Species with almost no records.
- Species marked **Vagrant** in the region you're viewing.

Turn this off in [Settings > Species and import](../settings.md#obscure-species). Anything you've collected or seen always stays visible.

## Species pages {#species-page}

Click any card to open its page. It shows:

- Your featured photo, or the reference photo, with arrows to step through reference photos.
- Tier and badges, a description (from Wikipedia) and habitat, and facts that depend on the group, like mass and wingspan for birds, home range for mammals, depth range for fish, and IUCN status.
- A summary of your photos: how many photos, videos, encounters, locations, cameras and lenses, and when you first photographed it.
- **Observations by month** and **by week** charts for the region, and **Where to find it**, a map of hotspots (needs the [offline map](./offline-packs-and-map.md#offline-map)). For widespread species it says so instead, with a link to recent sightings on iNaturalist.
- Links to the species on iNaturalist and eBird (birds only).
- **Your photos**, with **Size**, **Gallery view** (just the photos, no ratings or camera info), **Sort** (**Newest first**, **Oldest first**, **Highest rated first**), filters for **All**, **Edited**, **RAW** and **Video**, and **Upload** to add more.

Header links let you **Mark as seen**, **Add to targets**, **Archive**, **Add to another checklist** (see [Adding a species to a checklist](#add-to-checklist)), and **Adjust card preview** (the crop used on the species card, once you have a featured photo).

Each photo's **⋯** menu has **Rate**, **Set as featured photo** (the species' cover), **Add to album…**, **Download original**, **Download RAW**, **Also features another species…**, **Correct the ID…**, **Set location…**, **Edit tags…** and **Delete photo**. On the desktop app it also has **Reveal in Finder** for photos kept in your own folders, and **Copy original's path**.

To change many photos at once, click **Select**, then click photos (<kbd>Shift</kbd>-click selects a range). The toolbar has **Correct ID to:**, **Add tag:** and **Delete selected**.

## Insects, plants and other groups {#other-taxa}

For groups Lifer has no checklists for, like insects, spiders, plants and fungi, you can add species from iNaturalist, one at a time or a whole list at once.

1. Turn on [Any-taxa search](../settings.md#any-taxa-search) in **Settings > Species and import**.
2. Click **Search iNaturalist for a species to add**. (With the setting on, quick search also offers **Search iNaturalist** when you type a species Lifer doesn't have.)
3. Choose **One species** to search and add a single species, or **Import a list** to paste many names at once, then pick a country, or a province or state.

See [iNaturalist](./inaturalist.md#any-taxa) for the details.

These species appear on that region's checklist marked **Added by you** (and on the checklists of the regions that contain it, like the country for a province). They're yours: other people on the same server don't see them unless they add them too. To put one on another region's checklist too, open its species page and click **Add to another checklist** (see [Adding a species to a checklist](#add-to-checklist)). Filter to them with their group in **Taxon**, like **Insects**. They have a photo and description from iNaturalist, but no tiers or occurrence data.
