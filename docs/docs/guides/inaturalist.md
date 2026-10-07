---
title: iNaturalist
description: Add insects, plants, fungi and other species from iNaturalist, one at a time or as a pasted list. Sending sightings to iNaturalist is coming soon.
---

# iNaturalist

Lifer uses iNaturalist to add species outside its own checklists. Sending your sightings to iNaturalist as observations is coming soon.

## Add insects, plants, fungi and more {#any-taxa}

Lifer has its own checklists for birds, mammals, fish, reptiles, turtles, amphibians and many marine invertebrates (see [what the checklists cover](./collection-and-checklists.md#groups)). For anything else, like insects, spiders, plants or fungi, you can add species from iNaturalist, either one at a time or a whole list at once. You don't need an iNaturalist account.

### Turn it on

1. Open **Settings > Species and import**.
2. In **Any-taxa search**, tick **Enable any-taxa search**.
3. Click **Search iNaturalist for a species to add**. The **Search iNaturalist** window opens.

With the setting on, you can also open this window from [quick search](./gallery-and-search.md#quick-search): type a species Lifer doesn't have and choose **Search iNaturalist**.

The window has two tabs: **One species** and **Import a list**.

### Add one species

1. On **One species**, type a scientific or common name.
2. Click the right result. Each shows its photo, names and group.
3. Under **Which region should this appear under?**, pick a country, or a province or state inside one. World and the continents have no checklist of their own.
4. Click **Add species** (or press <kbd>Enter</kbd>). Lifer opens the new species' page.

### Import a list {#import-list}

Use this to add many species in one go, like every bee in your state, or a target list someone shared with you.

1. On **Import a list**, paste one entry per line. Each entry can be:
   - a scientific name (works best), like `Bombus impatiens`,
   - a common name, like `Monarch`, or
   - an iNaturalist taxon ID, like `48662`.
2. Under **Which region should these appear under?**, pick a country, or a province or state.
3. Click **Start import** (or press <kbd>Enter</kbd>).

There's no file upload, but a list from a spreadsheet or CSV works fine: copy the column of names and paste it into the box. Blank lines and repeated names are skipped.

The import runs in the background, one name at a time, with a progress bar. Click **Cancel** to stop it partway. The species added so far stay added. When it's done, Lifer reports how many were **added**, were **already on the list**, and were **not found**, and lists the names it couldn't find so you can fix and paste them again.

For each name, Lifer takes iNaturalist's top species match. Common names can be ambiguous, so use scientific names or taxon IDs when it matters. Only one list import can run at a time.

### Where they show up

The species appear on that region's Collection page, marked **Added by you**, and on the checklists of the regions that contain it (a species added to a province also shows on its country). They're your own [checklist additions](./collection-and-checklists.md#add-to-checklist): other people on the same server don't see them unless they add them too, and catalog updates and offline packs never remove them. Use the **Taxon** filter to show just one group, like **Insects** or **Plants**. Each has a photo and description from iNaturalist, but no rarity tiers or occurrence data. Its page shows IUCN status where iNaturalist has one.

Import photos of them as usual.

To add a species to another region, open its page, click **Add to another checklist**, pick the region and click **Add to** it. See [Adding a species to a checklist](./collection-and-checklists.md#add-to-checklist). To remove one you haven't photographed, use **Remove species** on its card's **⋯** menu or its page. This takes it off all your checklists, along with your seen, target and archive marks for it. On a server, anyone else who added it keeps it, and the species is deleted only once nobody has it any more.

## Sending observations to iNaturalist {#observations}

Coming soon, once Lifer's iNaturalist app is approved. You'll link your iNaturalist account, pick photos of one sighting and send them as an observation under your own account:

- **What's sent:** the photos, the species you filed them under, the date your camera recorded, and the region they're filed under as the place name. Coordinates are sent only when your camera recorded GPS. Lifer never guesses a location or a date.
- **Photos without GPS:** most cameras don't record it, so the observation arrives without a location and Lifer opens it on iNaturalist, where you place it with iNaturalist's map. Until then it stays Casual on iNaturalist.
- **Bringing the location back:** on the **Pending** tab, **Confirm complete** reads the location you placed and adds it to the photos in Lifer, marked as placed on iNaturalist. A location your camera recorded is never replaced.

Species suggestions from Lifer's matching are never sent on their own: the species on the observation is always the one you chose.
