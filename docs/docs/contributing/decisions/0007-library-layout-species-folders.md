---
id: 0007-library-layout-species-folders
title: "ADR 0007: Photos filed into species folders"
description: Lifer moves the photos it manages into a readable folder tree by taxon and species.
---

# ADR 0007: Lifer files photos into species folders

**Status:** Accepted. Photos have gone into species folders since the earliest history (`b8015a9`, 2026-08-22); grouping by taxon became the default on 2026-08-29 (`a4d066f`), and the chosen folder became the library itself, without a `Lifer Photos` wrapper, on 2026-09-25 (`decf9fe`).

## Context

Photo managers either keep files where the user put them and index them, or take ownership and organise them. Lifer's users are often wildlife photographers with large libraries, who also use other tools.

## Decision

In store mode (the default), Lifer files each original into `[location/][Wildlife <year>/]<Taxon>/<Species>/<RAW|Adjusted|Video>/` inside the library, keeping the file's own name, and moves it when its species changes (`apps/api/src/uploads/organizedPath.ts`, `speciesFolderName.ts`, `common.ts`). Files can instead be linked in place, unmanaged, and Lifer then never moves or writes them. Details are in [Imports and metadata](../imports-and-metadata.md#where-files-go).

From `a4d066f`: "Every other browsing view in the app already groups by taxon, and it keeps a growing library navigable outside Lifer too (Finder, an external tool like Immich)." The by-year option was added in the first layout commit as "handy for importing into external libraries like Immich" (`b8015a9`).

## Alternatives considered

- **A flat `Lifer Photos/<species>/` layout** with no taxon level: the earlier default.
- **A `Lifer Photos` folder inside the chosen folder:** replaced in 0.8.0 ("The folder you choose for your library is now the library itself"); `adoptFlatLibraryLayout.ts` migrates older libraries at startup.
- **Leaving files in place:** supported as link mode and for trip source folders, but not the default.

## Consequences

Positive:

- The library is browsable and useful without Lifer.
- The folder names themselves help recovery: reimport uses the parent folder to break ties between species ([ADR 0006](./0006-database-primary-files-carry-recovery-copy.md)).

Negative:

- **Lifer moves files.** A species change, a species merge or split, or a change of naming style moves files on disk. Moves never overwrite (they use a hard link and unlink, or an exclusive copy), and a failed database change moves the file back, but other tools that remembered the old path lose it.
- Folder names depend on taxonomy and on the user's naming style; common names aren't unique, so a shared one gets the scientific name added, and characters invalid on Windows are removed.
- A layout change needs a migration of existing paths (`adoptFlatLibraryLayout.ts`, and **Reorganize existing photos now**).
- Files are filed into the library or the trip's destination when imported, but moved under the main library when their species changes later (`moveManagedOriginalToSpeciesFolder` uses `ORIGINALS_DIR`). How that should interact with trip destinations and drives is an open question.
