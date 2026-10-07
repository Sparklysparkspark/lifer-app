---
id: 0006-database-primary-files-carry-recovery-copy
title: "ADR 0006: Database primary, files carry a recovery copy"
description: The database is the source of truth, and Lifer writes enough into the photo files and small .lifer files to rebuild most of a library without it.
---

# ADR 0006: The database is the source of truth; files carry a recoverable copy

**Status:** Accepted. Lifer has written species tags into files since its first commits, XMP sidecar sync since `a5be968` (2026-09-14), and the collection-state file since `380a6fb` (2026-09-25).

## Context

The photos are the irreplaceable part of a Lifer library, and they're ordinary files in an ordinary folder ([ADR 0007](./0007-library-layout-species-folders.md)). The database holds what Lifer knows about them. Users lose databases (a reinstall, a missing backup, a server move), and they use other photo editors, culling tools and library managers on the same files.

## Decision

The database is authoritative. Lifer also writes a recoverable subset into the library:

- species keywords, title, rating and the photo's own tags into each file it manages, or an XMP sidecar for RAW and video (`apps/api/src/uploads/exif.ts`, `xmpSidecarSync.ts`);
- the collection state that photos can't express (seen species, targets, archived and hidden species, tier overrides, checklist additions) in `.lifer/collection-state.json`;
- album membership in `.lifer/albums.json`, and trip photo species in the trip's `.lifer/index.json`.

These are read back only to fill an empty database, by reimport and at startup ([State and sync](../state-and-sync.md#reimport)). When they disagree with the database, the database wins.

The reasons are in the code: species tags are "embedded in the file so they travel with it" (`exif.ts`); the collection state is kept "so a fresh install pointed at the library gets them back. Stored by name (ids differ between installs)" (`collectionState.ts`). Writing stops at files Lifer manages: "a linked file isn't Lifer's to modify" (`exif.ts`). Camera fields are never copied into a sidecar, because some photo editors treat a sidecar's capture time as an override, so a copy could shift it (`exif.ts`).

## Alternatives considered

- **Files as the source of truth**, with the database as a rebuildable index: rejected, for two reasons.
  - Most of what Lifer knows doesn't fit in photo metadata: life lists and checklists, encounters, the per-user overlays on the catalog (hidden and archived species, tier overrides, checklist additions), trips, settings, and data for more than one user. Photo metadata describes one file, not relationships between photos, species and regions.
  - Other applications edit the same files, and they can write the same fields in conflicting ways. If the files were authoritative, every such edit would silently change Lifer's records. With the database authoritative, Lifer decides what its records are, and the files carry a copy that's read only for recovery.
- **Database only:** a lost database would lose every species identification.

## Consequences

Positive:

- Species identifications travel with the photos into other tools and survive losing the database.
- A fresh install pointed at an old library rebuilds most of it with **Reimport library**.

Negative:

- **Lifer modifies users' files.** Only managed files, and only Lifer's own tags, but the modification time changes on every write, which backup and sync tools see as a change.
- **Two copies can drift.** Writes happen in the background after the database commits, failures are logged and not retried until the next change, and the collection-state file is debounced, so the last few seconds of changes can be lost. Files are a best-effort copy, not a guarantee.
- **The recovery is partial.** Trips, covers, settings, accounts and share links still need a database backup ([Backup and restore](../../install/backup-restore.md)).
- Matching by name on recovery depends on names: a renamed species or region may not be found and is reported rather than guessed.
