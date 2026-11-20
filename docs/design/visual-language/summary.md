# Lifer visual language: options for sign-off (V-01)

Open `index.html` in a browser to compare the three options side by side, in light and dark (the button at the top switches theme). Nothing here is built into the app yet. The chosen option becomes the token list for V-02.

## What stays the same in every option

- Sage accent `#68745e`, warm cream light theme (`#f6eedc` canvas, `#fbf7ee` surface), warm charcoal dark theme (`#141516` canvas, `#1c1e1f` surface). These are the current tokens in `apps/web/src/theme.css`.
- Flat illustration, one colour per broad taxa group, never a copy of another app's artwork.
- Fonts are open licence (SIL OFL) and bundled as woff2 files with their licences in `docs/docs/credits.md`. Nothing is fetched from a font service.
- The type scale keeps today's sizes and names. Only the face changes: the display face on `text-large-title`, `text-title-1` and `text-title-2`, the text face everywhere else.

## The options

| | A: Field guide | B: Sage and ink | C: Plate |
|---|---|---|---|
| Display face | Fraunces | Newsreader | Literata |
| Text face | Source Sans 3 | Public Sans | Atkinson Hyperlegible |
| Feel | Warm, bookish, friendly | Quiet, editorial | Sturdy, very legible |
| Illustration | Solid flat shapes with cream cut-outs | Ink outlines over a pale wash | Layered paper cut-outs in three tints |
| Colour mood | Clear, slightly saturated | Earthy, muted | Deeper, higher contrast |
| Best for | A distinctive identity | A calm, premium look | Accessibility first |
| Watch out for | Display face is wide: long titles wrap sooner | Outlines are fine at small tile sizes | Plainest of the three |

## Taxa group colours

Every colour is checked against the surface, the muted surface and the canvas of its theme. All pass WCAG 4.5:1 (text) in all three options, so a colour is safe as a label as well as a fill. Lowest ratio: A 4.69, B 4.64, C 4.70.

| Group | A light | A dark | B light | B dark | C light | C dark |
|---|---|---|---|---|---|---|
| Birds | `#3c6988` | `#8fbbd9` | `#4d6b4a` | `#a7c79f` | `#2f5f7a` | `#97c4de` |
| Mammals | `#8a5a34` | `#d6a27a` | `#925639` | `#e0a583` | `#7d4a2e` | `#dca989` |
| Reptiles | `#546e34` | `#a6c57e` | `#5c6928` | `#c3d174` | `#4f6f2a` | `#b0cf86` |
| Amphibians | `#2b6e61` | `#7fcdbd` | `#356f65` | `#86cbbd` | `#1f6e63` | `#86d3c4` |
| Fish | `#2d6a9f` | `#86b8e6` | `#3b6580` | `#8fb7d4` | `#27597f` | `#90bfe9` |
| Insects | `#895a17` | `#e0b45e` | `#895f18` | `#e6bb62` | `#8f5b0c` | `#ebbf6b` |
| Arachnids | `#7a4f7f` | `#c9a0cd` | `#80506a` | `#d3a3bf` | `#6c3f72` | `#d2a8d6` |
| Other | `#616468` | `#b2b6ba` | `#65655e` | `#b6b6ad` | `#575b60` | `#bcc0c4` |

## Chart and map styling notes

- Charts: series take the taxa colours in a fixed order, hairline grid in the line colour, no chart border, direct labels where they fit, a legend otherwise. The same tokens serve Stats and the Home page.
- Map: land and water are two close warm greys (cream and grey in light, charcoal in dark), hairline borders, no road colours, place labels only from zoom 5. Clusters are filled with the group colour that has the most photos in them and carry the count in the surface colour. Shaded relief is decided in V-03 once its size is measured.

## Type scale mapping

| Style | Size | Face |
|---|---|---|
| `text-large-title` | 1.75rem | Display |
| `text-title-1` | 1.5rem | Display |
| `text-title-2` | 1.25rem | Display |
| `text-title-3` and below | unchanged | Text |

## Decision

Pick one option (or mix, for example the type pair of B with the illustration of A), and write it here. V-02 starts from this.

- Chosen option:
- Notes and changes:
- Signed off by / date:

## Decision (2026-10-25)

- **Type:** keep today's system interface fonts (no bundled display or text face). The type scale stays as it is.
- **Taxa colours:** option B, Sage and ink, light and dark values from the table above.
- **Charts:** keep the current Stats page chart style; taxa colours are used only for series.
- **Group tile illustrations:** drawn by the maintainer as original SVGs (one per broad group, tintable, readable small in both themes). The mockup shapes are placeholders only.
- **Map:** quiet basemap and group-coloured clusters as described, plus shaded relief and 3D terrain (V-03, V-11).
