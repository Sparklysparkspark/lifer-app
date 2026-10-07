---
id: 0005-catalog-separate-from-user-data
title: "ADR 0005: Catalog data separate from user data"
description: Downloaded catalog tables never hold user data; what users add or change about the catalog lives in per-user tables updates don't touch.
---

# ADR 0005: Catalog data kept separate from user data

**Status:** Accepted. The seed has carried only catalog data since `b5de318` (2026-08-31), and catalog updates have merged without touching local photo paths since `e4e6a6f` (2026-09-01). The last user rows were moved out of catalog tables by migrations 124 to 126, which are in the next release.

## Context

Catalog updates and pack installs now remove checklist rows that the published data no longer lists, so that a wrong species can be corrected (CHANGELOG 0.9.0: "Updates used to only ever add species, so a wrong one stayed for good"). Users also change the catalog for themselves: they add species to a region's checklist, hide species, set their own rarity tiers, and add species from iNaturalist that the catalog lacks.

Before migration 124, a species a user added to a checklist was a row in the shared `region_species` table. From migration 124: "region_species is catalog data that a catalog update and every pack install prune and rewrite, so a row there could vanish on the next update, and removing one could take out a real catalog row." Migration 125 adds that such rows had "no 'Added by you' marker, and removing one deleted it for everyone on the server."

## Decision

Catalog tables (species, regions, checklists, sea zones, traits, rarity, photos, vectors) hold only published data and may be overwritten or pruned by any update. Everything a user adds or changes lives in separate tables keyed by `user_id`: `region_species_user_added`, `sea_zone_species_user_added`, `user_archived_species`, `region_species_hidden`, `user_tier_overrides`, plus `user_species` and the library tables ([Data model](../data-model.md#per-user-overlays-on-the-catalog)). Update paths write only catalog tables and the install's own state ([State and sync](../state-and-sync.md)).

Two narrow exceptions: a catalog update never overwrites the install's own photo file paths or a photo it fetched itself (`catalogSeedUpdate.ts`), and a species merge re-points user rows to the surviving species inside the update's transaction (`speciesMerges.ts`).

## Alternatives considered

- **User additions as flagged rows in the catalog tables** (the earlier design): rejected, because every prune or rewrite of catalog rows had to remember the flag, and one missed path lost user data.
- **Updates that only add, never remove:** the earlier behaviour; it couldn't correct errors.

## Consequences

Positive:

- A catalog update can replace catalog rows freely: an update can't erase something a user did.
- The catalog seed and packs are pure data, with nothing per user to strip before publishing.
- The user's overlays are small and easy to save next to the library ([ADR 0006](./0006-database-primary-files-carry-recovery-copy.md)).

Negative:

- Every query that shows a checklist joins the catalog rows with the user's additions, hides and overrides.
- Migration 125 couldn't tell which user added which species, so every user got a copy, and hand additions that matched an existing catalog row stayed in `region_species` indistinguishable from it.
- Other Taxa species are still rows in the shared `species` table, without an owner; they're kept out of published data by the seed builder and the publish gate rather than by the schema.
- Each new overlay table needs the collection-version trigger and a place in the collection-state file, or it silently goes stale or unrecoverable.
