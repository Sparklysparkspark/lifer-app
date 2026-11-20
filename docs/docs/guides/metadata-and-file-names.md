---
title: Metadata and file names
description: Write your copyright and a caption into every photo, and choose how Lifer names photo files.
---

# Metadata and file names

**Settings** > **Metadata** sets what Lifer writes into your photo files, and **Settings** > **Library** sets how it names them, beside the folder layout. Everything here is optional: by default Lifer writes no copyright or caption and keeps each file's camera name.

## Copyright and captions

Fill in the fields you want written into each photo, like a stationery pad:

| Field                                                                      | Written as                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Creator**                                                                | `dc:creator` (and IPTC By-line, EXIF Artist)                |
| **Copyright notice**, such as `© {year} Jane Doe`                          | `dc:rights` (and IPTC Copyright Notice, EXIF Copyright)     |
| **Credit line**                                                            | `photoshop:Credit`                                          |
| **Usage terms**                                                            | `xmpRights:UsageTerms`                                      |
| **Caption**, such as `{species} ({scientific}), {place}, {region}, {date}` | `dc:description` (and IPTC Caption, EXIF Image Description) |

Click a variable button to insert it where the cursor is. The preview shows the caption for one of your own photos.

| Variable                      | Fills in                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `{species}`                   | The common name, or the scientific name when there's none  |
| `{scientific}`                | The scientific name                                        |
| `{group}`                     | The group, such as Birds                                   |
| `{place}`                     | The place name                                             |
| `{region}`                    | The province or state                                      |
| `{country}`                   | The country                                                |
| `{date}`, `{year}`, `{month}` | When the photo was taken, as `2026-05-03`, `2026` and `05` |
| `{trip}`                      | The trip's name                                            |
| `{camera}`, `{lens}`          | From the photo's EXIF                                      |
| `{rating}`                    | The star rating                                            |

A variable with no value for a photo is left out cleanly, along with its comma or brackets: with no place name, `{species} ({scientific}), {place}, {region}` reads `Osprey (Pandion haliaetus), Alberta`.

Lifer writes these the same way it writes species keywords: inside JPEG, TIFF, PNG, DNG and HEIC files, and into an `.xmp` sidecar for RAW files and videos. Only files Lifer manages are written; linked files are never changed.

- **When:** on import, and whenever a photo's species, place or region changes, so the caption stays right.
- **Never overwritten:** a creator, copyright, credit or usage terms the file already has stays, unless you turn on **Replace existing creator and copyright**. A caption typed in another app is never replaced.
- **Apply to existing photos** writes the details into photos already in your library. It only changes files whose details differ, so running it again (or after stopping it) picks up where it left off.

## File names

**Settings** > **Library** > **Name new photos** chooses how imported files are named. The example under it shows the name one of your photos would get:

- **Keep original name** (the default): the camera's name, like `IMG_4411.jpg`.
- **Date, species, number**: `2026-05-03_Osprey_0012.jpg`
- **Species, date, number**: `Osprey_2026-05-03_0012.jpg`
- **Custom**: your own template, using the variables above plus `{seq}` and `{original}`.

`{seq}` is a running number, counted for each name in a folder, so each day's photos of a species number from `0001`. `{original}` is the camera's file name; Lifer records it in the file when it renames one (XMP `PreservedFileName`), so it still means the camera's name later.

Names are made safe for every operating system, keep their extension, and stay well within file name length limits. A photo's RAW file and video get the same name as the photo. A name that's already taken gets `-2`, `-3` and so on, so nothing is ever overwritten.

The template applies to new imports. To rename photos already in your library, use **Settings** > **Library** > **Reorganize**: it renames files as it moves them, with the same rules. It only touches files Lifer manages, skips drives that aren't connected, keeps sidecars with their files, and leaves files that already follow the template alone.

A RAW file imported on its own, before its JPEG, keeps its camera name so Lifer can still pair it with the JPEG later.

## Sensitive species

**Hide locations of sensitive species** keeps the exact places of threatened species off your share links. See [Sensitive species](albums-and-sharing.md#sensitive-species).
