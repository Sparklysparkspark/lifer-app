# WP0 strings for WP1

check:i18n fails on a key missing from en.json, so these were added to en.json (additions only). WP1: add the context lines to en.context.json and adjust wording as needed.

| Key                        | English                                                                   | Context                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `albums.addTo.onlySmart`   | Smart albums choose their own photos. Create an album below to add these. | Add to album dialog when every album is a smart album, which can't take hand-picked photos.                    |
| `upload.duplicate.skipAll` | Skip all ({count, number})                                                | Possible duplicate dialog, left of the footer: skips every waiting duplicate. {count} is how many are waiting. |

Copy to change (existing key, new behaviour):

- `species.picker.turnOnInaturalist` ("Turn on iNaturalist search in Settings to add any species"): the button now turns the search on in place and opens it with what was typed, without going to Settings. Suggested: "Search iNaturalist for any species". Its tooltip reuses `import.invertebrate.searchOptIn`.

Keys the shared components now use from other areas (candidates for `common.*`):

- `gallery.map.selectAll` and `gallery.map.deselectAll` in SelectionBar's Select all pair (SelectAllLinks). A new "Select all" key fails check:copy unless it sits under `ui.select.*`, which can't exist while `ui.select` is a string; WP1 can move these and fix the check's SHARED_TOGGLE pattern.

- `gallery.toolbar.clearAll` in PhotoFiltersMenu's Clear all footer.
- `albums.sections.searchAlbums` and `albums.sections.noMatch` in AddToAlbumModal's search.
- `import.review.earlierPhoto` as the duplicate prompt's thumbnail label.
- `movedPhotos.settings.*` (filterLabel, filterPlaceholder, notFound, removeFolder, noMatch) in components/FolderList.tsx.

Remembered state: AddToAlbumModal keeps the albums last added to in localStorage (`lifer:recentAlbums`, per viewer, ordering only). docs/docs/contributing/remembered-state.md may want a row (test: `AddToAlbumModal.test.tsx`).
