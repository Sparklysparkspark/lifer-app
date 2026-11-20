# One photo grid, one photo menu

The Gallery, species page, album, trip and Trash showed photos with the same tile (`PhotoTile`) and layout (`MasonryGrid`, `justifyRows.ts`), but each built its own grid wrapper and its own per-photo menu. The menus had drifted: different items, order, wording, widths and download behaviour. This note records the audit and the shared pieces that replace the copies.

Rule: one photo grid, one photo menu (ux-rules C10, C11).

## Audit (2026-11-04, before)

### Menu items

Order is the position in that page's menu. "No" means the item was missing.

| Item                               | Gallery (`GalleryTileMenu`) | Species (`CaptureMenu`)                       | Album (`AlbumPhotoGrid`)       | Trip (`TripPhotoMenu`)                |
| ---------------------------------- | --------------------------- | --------------------------------------------- | ------------------------------ | ------------------------------------- |
| Rate (star group)                  | 1                           | 1                                             | no (caption stars only)        | 1                                     |
| View species                       | 2                           | no (on that species)                          | 1                              | 2                                     |
| Similar photos                     | 3                           | no                                            | no                             | no                                    |
| Use as species card photo          | 4 (`toggleFeatured`)        | 2 (`setCover`, same API)                      | no                             | no                                    |
| Page cover                         | n/a                         | n/a                                           | 2 Set as album cover, 3 Adjust | 3 trip cover, 4 Cover style, 5 Adjust |
| Add to album                       | 5                           | 3                                             | no                             | no                                    |
| Edit tags                          | 6                           | 13                                            | no                             | no                                    |
| Correct the ID                     | 7                           | 11                                            | no                             | no                                    |
| Also features another species      | no                          | 10                                            | no                             | no                                    |
| Set location                       | no                          | 12                                            | no                             | no                                    |
| Original unavailable note          | no (no data)                | replaces 4 to 9                               | no                             | no                                    |
| Download original                  | 8, with toast               | 4, with toast                                 | 4, with toast                  | 6, no toast (`downloadFile`)          |
| Download RAW                       | 9                           | 5                                             | 5                              | 7                                     |
| Reveal in Finder / Copy path       | 10                          | 6                                             | 6                              | 8                                     |
| Copy original's path (linked file) | no                          | 8                                             | no                             | no                                    |
| Open in editors                    | 11                          | no                                            | no                             | no                                    |
| iNaturalist                        | 12 Send, or View once sent  | 7 View only, hidden when original unavailable | 7 View only                    | 9 View only                           |
| Hide                               | 13                          | 14                                            | no                             | no                                    |
| Remove / Exclude from album        | n/a                         | n/a                                           | 8 (danger)                     | n/a                                   |
| Delete                             | 14                          | 15                                            | no                             | 10                                    |
| Right-click menu                   | yes                         | no                                            | no                             | no                                    |
| Width                              | `w-56`                      | `w-64`, scrolls at 70vh                       | `w-44`                         | content width (`whitespace-nowrap`)   |

### Keys

- Gallery and album: `photoMenu.*`.
- Species: `species.captureMenu.*`, a full duplicate set (rate, addToAlbum, downloadOriginal, downloadRaw, editTags, reassign, hide, delete, useAsCover, stopCover) plus its own (copyPath, tagSpecies, location, setLocation, connectVolume, originalUnavailable). `useRevealOriginal` borrowed `species.captureMenu.copyPath`.
- Trip: `species.captureMenu.rate`, `downloadOriginal`, `downloadRaw` from the species set, plus `trips.photoMenu.viewSpecies` and `deletePhoto` duplicating `photoMenu.*`.
- Album cover: `albums.photos.*`; smart album exclude: `albums.smart.exclude`; selection bars: `gallery.select.*`, `species.selection.*`, `albums.photos.selected`, `trash.*`.

### Grid wrappers and selection

| Page    | Wrapper                                                  | Selection                                               | Menu state                                                        | Loading tiles                         |
| ------- | -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| Gallery | `GalleryGrid` + memoized `GalleryTile`, groups           | `useSelectMode`: Shift range, drag select               | `useDropdownMenu` keyed by photo id, page-held right-click anchor | none (load-more sentinel on the page) |
| Species | inline `MasonryGrid` in `SpeciesPhotoGrid`               | `useSelectMode`                                         | `useDropdownMenu` keyed by capture id                             | uploads, after the photos, 3:2        |
| Album   | `AlbumPhotoGrid`                                         | `useSelectMode`                                         | `useDropdownMenu` keyed by photo id                               | none                                  |
| Trip    | `TripPhotoGrid`                                          | `useTripEdits` set: click toggles one, no range or drag | `useDropdownMenu` keyed by capture id                             | imports, before the photos, 4:3       |
| Trash   | its own tile (button, ProgressiveImg, SelectMark, ring)  | `useSelectMode` wired by hand to mouse events           | hand-written outside-click and Escape effects                     | none                                  |
| Share   | inline `MasonryGrid`, public, no select or menu          | none                                                    | none                                                              | none                                  |
| Map     | `MapPhotoPanel`, `NeedsPlacingTray` use `PhotoTile` only | their own                                               | their own                                                         | n/a                                   |

## What is shared now

- `components/PhotoMenu.tsx`: the one per-photo menu. Fixed order: Rate, View species, Similar photos, Use as species card photo, the page's cover items, Add to album, Edit tags, Correct the ID, Also features another species, Location, then the files (Download original, Download RAW, Reveal, Copy path, Open in), iNaturalist (Send, or View once sent; only when connected), a separator, Hide, the page's removal item, Delete. A page offers an action by passing its handler; items without a handler or data are absent, never disabled. Slots: `coverItems`, `endItems`. One key set, `photoMenu.*`. Sized to its longest item (`w-max`, 224 to 320px), scrolls at 70vh.
- `components/PhotoGrid.tsx`: MasonryGrid (justified, windowed), memoized tiles, PhotoTile with its SelectedRing and SelectMark, the ⋯ and right-click menu (it owns the anchor), loading tiles (`pending`), groups and an empty slot. Pages pass items, `idFor`, `tileFor`, selection, menu state, `renderMenu` and `renderLabel`.
- `PhotoTile` takes `photoId: null` for an item whose file is gone (Trash). Existing props unchanged.

| Page    | Grid                | Menu                                                               | Kept on the page                                                  |
| ------- | ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Gallery | PhotoGrid (groups)  | PhotoMenu via `GalleryPhotoMenu`; `HiddenTileMenu` for Hidden view | captions with the missing-date field, selection bar, edit dialogs |
| Species | PhotoGrid (pending) | PhotoMenu                                                          | best-shot badge, unavailable dot, filters, dialogs                |
| Album   | PhotoGrid           | PhotoMenu + album cover items + remove or exclude                  | remove-selected bar, quad cover picking                           |
| Trip    | PhotoGrid (pending) | PhotoMenu + trip cover, cover style, adjust position               | batch delete, remove from trip                                    |
| Trash   | PhotoGrid           | its own Restore menu (a trashed photo has no other actions)        | labels, Restore selected bar                                      |

## What stayed separate, and why

- **Selection bars** (Gallery, species, album, Trash) are page specific: their batch actions differ. Not merged.
- **Hidden view and Trash menus** are different menus (Unhide, Restore), not the photo menu.
- **Share page**: public, no select or menu, different data. Not cheap to move; left.
- **Map panel and tray** belong to the map work; PhotoTile's props stayed compatible.
- **AlbumExclusionsModal** uses PhotoTile in a small picker; not in this pass.

## Visible changes, for the maintainer to approve

Menus:

1. Species: order now matches the Gallery (edits before files; Edit tags before Correct the ID; iNaturalist after the file items). Gains Similar photos, Open in editors, Send to iNaturalist (was View only). View on iNaturalist stays when the original is unavailable (was hidden with the files).
2. Album: gains Rate, Similar photos, Add to album, Copy original's path, Open in editors, Send to iNaturalist. Cover items moved below Similar photos.
3. Trip: gains Similar photos, Add to album, Open in editors, Send to iNaturalist. Downloads now show the progress toast like everywhere else.
4. Gallery: gains Copy original's path for linked files (it had the data, the species page already offered it).
5. Hide and Delete name recordings "recording" on the species page (it said "photo").
6. One width rule: sized to content between 224 and 320px. The Gallery menu is a little wider than `w-56` when an item needs it; the album menu is wider than `w-44`; a long place name wraps at 320px.
7. Right-click opens the photo menu on species, album, trip and Trash tiles, as it did in the Gallery.

Grids:

8. Trip import tiles use the species upload tile: 3:2 and the ink spinner (were 4:3 and the accent spinner).
9. Species photos without known dimensions fall back to 4:3 like every grid (were 3:2).
10. Trash tiles are PhotoTile: audio badge, video hover preview, phone layout, and a missing-file placeholder in the row's shape (was square).

Copy unchanged; keys `species.captureMenu.*`, `trips.photoMenu.viewSpecies` and `trips.photoMenu.deletePhoto` are gone (now `photoMenu.*`).

## Follow-up (approved 2026-11-04)

The four open decisions, all approved and done:

1. **Album cover toggles.** "Album cover ✓" now goes back to the automatic cover, like the trip's. The album answer carries `coverPicked`, so the automatic cover (the newest photo) is not offered as one to remove, and Adjust position shows only for a picked cover (a crop on the automatic one was dropped anyway).
2. **"Use as album cover"**, matching "Use as trip cover" and "Use as species card photo" (copy, guide, e2e).
3. **One set of edits on every menu.** Album and trip gain Edit tags, Correct the ID (with View and Undo), Also features another species, Location (see below) and Hide (with Undo); the album also gains Use as species card photo. The Gallery gains Also features another species and Location. They share `hooks/usePhotoEdits.tsx` (album, trip) and the existing CaptureEditModal dialogs; the Gallery keeps its own edits hook. Each change shows at once, then a reload brings what the server works out (names, covers, counts). The Gallery, album and trip answers now carry the place name (`locationLabel`), and trips also `tags`, `regionId` and `originalManaged`, so the Location dialog opens on the current place instead of saving over it.
4. **Trip selection is the Gallery's select mode** (`useSelectMode`): Shift ranges, drag select, Mod+A selects every shown photo, Esc leaves select mode, Delete asks to delete the selection. `useTripEdits` reads the shared selection for batch delete, its RAW check and Remove from trip. Import tiles are not selectable and don't count in ranges.

Still not offered: Delete on the album menu (Remove from album is its removal) and the species card photo on the trip menu (trip photos don't say whether they are the card photo).

## Location opens the map's coordinates dialog (2026-11-04)

Every photo menu's **Location** (Gallery, species, album, trip) opens CoordinatesModal for that one photo, the same dialog as the map and the Gallery's selection bar: saved places and "This looks like {name}" for a returning spot, typed or pasted coordinates, the mini map, save as a place, the far-photos confirm and the region offer. Its saved toast now has **Undo** (the shared location history, `POST /captures/location/undo`), and the page reloads after an undo; the Gallery's selection bar gets the same Undo.

One item, **Location**, with the photo's place on a second line. The old place name and region dialog is gone: its fields live in the coordinates dialog under **Edit name and region** (one photo only). The point, place name and region save in one `/captures/coordinates` call, so one Undo puts all three back; the name is sent only when it changed. Taking a region off is the one edit outside the undo history.

Saving coordinates never touches the place name unless it was edited, or a saved place was picked to file under. The species and trip answers now carry each photo's `lat` and `lon` so the dialog opens on the current point.

Screenshots: `assets/shared-photo-grid/location-menu-*` and `location-dialog-*` (light and dark, 390 and 1280).

## Check

`check:raw-controls` fails when Reveal, iNaturalist, Open in or the shared `photoMenu.*` item keys (view species, similar, add to album, edit tags, correct ID, downloads, copy path, hide, delete) appear outside `PhotoMenu`. Page items go through `coverItems` or `endItems`.

## Screenshots

`assets/shared-photo-grid/before-*` and `after-*`: each page's grid with the first photo's menu open, light and dark at 390, 1280 and 2560 wide, from a temporary preview page with sample data. `after-select-*`: select mode on Trash and the species page. `followup-*`: the album and trip menus, the trip's Location dialog and a Shift range in trip select mode, light and dark at 390 and 1280.
