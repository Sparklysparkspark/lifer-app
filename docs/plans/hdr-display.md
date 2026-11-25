# HDR display

Can Lifer show HDR photos? Yes, as an optional display layer on top of the normal pipeline, and a
small experimental first step is built (off by default). Status: prototype, 2026-11-25.

## Summary

- **The rule.** The original file is never changed, and everything that exists today (thumbnails,
  display previews, species matching vectors, crops, edits, exports, search, share pages, the phone
  app) keeps running on the normal SDR sRGB pipeline for every format. HDR is an extra rendition the
  full-size viewer swaps in only where the screen and the webview can show it. Everywhere else the
  SDR preview shows, with no visible difference in behaviour.
- **What webviews can do.** WKWebView on macOS 26 and later and Chromium (Chrome, Edge, WebView2)
  render gain-map HDR images in a plain `<img>` and support `dynamic-range-limit`. WebKitGTK (Linux)
  has no HDR image path. So: macOS and Windows yes, Linux SDR only.
- **What we can make.** sharp 0.35 (already a dependency) resizes an Ultra HDR JPEG while keeping its
  gain map (`keepGainMap()`), and can write a new Ultra HDR JPEG from linear HDR pixels
  (`withGainMap()`). That covers Ultra HDR / ISO 21496-1 JPEGs now, and PQ/HLG AVIF later with a
  small converter. HEIC, JPEG XL and RAW HDR need decoders Lifer doesn't have.
- **This Mac can't show HDR right now.** Both Dell monitors report an EDR headroom of 1.0 (current
  and potential), so `(dynamic-range: high)` is false here. They are Display P3 capable.
- **Built.** Settings > General > Appearance > **Show HDR photos in the viewer** (experimental, off).
  With it on and an HDR screen, the viewer asks `GET /api/photos/:id/hdr` for a 2,560 px Ultra HDR
  copy and swaps it in once decoded; a 404 (no gain map) or any failure keeps the SDR image.

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

## What each format needs for an HDR rendition

The rendition is always an Ultra HDR JPEG (SDR base plus ISO 21496-1 gain map), because every
engine that can show HDR reads it, and every other one shows its SDR base. Sizes are for a 2,560 px
long edge, measured on the 3000 x 2000 samples.

| Original                                                 | Feasible now?                                                                                                                                                                                                                                                                                                                                                            | Extra storage                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Ultra HDR / ISO 21496-1 JPEG (Lightroom, Pixel, Samsung) | **Yes, built.** `sharp().rotate().keepGainMap().resize()` keeps and rotates the gain map, leaves every tag out (checked with exiftool: no GPS, Make or Artist). The copy's base is tagged sRGB, so a P3 base loses its wider gamut in the HDR copy.                                                                                                                      | about 1.1 MB (0.72 MB base + 0.38 MB full-size gain map) |
| AVIF or HEIF with PQ or HLG (no gain map)                | **Yes, with a small converter.** sharp decodes the 10-bit pixels as 16-bit; a JS PQ (or HLG) to linear step plus a BT.2020 to BT.709 matrix gives scRGB, and `withGainMap()` writes an Ultra HDR JPEG. Prototyped in the scratchpad: real gain map, 350 ms, but 6 MB untuned; the libultrahdr CLI path (ffmpeg to P010, `ultrahdr_app`) made 0.75 MB. Needs size tuning. | 0.75 to 1 MB once tuned                                  |
| AVIF with a gain map (`tmap`)                            | **Not with sharp.** Its AVIF reader doesn't see the gain map (`metadata().gainMap` empty), and `withGainMap()` made a nearly flat map. Needs libavif (`avifgainmaputil tonemap` to PQ, then the row above), a new native dependency.                                                                                                                                     | as above                                                 |
| HEIC (iPhone HDR: Apple gain map or ISO 21496-1)         | **No.** Lifer decodes HEIC with heic-decode, which gives the 8-bit primary image only; sharp's prebuilt libvips has no HEVC. Would need native libheif with libde265 (patent and licence review) or macOS ImageIO (Mac only).                                                                                                                                            | about 1 MB                                               |
| JPEG XL (`jhgm` gain map, or PQ/HLG)                     | **No.** sharp can't read JPEG XL ("unsupported image format"); Lifer's own decoder outputs 8-bit. Needs libjxl's gain map API.                                                                                                                                                                                                                                           | about 1 MB                                               |
| PNG or TIFF with PQ/HLG (`cICP`) or float linear         | **Possible.** sharp reads 16-bit PNG/TIFF; the `cICP` chunk needs a small parser, then the PQ/HLG converter. A float TIFF is already linear and goes straight to `withGainMap()`.                                                                                                                                                                                        | about 1 MB                                               |
| RAW                                                      | **No.** HDR from RAW needs a raw developer with HDR output (Lightroom, Apple RAW); the embedded previews Lifer uses are SDR. People export Ultra HDR JPEGs from Lightroom, which the first row covers.                                                                                                                                                                   | none                                                     |

Only photos with an HDR original get a rendition, so for most wildlife libraries the cost is a few
hundred MB at most. The normal pipeline needs no change for any of these: today every format is
decoded to its SDR base (or tone mapped) and that stays the source of thumbnails, previews and
matching.

## Options

| Option                                                        | Effort                                    | Verdict                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Wide gamut only: P3 previews for P3 screens, sRGB fallback | 2 to 3 days                               | Worth it later, as its own rendition: P3 previews would change every thumbnail and the matcher inputs if done in place, which the rule above forbids. These Dells are P3, so this is the only visible gain on this Mac today. |
| B. HDR in the full-size viewer only, behind a setting         | first step 1 day (done), full 3 to 5 days | **Recommended.** A derived, metadata-free Ultra HDR rendition, not the original bytes: a 2,560 px copy is a tenth of a 20 MB original over a server link, and carries no GPS.                                                 |
| C. Thumbnails and grids stay SDR                              | none                                      | Yes, always. Hundreds of HDR tiles next to SDR UI would glare and drain battery.                                                                                                                                              |
| D. Not worth it now                                           | none                                      | The first step is cheap and isolated, so B over D.                                                                                                                                                                            |

## Recommendation and next steps

1. **Done (prototype).** Ultra HDR JPEG only, made on first view, cached an hour beside the other
   full-size renders (`APP_DATA_DIR/full/<id>-hdr.jpg`), setting off by default. Files:
   `apps/api/src/photos/fullRender.ts` (`hdrRender`), the `/photos/:id/hdr` route in
   `apps/api/src/photos/routes.ts`, `apps/web/src/lib/hdrViewer.ts`, `Lightbox.tsx`, the row in
   `GeneralSettings.tsx`.
2. **Keep the rendition (1 to 2 days).** Store it in `APP_DATA_DIR/hdr/<photo id>.jpg` next to the
   display preview, made by a background job after import, and record it in the database (a nullable
   `photos.hdr_rendition` state: unknown, none, ready). The API then lists which photos have one, so
   the viewer never probes a photo that hasn't, phones and share pages never ask, and a library-wide
   backfill is one resumable job (run once before launch; afterwards batched into a release).
3. **PQ/HLG AVIF and HEIF (1 to 2 days)** with the converter above, tuned for size.
4. **AVIF gain maps, HEIC, JPEG XL** only if people ask: each needs a new native decoder.

## Risks

- **Glare.** An HDR photo beside SDR UI looks very bright. The viewer's backdrop is dark already;
  only the open photo is HDR. If it is too much, `dynamic-range-limit: constrained` (Chrome only)
  or a brightness choice can follow.
- **WebKit falls back to SDR under transforms.** Zoom and pan may drop to SDR (see above). Fine as a
  fallback, odd if it flickers between the two while zooming.
- **Battery.** HDR drives the backlight harder on laptops; it's opt-in and viewer-only.
- **Species matching stays SDR.** It never reads the HDR copy.
- **Sharing and exports.** Share links, print and share pages, exports and the phone app keep the
  SDR images; the decision function only matches the owner's `/api/photos/:id/display`.
- **Privacy.** The HDR copy carries no metadata (GPS included), and the route needs the owner's
  `photos.read` scope (not the companion app's), so nothing about GPS sharing changes.
- **Server bandwidth.** About 1.1 MB per opened photo, only with the setting on and an HDR screen.
  Neighbours are not preloaded as HDR.
- **Probe cost.** Until step 2, each viewed JPEG with the setting on reads its original once to look
  for a gain map, and a photo without one 404s (remembered until reload).

## What the maintainer must eyeball on a real HDR display

Use an Apple XDR screen (MacBook Pro 14/16 inch, Pro Display XDR) or an HDR monitor with HDR turned
on in System Settings > Displays (check whether these Dells offer the switch). Open the scratch
harness `index.html` in the session scratchpad's `hdrlab/harness` folder in Safari, and in Chrome:

1. The first row's Ultra HDR JPEGs (original and sharp's resize) have highlights brighter than the
   page white; the second row (`dynamic-range-limit: standard`) looks SDR.
2. Which of the AVIF (gain map), PQ AVIF and JPEG XL show HDR in each browser.
3. The sharp resize looks as good as the original (its base is sRGB, not P3).
4. In the Lifer dev app with the setting on: an Ultra HDR photo brightens shortly after opening;
   zooming and panning keep it HDR (or say if it flickers to SDR); paging is smooth; an SDR photo is
   unchanged; moving the window to an SDR screen switches the photo back to SDR.
5. Whether the bright photo next to the dark viewer UI is pleasant or too much.
