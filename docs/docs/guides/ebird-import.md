---
title: Import from eBird
description: Mark every bird you've logged on eBird as seen in Lifer.
---

# Import from eBird

If you log sightings on eBird, you can bring them into Lifer so every bird you've seen, but not photographed yet, shows as **seen** instead of unseen.

## Steps

1. On eBird, go to [Download My Data](https://ebird.org/downloadMyData) and request your data. eBird emails you a link to a `.zip` file.
2. Unzip it. Inside is `MyEBirdData.csv`.
3. In Lifer, open **Settings > Species and import**.
4. In **Import eBird checklist data**, click **Choose CSV file…** and pick `MyEBirdData.csv`.

When it's done, Lifer shows a summary, for example "812 species in file · 798 matched · newly seen: 340 · already seen/collected: 458 · unmatched: 14".

## What it does

- Every species in the file whose scientific name exactly matches a Lifer species is marked **seen**. Each species counts once, however many checklists it's on.
- Species you've already photographed stay **collected**. Nothing is ever downgraded.
- Species already marked seen are left as they are.

It doesn't import dates, locations, checklists or photos, and it doesn't create trips. It's safe to run again whenever you download a fresh copy of your data.

## Unmatched species

A few names may not match, usually because eBird and Lifer use different names for a recently split or renamed species, or because the entry is a hybrid, a "sp." or a domestic form. Mark those by hand with **Mark as seen** on the species card if you need them.

The file must have eBird's **Scientific Name** column, or Lifer says so. Other columns are ignored. If you edited the file in a spreadsheet, save it as CSV again with the original column names.
