---
title: Other apps and keywords
description: How the species keywords Lifer writes show up in Lightroom Classic, Apple Photos, Adobe Bridge, Photoshop, DxO PhotoLab, Peakto and plain folders, and what to switch on in each.
---

# Other apps and keywords

Lifer writes what it knows about each photo into the photo's own metadata, so other photo apps can search and sort by species without Lifer. This page says what Lifer writes, what each app reads, and what to switch on.

## What Lifer writes

For every photo Lifer manages, it writes:

- **Keywords:** the common name, the scientific name, the ABA and eBird codes, your own tags, and a `Lifer:Cover` mark on a species' cover photo. Keywords from other apps stay.
- **A keyword tree:** `Species|Birds|Family|Name`, plus `Lifer Tags|your tag`, for apps that show nested keywords.
- **A title** with the species name, and a **caption**, **copyright** and **creator** if you set them in [Metadata](./metadata-and-file-names.md).
- **Place, GPS, date and star rating.**

Where it goes depends on the file:

| File                             | Where Lifer writes                                                          | File name                                                 |
| -------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| JPEG, TIFF, PNG, DNG, WebP, HEIC | Inside the file, as XMP and IPTC together                                   | The file itself                                           |
| AVIF, JPEG 2000 (`.jp2`, `.jpx`) | Inside the file, as XMP                                                     | The file itself                                           |
| RAW files and videos             | A separate `.xmp` sidecar next to the file. The RAW itself is never changed | `IMG_0001.xmp`, `IMG_0001.CR3.xmp` or both, as you choose |

You can change each of these in **Settings > Metadata > Where keywords go**. See [What works and the options](#options).

By default Lifer writes only to files it manages, the copies in your Lifer library folder. Photos in a [linked folder](./library-folders.md) are never changed; you can let Lifer put a sidecar next to them.

## At a glance

| App                                     | Reads our keywords                     | Keyword tree       | Sidecar next to a RAW    | What to do                                                     |
| --------------------------------------- | -------------------------------------- | ------------------ | ------------------------ | -------------------------------------------------------------- |
| [Lightroom Classic](#lightroom-classic) | Yes                                    | Yes                | Yes                      | Import, or read metadata from files                            |
| [Apple Photos](#apple-photos)           | Yes                                    | No                 | No                       | Send keywords to Apple Photos, or import files that carry them |
| [Folders](#folders)                     | Yes, in any app that reads XMP or IPTC | Depends on the app | Depends on the app       | Nothing                                                        |
| [Adobe Bridge](#adobe-bridge)           | Yes                                    | Yes                | Yes                      | Turn on hierarchical keywords                                  |
| [Adobe Photoshop](#adobe-photoshop)     | Yes, in File Info                      | Not shown          | Through Camera Raw       | Open the photo, or use Bridge                                  |
| [DxO PhotoLab](#dxo-photolab)           | Partly, not tested                     | No                 | Not confirmed            | See the DxO section                                            |
| [Peakto](#peakto)                       | Yes, not tested                        | Not confirmed      | Yes, for watched folders | Turn on XMP sync                                               |

"Yes" for Bridge, Photoshop and Lightroom is how Adobe documents those apps. We haven't tested DxO PhotoLab or Peakto ourselves: those rows come from their own help pages and user reports, and each section has a quick way to check. If something doesn't match what you see, tell us.

## Lightroom Classic {#lightroom-classic}

- **New photos:** import them as usual. Lightroom reads the keywords, the keyword tree, the title, caption and rating from the file or from the `.xmp` sidecar beside a RAW.
- **Photos already in your catalog:** select them and choose **Metadata > Read Metadata from File**. Lightroom doesn't look again by itself.
- **The other direction:** switch on **Catalog Settings > Metadata > Automatically write changes into XMP** so your Lightroom edits reach the files and Lifer.
- **The Lifer plugin** adds a species keyword to selected photos and can send them to Lifer. See [Lifer for Lightroom Classic](./lightroom.md).

If a photo was changed in both apps, Lightroom shows a metadata conflict. Pick **Import Settings from Disk** to take what Lifer wrote.

## Apple Photos {#apple-photos}

Apple Photos has no sidecar files. It reads keywords, title, caption and location from inside a file when you import it, and ignores `.xmp` sidecars.

- **New photos:** JPEG, TIFF, PNG, DNG and HEIC files from your Lifer library carry their keywords inside, so importing them into Photos brings the keywords along. RAW files keep their keywords in a sidecar, which Photos doesn't see; import the JPEG instead.
- **Photos already in Photos:** select them in Lifer, or open an album, and choose **Send keywords to Apple Photos** from the menu. Lifer first looks for each photo in your Photos library and tells you how many it found. Nothing changes until you choose **Add keywords**.

What Send keywords does:

- It adds the species' common and scientific names and your tags as keywords. Keywords already in Photos stay, and nothing is removed.
- It finds each photo by its original file name and the time it was taken. A photo that isn't in your Photos library is skipped, never imported.
- The first time, macOS asks whether Lifer may control Photos. If you said no, open **System Settings > Privacy & Security > Automation**, turn on **Photos** under **Lifer**, and try again.
- Photos opens if it isn't running. A big selection takes a while; you can close the window and keep working.

Send keywords to Apple Photos is in the Lifer desktop app on a Mac only. It doesn't show on Windows, Linux, or a Lifer server in a browser.

## Folders {#folders}

Any app that reads XMP or IPTC keywords sees what Lifer writes, with nothing to set up. A plain file browser such as Finder or Explorer shows keywords for JPEG files in its info panel. Sidecar `.xmp` files stay next to their RAW files: when you move or copy a RAW, move its `.xmp` too.

## Adobe Bridge {#adobe-bridge}

Bridge reads the keywords, the title, the caption and the rating, from the file, or from the `.xmp` sidecar beside a RAW (`IMG_0001.xmp`, the name Bridge itself uses).

- In **Preferences > Keywords**, turn on **Read Hierarchical Keywords** so the `Species` tree shows nested in the Keywords panel.
- If a folder was already open when Lifer wrote, choose **View > Refresh** or purge the folder's cache from **Tools > Cache**.

## Adobe Photoshop {#adobe-photoshop}

Photoshop doesn't manage keywords, but it keeps the ones in a file.

- Open a JPEG, TIFF, PNG or DNG and choose **File > File Info** to see the title, keywords and caption.
- A RAW file opens in Camera Raw, which reads the `.xmp` sidecar beside it.
- To browse and search by keyword, use Bridge.

## DxO PhotoLab {#dxo-photolab}

PhotoLab keeps its own settings in `.dop` files and keeps its keywords in its database. Its XMP support is narrower than Adobe's.

- It reads star ratings, creator and copyright, and location from XMP, and it can read and write keywords in the file for JPEG and TIFF.
- For RAW files, we couldn't confirm which sidecar name it reads. DxO's own users report that PhotoLab can't read keywords from `.dop` files made by other tools, and that it ignores colour labels.
- If keywords don't appear for a RAW file, set **Sidecar names for RAW files** to **Both** and choose **Update existing photos**, or export a JPEG from Lifer, since keywords inside a JPEG are the most reliable route.

**How to check:** pick one JPEG and one RAW photo that Lifer has identified, open their folder in PhotoLab's PhotoLibrary, and look at the keywords in the metadata panel. If the JPEG shows them and the RAW doesn't, try **Both** sidecar names. Tell us what you find, so this page can say for sure.

## Peakto {#peakto}

Peakto searches and organizes photos from many apps, and can exchange keywords through XMP sidecars.

- In Peakto's **Preferences > Sync**, set **XMP round trip** to **Automatic**. This works for folders Peakto watches, so add your Lifer library folder as a watched folder.
- It also reads Lightroom Classic catalogs, so keywords you added there arrive that way.
- If both Peakto and Lifer changed the same field, one of them wins. Peakto's own guide says that with Bridge, Bridge wins.
- A user reported a conflict when Peakto and Lightroom both write the same sidecars. If you use all three apps, let only one of them write back.

**How to check:** add your Lifer library folder in Peakto, wait for it to scan, then search for a species you have photos of. If nothing shows up, check that XMP round trip is on, and tell us.

## Google Photos

Google Photos has no way to add keywords to photos already in it, so it isn't supported.

## What works and the options {#options}

All of these are in **Settings > Metadata > Where keywords go**. After changing one, choose **Update existing photos** so photos already in Lifer follow it.

- **Sidecar names for RAW files:** `IMG_0001.xmp` (the default, read by Lightroom, Bridge and Camera Raw), `IMG_0001.CR3.xmp` (digiKam and Capture One), or **Both**. With **Both**, Lifer keeps the two files the same, and moving, renaming or deleting a photo in Lifer takes both with it. Lifer reads either name.
- **Write keywords inside photo files:** on by default for JPEG, TIFF, PNG, DNG, WebP, HEIC, AVIF and JPEG 2000. Writing inside a file changes its modified date and checksum; [archive health](./library-folders.md) expects these changes and never reports them as damage. Turned off, Lifer leaves those files untouched and writes `IMG_0001.JPG.xmp` beside each one instead. Lightroom and Apple Photos don't read a sidecar next to a JPEG, so they won't see keywords written this way; digiKam and darktable do. Keywords already inside a file stay there.
- **Also write keywords next to linked files:** off by default. Turned on, Lifer first counts what it would do, then puts a sidecar beside photos in [linked folders](./library-folders.md), with keywords and title only. The photos themselves never change. Lifer only updates sidecars it made: a sidecar another app made is left alone, and a photo on an unplugged drive is skipped.
- **Apple Photos:** Send keywords to Apple Photos, on a Mac. See [Apple Photos](#apple-photos).
