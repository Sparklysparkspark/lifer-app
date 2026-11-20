---
title: Import from eBird
description: Mark every bird you've logged on eBird as seen in Lifer.
---

# Import from eBird

If you log sightings on eBird, you can bring them into Lifer so every bird you've seen, but not photographed yet, shows as **seen** instead of unseen.

## Steps

1. On eBird, go to [Download My Data](https://ebird.org/downloadMyData) and request your data. eBird emails you a link to a `.zip` file.
2. Unzip it. Inside is `MyEBirdData.csv`.
3. In Lifer, open **Settings > Species and import**. The **Add a species** window on a region's Collection page also links here.
4. In **Import from eBird**, click **Choose file** and pick `MyEBirdData.csv`.

When it's done, Lifer shows a summary, for example "812 species in the file: 340 newly seen, 458 already seen or photographed, 14 not matched", followed by the names that didn't match.

## Undoing an import {#undo}

Right after an import, click **Undo this import** under the summary. It removes only the seen marks that import added. Species you had marked seen before, and species you've photographed since, stay as they are. The button goes away once you leave the page or import another file.

## What it does

- Every species in the file whose scientific name exactly matches a Lifer species is marked **seen**. Each species counts once, however many checklists it's on.
- Species you've already photographed stay **photographed**. Nothing is ever downgraded.
- Species already marked seen are left as they are.

It doesn't import dates, locations, checklists or photos, and it doesn't create trips. It's safe to run again whenever you download a fresh copy of your data.

## Unmatched species

The summary lists any names that didn't match. A few usually don't, because eBird and Lifer use different names for a recently split or renamed species, or because the entry is a hybrid, a "sp." or a domestic form. Mark those by hand with **Mark as seen** on the species card if you need them, or add a missing one with **+ Add a species** on the region's Collection page.

The file must have eBird's **Scientific Name** column, or Lifer says so. Other columns are ignored. If you edited the file in a spreadsheet, save it as CSV again with the original column names.
