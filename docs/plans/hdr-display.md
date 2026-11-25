# HDR display

Lifer shows HDR photos at full brightness in the viewer, behind **Settings > General > Appearance >
Show HDR photos in the viewer** (off by default). Status: built for JPEG, AVIF, JPEG XL, PNG and
TIFF HDR, 2026-11-25; HEIC is assessed below and not shipped; RAW stays SDR.

## Summary

- **The rule.** The original file is never changed, and everything that exists (thumbnails, display
  previews, species matching vectors, crops, edits, exports, search, share pages, the phone app)
  runs on the normal SDR sRGB pipeline for every format, unchanged. HDR is an extra rendition the
  full-size viewer swaps in only where the screen and the webview can show it. Everywhere else the
  SDR preview shows, with no visible difference in behaviour.
- **What webviews can do.** WKWebView on macOS 26 and later and Chromium (Chrome, Edge, WebView2)
  render gain map HDR images in a plain `<img>`. WebKitGTK (Linux) has no HDR image path. So: macOS
  and Windows yes, Linux SDR only.
- **One rendition format.** Whatever the original, the rendition is an Ultra HDR JPEG (an SDR base
  plus an ISO 21496-1 gain map, with the older hdrgm XMP too), up to 2,560 px, with no metadata (no
  GPS). Every engine that can show HDR reads it; any other shows its SDR base.
- **No new dependency.** sharp (libvips, libheif with AV1), jxl-oxide (JPEG XL) and Lifer's own small
  readers and writer for the containers do it all.
- **This Mac can't show HDR right now.** Both Dell monitors report an EDR headroom of 1.0, so
  `(dynamic-range: high)` is false here. They are Display P3 capable.

## How it works

- **Detect** (`apps/api/src/photos/hdr/detect.ts`) reads the original's header only: a JPEG's APP
  segments (MPF plus ISO 21496-1 or hdrgm), a PNG's `cICP` chunk or ICC `cicp` tag, a TIFF's ICC
  `cicp` tag, an AVIF's items (a `tmap` gain map item, or the primary image's nclx transfer: 16 PQ,
  18 HLG), a JPEG XL's `jhgm` box. Nothing else in Lifer calls it.
- **Render** (`render.ts`):
  - Gain map JPEG: sharp resizes and rotates base and gain map together (`keepGainMap()`).
  - AVIF or JPEG XL with a gain map: the base and the gain map image are decoded (sharp reads the
    AVIF gain map item by a copy of the file that names it primary, `heifItems.ts`; jxl-oxide
    decodes the `jhgm` codestream) and re-encoded at rendition size; the file's own ISO 21496-1
    block is copied over. A P3 base keeps a Display P3 profile.
  - PQ or HLG (AVIF, PNG, TIFF, JPEG XL): 16-bit pixels to linear light (SDR white 203 nits, the
    BT.2100 OOTF for HLG), to Display P3, a hue-keeping shoulder for the SDR base, and the gain map
    back to the HDR image (`ultraHdr.ts` writes the file, `gainMapMetadata.ts` the metadata).
  - An HDR file with nothing above SDR white gets no rendition.
- **Store** in `APP_DATA_DIR/hdr/<photo id>.jpg`, beside the display previews, with
  `photos.hdr_rendition` (migration 206): NULL not looked at, `none`, `ready`. A `.source` note
  records the original's path and modified time; the route makes the rendition again when the
  original was re-edited, relinked or swapped for another version. Trash and Remove all data delete
  the files with the other derivatives.
- **Background pass** (`renditions.ts`, started in `index.ts`): every 30 s, once imports have been
  quiet for 15 s, it looks at every photo still NULL, one at a time, and records each outcome as it
  goes. That one pass is the library backfill as well: it resumes where it stopped, never looks at a
  photo twice, and leaves a photo whose drive is away for the next launch.
- **Routes.** `GET /api/photos/hdr-renditions` lists the user's photos with a rendition;
  `GET /api/photos/:id/hdr` serves one (owner only, `photos.read`, not the companion app).
- **Viewer** (`apps/web/src/lib/hdrViewer.ts`, used by `Lightbox.tsx` through `useHdrPhoto`): with
  the setting on and `(dynamic-range: high)`, it loads the list when the viewer opens and asks only
  for listed photos, swapping the rendition in once decoded. If the list can't be loaded it may ask
  for any photo; a 404 keeps the SDR image. Share links and reference photos never qualify.

Measured on 3000 x 2000 samples (2,560 px renditions):

| Original                                 | Rendition | Time on an M4 |
| ---------------------------------------- | --------- | ------------- |
| Ultra HDR JPEG (Lightroom)               | 1.10 MB   | 0.2 s         |
| AVIF with a gain map (Lightroom)         | 0.80 MB   | 0.4 s         |
| JPEG XL with a gain map (Lightroom)      | 0.81 MB   | 4.6 s         |
| 10-bit BT.2020 PQ AVIF                   | 0.72 MB   | 1.3 s         |
| PQ PNG and PQ JPEG XL (1,200 px samples) | 0.23 MB   | 0.4 to 0.5 s  |

Only HDR photos get one, so a library pays about 1 MB per HDR photo.

## Evidence per webview

Probed with a scratch harness (5 HDR samples: an Ultra HDR JPEG original, the same resized by
sharp `keepGainMap()`, an AVIF with a gain map, a 10-bit BT.2020 PQ AVIF made with
`avifgainmaputil tonemap`, and a JPEG XL with a `jhgm` gain map box), loaded in the system
WKWebView by a tiny Swift host (the same engine Tauri uses on macOS) and in Chrome 153 headless.
Nothing touched the running Lifer app. Headless and off-screen runs can't show brightness, so
"renders brighter than white" is on the eyeball list below.

This Mac: macOS 27.0.1, Safari 27.0.1, Apple M4, displays DELL U2725QE and DELL U3225QE.
`system_profiler SPDisplaysDataType` lists no HDR or EDR line; `NSScreen` reports
`maximumPotentialExtendedDynamicRangeColorComponentValue` 1.0 on both and `canRepresent(.p3)` true.

| Feature                                           | WKWebView (macOS 27, probed)    | Chrome 153 (headless, probed) | WebView2 (Windows)            | WebKitGTK (Linux)         |
| ------------------------------------------------- | ------------------------------- | ----------------------------- | ----------------------------- | ------------------------- |
| `(dynamic-range: high)`                           | false on these SDR monitors     | false (headless)              | true only with Windows HDR on | expected false            |
| `(color-gamut: p3)`                               | true                            | false (headless)              | per display                   | per display               |
| `dynamic-range-limit: standard / no-limit`        | supported                       | supported                     | as Chrome                     | not expected              |
| `dynamic-range-limit: constrained`                | not supported                   | supported                     | as Chrome                     | no                        |
| `-webkit-dynamic-range-limit`                     | not supported (unprefixed only) | not supported                 | no                            | no                        |
| `color(display-p3 ...)`                           | supported                       | supported                     | supported                     | supported                 |
| `color(rec2100-pq ...)`                           | not supported                   | not supported                 | no                            | no                        |
| canvas 2D `colorSpace: 'display-p3'`              | yes                             | yes                           | yes                           | not checked               |
| canvas 2D `colorType: 'float16'`                  | not reported (ignored)          | yes                           | as Chrome                     | no                        |
| canvas `configureHighDynamicRange`                | absent                          | absent                        | absent                        | absent                    |
| WebGPU canvas `toneMapping: { mode: 'extended' }` | accepted                        | accepted                      | as Chrome                     | not checked               |
| Decodes Ultra HDR JPEG, AVIF (gain map and PQ)    | yes                             | yes                           | yes                           | AVIF depends on the build |
| Decodes JPEG XL                                   | yes                             | no                            | no                            | no                        |

Shipping status from the vendors:

- **WebKit / Safari 26.0** (macOS 26, iOS 26): "adds support for HDR images on the web" and the
  `dynamic-range-limit` values `no-limit` and `standard`
  ([WebKit features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/),
  [Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)).
  macOS 14 and 15 WebKit decode gain-map images as their SDR base, so on those versions Lifer would
  show SDR: harmless. The probe shows the property enabled in a plain WKWebView on macOS 27, which
  suggests the HDR image path is on for apps too, not only Safari; that still needs eyeballing.
  Known WebKit bugs (from search results, worth re-checking): a gain-map image falls back to SDR
  under some CSS `transform` / `position` uses and during CSS transitions. The viewer's ZoomPane
  uses `transform` and `will-change: transform`, so this is the top eyeball item.
- **Chromium**: Ultra HDR JPEG gain maps since Chrome 116; ISO 21496-1 JPEG test pages ask for
  Chrome 137 or later; `dynamic-range-limit` since Chrome 136
  ([intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/cG_ZCeQaWQs),
  [ISO 21496-1 test photos](https://people.csail.mit.edu/ericchan/hdr/jpeg-gain-map-iso.html)).
  WebView2 is the same engine, and shows HDR only when Windows "Use HDR" is on for that display.
- **WebKitGTK**: no HDR image support found; WebKit's gain map work rides on Apple's CoreGraphics.
  Linux stays SDR.
- `<video>` tricks (a one-frame HDR video as a still) work in all three engines but cost a
  transcode per photo and break zoom; not worth it when `<img>` gain maps work.

## Formats

| Original                                                              | Status                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Ultra HDR / ISO 21496-1 gain map JPEG (Lightroom, Camera Raw, phones) | Built.                                                                                                              |
| AVIF with a gain map (Lightroom "maximize compatibility")             | Built.                                                                                                              |
| AVIF, PQ or HLG                                                       | Built.                                                                                                              |
| JPEG XL with a gain map, or PQ or HLG                                 | Built. Decoding is WebAssembly, so a large JPEG XL takes a few seconds in the background.                           |
| 16-bit PNG or TIFF, PQ or HLG (`cICP`, or an ICC v4.4 `cicp` tag)     | Built. A TIFF or PNG whose ICC profile states PQ or HLG only by its curves (no `cicp` tag) is not recognised.       |
| HEIC / HEIF (HEVC): iPhone HDR, Canon HDR PQ HEIF                     | Not shipped. Options below.                                                                                         |
| RAW                                                                   | SDR, by design: HDR from a RAW needs a raw developer; people export HDR from Lightroom, which the rows above cover. |

### HEIC options

Lifer already decodes HEIC with heic-decode, which runs libheif-js: libheif 1.23 with libde265,
compiled to WebAssembly, LGPL-3.0 (compatible with Lifer's AGPL, and loaded as a replaceable module).
Its own preview path asks for 8-bit RGBA only.

1. **The libheif-js already shipped (recommended, about 2 days).** Its WebAssembly build exports the
   raw libheif C API: decode to 16-bit interleaved RGB (`heif_chroma_interleaved_RRGGBB_LE`), read
   nclx colour, list auxiliary images. That covers Canon PQ and HLG HEIF (the PQ/HLG path above) and
   an iPhone's gain map: iOS 18 and later write an ISO 21496-1 `tmap` item (the AVIF path, decoded
   by libheif-js instead of sharp); earlier iPhones store Apple's own auxiliary gain map
   (`urn:com:apple:photo:2020:aux:hdrgainmap`) whose headroom sits in Apple's metadata, documented by
   Apple. No new dependency; the HEVC patent position is the same as today's HEIC previews.
2. **macOS ImageIO** (Core Image can read an HDR HEIC and write an ISO gain map JPEG on macOS 15 and
   later) through a small helper in the desktop app: licence-free, but Mac only and not in the
   Docker server.
3. **Not suitable:** the bundled ffmpeg-static is a 6.0 GPL build that can't read HEIF image grids
   (iPhone photos are grids); a native libheif plus libde265 would add the same LGPL code a second
   time as a native module, for no gain over option 1.

## Risks

- **Glare.** An HDR photo beside SDR UI looks very bright. The viewer's backdrop is dark already;
  only the open photo is HDR. If it is too much, `dynamic-range-limit: constrained` (Chrome only)
  or a brightness choice can follow.
- **WebKit falls back to SDR under transforms.** Zoom and pan may drop to SDR. Fine as a fallback,
  odd if it flickers between the two while zooming.
- **Battery.** HDR drives the backlight harder on laptops; it's opt-in and viewer-only.
- **Species matching stays SDR.** Nothing but the viewer reads the rendition.
- **Sharing and exports.** Share links, print and share pages, exports and the phone app keep the
  SDR images.
- **Privacy.** The rendition carries no metadata (GPS included), and the route is the owner's only.
- **Server bandwidth.** About 1 MB per opened HDR photo, only with the setting on and an HDR screen.
  Neighbours are not preloaded as HDR.
- **Colour.** The tone mapped SDR base of a PQ or HLG photo is Lifer's own (a simple shoulder), so
  on an HDR screen that has less headroom than the photo the in-between looks may differ a little
  from Lightroom's. Gain map originals keep the photographer's own base and gain map.
- **Migration number.** 206 was free when written; renumber if another change lands 206 first.

## What the maintainer must eyeball on a real HDR display

Use an Apple XDR screen (MacBook Pro 14/16 inch, Pro Display XDR) or an HDR monitor with HDR turned
on in System Settings > Displays (check whether these Dells offer the switch), and turn on the
setting in the Lifer dev app.

1. A Lightroom Ultra HDR JPEG, HDR AVIF and HDR JPEG XL each brighten shortly after opening in the
   viewer, and look like the original does in Lightroom or Preview.
2. A PQ AVIF or PQ PNG looks right, both on the HDR screen and as its SDR base (the in-between
   brightness steps too: lower the screen brightness to shrink the headroom).
3. Zooming and panning keep it HDR (or say if it flickers to SDR); paging is smooth; an SDR photo is
   unchanged; moving the window to an SDR screen switches the photo back to SDR.
4. Whether the bright photo next to the dark viewer UI is pleasant or too much.
5. On Windows with HDR on, the same in the WebView2 app.
