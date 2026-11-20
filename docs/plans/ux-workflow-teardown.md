# UX teardown: the 10 core workflows

Each workflow was traced through the current app's screens, labels and code, as a first-time wildlife photographer would meet it. Each was judged on four questions: can they predict what to do, tell what happened, recover from a mistake, and do it without learning Lifer's own terms. Code reading only; nothing was run. Paths are under `apps/web/src` unless they say otherwise.

## Status

All 19 findings were fixed on 2026-10-19. Not done:
- **Next-best guesses in Correct the ID.** No endpoint suggests species for a photo already in the library.
- **Downloading with Select all.** "Download originals" covers only the selected photos already loaded on screen.
- **Undoing a hide.** When a hidden photo was the species card photo, Undo doesn't make it the card photo again.

## Ranked findings

Ranked by how many people hit it times how badly it hurts.

### Tier 1: fix first

1. **The first import can end on a "Welcome, choose regions" screen.** With two or more countries and no region picked, the import sends the user to the collection with no region, and the first-run check shows setup again. `pages/BulkImportPage.tsx:93`, `pages/collection/useFirstRunRegion.ts:21-30`. Fix: go to the batch's region, or the first downloaded country, and remember the onboarding country as the last region.
2. **The import's region starts empty, so there are no suggestions until the user finds the region picker.** `components/PhotoImportRows.tsx:186`, `:503`. Fix: start on the first onboarding country.
3. **"Undo last import" is unreachable in the usual case.** The page leaves for the collection as soon as uploading starts, and the undo list lives only on the import page. `pages/BulkImportPage.tsx:93`, `components/PhotoImportRows.tsx:390-392`. Fix: put Undo in the upload banner or toast.
4. **There's no way to hide a weak photo.** Only photos a culling app rejected are hidden, and those can only be unhidden; the user's only option is Delete. `apps/api/src/captures/hidden.ts` (unhide is the only write), `pages/gallery/GalleryTile.tsx:248-269`. Fix: a Hide action, one photo and in the select bar, with an Undo toast.
5. **Actions that make things vanish give no feedback or undo.** After Correct the ID the photo disappears, with no word on where it went (`pages/species/useCaptureEdits.ts:140-167`). Archive and Hide from this region remove the card silently, and getting it back is buried in Settings (`components/SpeciesCard.tsx:169-206`). Fix: one shared toast pattern, such as "Moved to Northern Pygmy-Owl", with View and Undo.

### Tier 2: high value

6. **Rating is hard to see and hard to find.** The 1-5 keys in the photo viewer change nothing visible (`components/Lightbox.tsx:355-357`). The Gallery hides stars by default and has no Rate in its menu (`pages/gallery/useGalleryDisplayPrefs.ts:11`). Trip photos can't be rated at all, though trips filter by Top rated (`pages/TripDetailPage.tsx:112-166`). Fix: show stars in the viewer, and give every photo menu the same Rate row, plus batch rating in select mode.
7. **"Best eagle shot" and "last spring" don't search the way people mean.** "Best" isn't read as rating, and "last spring" matches spring of any year. `apps/api/src/gallery/photoSearch.ts:572-582`, `:1054-1057`. Fix: read best/top/favourite as "rating first", and "last/this" before a season or month.
8. **Adding to targets shows nothing.** A target looks exactly like any other species still to find; seen species get a ✓, targets get nothing. `components/SpeciesCard.tsx:336`, `:363-369`. Fix: a small target badge.
9. **Provinces can't be searched until someone clicks "Show provinces/states".** Typing "British Columbia" in search finds nothing on a first visit. `apps/api/src/regions/routes.ts:168-209`, `components/CommandPalette.tsx:299-305`. Fix: create provinces when a country downloads.
10. **There's no way to get many photos out.** The select bar has no download, albums have no Download all, and Download original shows no progress and fails silently. `lib/downloadFile.ts:11-16`, `pages/gallery/GallerySelection.tsx:30-72`. Fix: a "Download originals" action in select mode, and a preparing/failed toast.
11. **A trip's first scan is hidden behind "Add more photos".** Creating a trip doesn't scan its folder. `pages/CollectionsPage.tsx:414`, `pages/TripDetailPage.tsx:291`. Fix: scan straight after Create trip.

### Tier 3: polish

12. **eBird import has no undo and doesn't list unmatched species,** and lives only in Settings (`apps/api/src/imports/routes.ts:45-55`, `pages/settings/EbirdImportRow.tsx:76-82`).
13. **The desktop app has no Share button, and nothing says why** (`pages/AlbumDetailPage.tsx:215-223`). Show it disabled with "Sharing needs a Lifer server".
14. **A species search with no results shows nothing,** with no hint about iNaturalist search (`components/SpeciesPicker.tsx:108-112`).
15. **"Featured" means a species card on one page and a trip cover on another** (`pages/species/CaptureMenu.tsx:55`, `pages/trip/TripPhotoGrid.tsx:144`). Say "Use as species card photo" and "Use as trip cover".
16. **Correcting an ID offers no guesses and isn't in the photo viewer** (`components/CaptureEditModal.tsx:75-89`, `components/Lightbox.tsx:33`).
17. **The region header's numbers aren't clickable.** "N of M photographed" should filter to photographed, and an "M−N to go" link should filter to not yet photographed (`pages/collection/RegionBreadcrumb.tsx:136-153`).
18. **Lifer's own words leak into the copy:** "checklist", "Drill in", "Archive", "Bulk import", "ask whoever runs this Lifer instance", and the Trips page's "referencing wildlife photos from an external folder".
19. **Small ones:** an empty Gallery points at species pages instead of Import photos. The import page always shows the separate RAW section. The trip page's "Gallery / Species view" names clash with the sidebar. Share links are revoked without a confirm, and a new link isn't copied for you.

## Decided

- The tour's import step now says to pick the right suggestion for each photo, instead of "tick them off", since the row's tick box only selects.

## Done well

- **Search feedback.** The Gallery shows how it read a search, and every empty state offers a one-click way out.
- **Plain filter wording.** "Not yet photographed", "Seen only" and "Likely this month" need no Lifer vocabulary.
- **Safety nets.** Duplicates and "doesn't look like wildlife" offer Remove or Import anyway. Deletes go to Trash for 7 days, and failed edits roll back on their own.
- **Showing concepts only when needed.** Rarity filters appear only when the list has rare species, and Introduced/Vagrants only inside a region.
- **Sharing is honest about privacy:** "Location data is never included in a shared link."

## Pattern behind most findings

Most problems are one missing piece: **feedback after an action, with undo.** One shared "did X, View, Undo" toast would close findings 3, 5, 8 and parts of 6, 10 and 12. The second pattern is **the same action working differently on different pages** (rating, featured, reveal in Finder). One shared photo menu would fix that.
