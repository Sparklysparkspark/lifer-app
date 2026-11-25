---
title: Metadata and file names
description: Write your copyright, title, caption and keywords into every photo, and choose how Lifer names photo files.
---

# Metadata and file names

**Settings** > **Metadata** sets what Lifer writes into your photo files, and **Settings** > **Library** sets how it names them, beside the folder layout. Everything here is optional: by default Lifer writes no copyright or caption and keeps each file's camera name.

## Copyright and credits

Fill in the fields you want written into each photo, like a stationery pad:

| Field                                             | Written as                                              |
| ------------------------------------------------- | ------------------------------------------------------- |
| **Creator**                                       | `dc:creator` (and IPTC By-line, EXIF Artist)            |
| **Copyright notice**, such as `© {year} Jane Doe` | `dc:rights` (and IPTC Copyright Notice, EXIF Copyright) |
| **Credit line**                                   | `photoshop:Credit`                                      |
| **Usage terms**                                   | `xmpRights:UsageTerms`                                  |

Click a variable button to insert it where the cursor is. The preview shows these fields for one of your own photos.

## Titles, captions and keywords

The next group, **Titles, captions and keywords**, fills four more fields from a template you write once:

| Field                      | What it is for                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| **Title**                  | The photo's title in other apps. By default it names every species in the photo.            |
| **Headline**               | A short summary line. Empty unless you add one.                                             |
| **Description or caption** | Longer text about the photo, such as `{species} ({scientific}), {place}, {date}`.           |
| **Extra keywords**         | Keywords added beside the species keywords Lifer already writes. Separate them with commas. |

Each template is text with **tokens** in it. A token is a piece Lifer fills in for each photo, and it shows as a chip. Type `{` or press **Insert** to pick one from the menu, which groups them as Taxonomy, Place and trip, Capture, and All species in a photo. To remove a chip, click it, or press Backspace or Delete next to it. The arrow keys move between the text and the chips. Typing a whole token such as `{species}` also turns it into a chip.

The tokens are:

| Token                                         | Fills in                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `{species}`, `{scientific}`, `{group}`        | The common name (or the scientific name when there is none), the scientific name, and the group such as Birds |
| `{genus}`, `{family}`, `{order}`, `{class}`   | The species' genus, family, order and class, such as `Pandion`, `Pandionidae`, `Accipitriformes`, `Aves`      |
| `{place}`, `{region}`, `{country}`, `{trip}`  | The place name, province or state, country and the trip's name                                                |
| `{date}`, `{longdate}`, `{year}`, `{month}`   | When the photo was taken, as `2026-05-03`, `3 May 2026`, `2026` and `05`                                      |
| `{camera}`, `{lens}`                          | From the photo's EXIF                                                                                         |
| `{focal}`, `{aperture}`, `{shutter}`, `{iso}` | From the photo's EXIF, as `500mm`, `f/7.1`, `1/2000s`, `800`                                                  |
| `{rating}`                                    | The star rating                                                                                               |
| `{names}`, `{count}`                          | Every species in the photo, named in your naming style, and how many species it shows                         |

A token with no value for a photo is left out cleanly, along with its comma or brackets: with no place name, `{species} ({scientific}), {place}, {region}` reads `Osprey (Pandion haliaetus), Alberta`. Wording in double square brackets is kept only when every token in it has a value: `An image of a {species}[[ with a {focal} {aperture}]]` reads `An image of an Osprey with a 500mm f/7.1`, or `An image of an Osprey` when the photo has no lens details. "a" before a token becomes "an" when its value starts with a vowel sound. The **Presets** menu beside the caption offers ready-made captions to start from.

### What happens when a photo already has a value

Under each template, choose a write rule:

- **Fill if empty:** writes only when the photo has nothing in that field yet.
- **Replace what Lifer wrote:** updates text Lifer wrote earlier and keeps anything typed in another app. This is the default.
- **Add to the end:** adds the text after whatever the photo already has.
- **Don't write:** leaves that field alone.

A value you or another app typed is never replaced by **Replace what Lifer wrote**, so editing a caption in Lightroom is safe.

**Name every species in a photo** decides what a photo with several species writes for `{names}` and `{count}`. Turn it off to name only the main species.

### Preview and applying

The preview at the bottom shows every field as it would be written for one of your photos, and follows what you type before you save. **Try another photo** shows a different one. With no photos yet, it uses a sample.

Lifer writes these the same way it writes species keywords: inside JPEG, TIFF, PNG, DNG, HEIC, AVIF and JPEG 2000 files, and into an `.xmp` sidecar for RAW files, videos and bare JPEG 2000 codestreams (`.j2k`, `.j2c`), which have no room for metadata. Only files Lifer manages are written; linked files are never changed.

- **When:** on import, and whenever a photo's species, place or region changes, so the text stays right.
- **Never overwritten:** a creator, copyright, credit or usage terms the file already has stays, unless you turn on **Replace existing creator and copyright**.
- **Apply to all confirmed photos** writes your details into photos already in your library. First it tells you how many photos it would update and how many it keeps because you edited them elsewhere, for example "Updates 1,200 photos, keeps 14 you edited elsewhere". Nothing is written until you confirm. It only changes files whose details differ, so running it again (or after stopping it) picks up where it left off.

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
