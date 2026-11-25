# One card shell

Lifer grew three lookalike cards (Collection species, iNaturalist sightings, trips and albums) and a bare photo tile (Gallery and every photo grid). They drift apart in small ways: rings, overlay controls, padding, title size. This note sets one visual and interaction vocabulary and the one component that carries it.

Rule: one card shell. Extend it, do not fork it (ux-rules C2, C3, T4).

## Audit (2026-11-04)

| Item                          | File                                                                                                        | Media                                                                                              | Title and lines                                                                                 | Badges                                                            | Overlay controls                            | Selection                                                             | Selected look                                                                                              | Hover                                            | Keyboard                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Gallery photo tile            | `components/PhotoTile.tsx` (Gallery, trip, album, species photo grid, album exclusions, map panel and tray) | one photo, justified row aspect, video hover preview, audio badge                                  | caption below (PhotoTileCaption), optional                                                      | duration or recording                                             | ⋯ menu (shared dots pill), right-click menu | select mode only; SelectMark is the control; Shift range; drag select | `ring-2 ring-inset ring-blue-500` on the `<img>`: **never painted** (an inset shadow draws under an image) | ⋯ fades in on hover only                         | photo is a button; ⋯ focusable while invisible   |
| Collection species card       | `components/SpeciesCard.tsx` (GroupedSpeciesGrid, CollectionPage, species lists)                            | square photo or crop, reference photo, placeholder; grayscale when seen, dim when unseen or target | name (fit, 2 lines, italic when scientific), second name fitted, `p-3` or compact `px-1.5 py-1` | one badge; tier line via `TierLabel`; seen, target icons; a count | ⋯ menu inside the link's image box          | select mode; whole card toggles; SelectMark shows state               | `border-accent ring-2 ring-accent`                                                                         | shadow                                           | link; Space toggles in select mode               |
| iNaturalist card              | `pages/inaturalist/CardGrid.tsx` (Sightings, Observations tabs)                                             | 1 to 3 photo mosaic, +N scrim, dimmed left-out photos                                              | name `text-callout`, muted lines, `p-2.5`                                                       | none                                                              | Preview and ⋯ pills, right-click menu       | always on: click toggles, Shift range, Mod+A, Esc                     | `border-accent ring-2 ring-accent`                                                                         | shadow; pills on hover or focus, always on touch | option; Enter or Space opens; double-click opens |
| iNaturalist photo window tile | same file, `PhotoWindow`                                                                                    | square photo, dim when left out                                                                    | none                                                                                            | "Left out" strip                                                  | none                                        | click toggles                                                         | `ring-2 ring-inset ring-accent` on the button: hidden under the photo                                      | none                                             | checkbox button                                  |
| Trip card                     | `components/TripCard.tsx`                                                                                   | CoverImage or spinner                                                                              | name 2 lines, dates, counts, Active badge                                                       | Active                                                            | ⋯ menu in the image box                     | none                                                                  | n/a                                                                                                        | shadow                                           | link                                             |
| Album card                    | `pages/CollectionsPage.tsx`                                                                                 | CoverImage                                                                                         | name 2 lines, smart label, count                                                                | Smart                                                             | ⋯ menu in the image box                     | none                                                                  | n/a                                                                                                        | shadow                                           | link                                             |
| Import suggestion card        | `components/SuggestionCard.tsx`                                                                             | reference photo                                                                                    | name, scientific, match, `p-1.5`, truncated                                                     | none                                                              | magnifier, its own 24px circle              | keyboard highlight                                                    | `border-accent ring-2 ring-accent`                                                                         | shadow plus accent border                        | button                                           |
| Trash tile                    | `pages/TrashedPhotosPage.tsx`                                                                               | photo or placeholder                                                                               | none                                                                                            | duration                                                          | ⋯ menu                                      | select mode; a hand-built tick                                        | blue inset ring on the `<img>` (not painted)                                                               | ⋯ on hover                                       | button                                           |
| Offline pack region pills     | `pages/OfflinePacksPage.tsx`                                                                                | none                                                                                               | label                                                                                           | coverage fill                                                     | none                                        | toggle                                                                | `ring-accent/40`                                                                                           | fill                                             | button                                           |
| Command palette photo result  | `components/CommandPalette.tsx`                                                                             | square thumb                                                                                       | none                                                                                            | none                                                              | none                                        | keyboard highlight                                                    | outer `ring-2 ring-accent`                                                                                 | none                                             | listbox                                          |

Corner radii already agree: framed cards use `rounded-panel`, bare photos `rounded-control` or the Gallery's corner setting.

## The shell: `components/MediaCard.tsx`

```tsx
<MediaCard
  media={<img ... />}            // a photo, <PhotoMosaic photos={...} />, or anything
  mediaClassName="aspect-square" // aspect and dimming of the media box (default square)
  title="Northern Flicker"       // omitted: just the photo, rounded on every corner
  titleClassName="line-clamp-2"  // extra title classes (italic, clamp)
  lines={["Oct 12", "Burnaby"]}  // muted lines; empty ones skipped; elements pass through
  badge={<Badge />}              // under the lines
  textClassName="opacity-60"     // dims the text block
  compact                        // smallest sizes: tighter text block
  selected={selected}            // the accent ring
  markLabel={selectMode ? label : undefined} // shows the SelectMark
  actions={<>Preview, Menu</>}   // the top-right overlay row
  renderBody={(p) => <Link {...p} to="..." />} // the interactive element: Link, button or option
/>
```

What the shell owns, so every card matches:

- Frame: `rounded-panel border bg-surface`, shadow on hover, the accent focus outline, `overflow-hidden`.
- Selected: `border-accent ring-2 ring-accent` (`CARD_SELECTED`). The ring is a box shadow, so the card never changes size (T4).
- Media box: the panel radius minus the border on the top corners, or all four when there is no text, with the WebKit `clip-path` fix that used to live only in SpeciesCard.
- Text block: `p-3` (compact `px-1.5 py-1`), `gap-0.5`; title `font-medium leading-tight text-ink break-words` at body size; lines `text-footnote text-muted`.
- Select tick: the shared SelectMark at the card's top left.
- Overlay row: `absolute right-1 top-1`, outside the interactive element, so a menu button is never nested in a link or button (invalid HTML, and the reason SpeciesCard needed `preventDefault` on every item).

The interaction is the caller's: `renderBody` gets the class and content and returns a Link (species, trip, album), a button (suggestion) or a `role="option"` div (iNaturalist). Click, double-click, Enter, Space and right-click stay on that element, so no behaviour moves.

Shared pieces for things that are not framed cards:

- `OVERLAY_REVEAL` (`lib/buttonClasses.ts`, beside `OVERLAY_PILL`): overlay controls hide until the item is hovered or holds keyboard focus where there is a mouse, and always show on touch. Menu's `dots` trigger uses it, so the Gallery ⋯ now appears when a tile has keyboard focus.
- `SelectedRing` (`components/MediaCard.tsx`): the accent ring for a bare photo, drawn as an overlay above the image so it actually shows.
- `PhotoMosaic`: the cover plus up to two more with a +N scrim, from the iNaturalist card.

## The ring colour

Accent everywhere (`#68745e` in both themes, T2). As a 2px non-text indicator it needs 3:1 against what is next to it (WCAG 1.4.11): about 4.6:1 on the light surface and 3.4:1 on the dark surface. Over a photo it sits beside arbitrary pixels, as blue did; the white select tick carries the state too.

## What stays separate, and why

- **PhotoTile keeps its own structure.** It is a bare photo in a justified row, not a framed card: natural aspect, user corner radius, video hover preview, drag select, caption below the photo, right-click menu, phone edge-to-edge layout. It shares the ring, the overlay pill and reveal, and SelectMark. Its props are unchanged, so the map panel and tray need no edits.
- **Selection logic is not unified.** `useSelectMode` (Gallery, albums, trips, species photos, Trash, Collection) is a mode you enter, index based, with drag select. `useCardSelection` (iNaturalist) is always on, key based, with Esc and background clicks clearing it. The click models differ on purpose (the iNaturalist tabs exist to pick sightings), so one hook would need a flag for each difference. Both already share the visuals and Shift-range semantics; merging the hooks is not worth it now.
- **Paging stays in CardGrid.** The Collection grid is windowed (GroupedSpeciesGrid) and the photo grids use justified rows; only the iNaturalist grid pages with Show more.
- **Offline pack pills and the command palette** are not cards. Left alone.

## Check

`check:raw-controls` also flags a hand-built select tick (`h-4 w-4 accent-accent`), a local dark overlay pill (`rounded-full bg-black/40` style) or a non-accent selection ring (`ring-blue-*`) outside the shared files.

## Done (2026-11-04)

On the shell: SpeciesCard, the iNaturalist Card, TripCard, the album card (CollectionsPage) and SuggestionCard. Sharing the pieces only: PhotoTile, Trash tiles, the iNaturalist photo window and the share page's download pill (now the overlay IconButton).

Visible changes, for the maintainer to approve:

- The Gallery (and every PhotoTile grid, the map panel included) and Trash now show the accent ring on selected photos. Before, the blue ring never painted over a loaded image.
- The ⋯ on photo tiles, species, trip and album cards now appears when the item has keyboard focus, and always shows on touch screens (it was hover only, so unreachable on touch).
- iNaturalist card titles are body size (were callout) and the text block has the species card's `p-3` padding.
- The species card text block has a 2px gap between lines; the ⋯ and select tick sit 1px further out (they now align to the card's edge, not the photo's).
- The suggestion card's magnifier is the shared oval pill, shown on hover or focus (was a 24px circle at 80% opacity), and the card no longer turns its border accent on hover; it shows the shadow like every card.

Left as is: the select tick still overlaps the seen and target dots on a species card in select mode (it did before); offline pack pills, command palette results and the species hero arrows are not cards.

Screenshots: `assets/shared-card/before-*` and `after-*` (light and dark at 390, 1280 and 2560 wide, plus hover and keyboard focus).
