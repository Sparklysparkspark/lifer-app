---
title: Data model
description: Lifer's database tables grouped by role, how they relate, and the rules that keep catalog data and user data apart.
---

# Data model

Lifer keeps everything in one PostgreSQL database. This page groups the tables by role and gives the relationships and rules you need before changing them. The full definitions are the numbered files in [`packages/data-pipeline/migrations`](https://github.com/Sparklysparkspark/lifer-app/tree/main/packages/data-pipeline/migrations); `M061` below means `061_*.sql`. A column is usually added by a later migration than the one that created its table, so search the folder for the column name.

The single most important split is between **catalog data**, which Lifer downloads and may replace, and **user data**, which only the user creates and nothing downloaded may overwrite. [State and sync](./state-and-sync.md) explains how each update path respects it, and [ADR 0005](./decisions/0005-catalog-separate-from-user-data.md) why.

## Core tables

```text
                         CATALOG (global, replaceable)                      USER (per user_id)
 ┌────────────┐      ┌──────────────────┐      ┌───────────┐
 │  regions   │◀─────│  region_species  │─────▶│  species  │◀──────────┬───────────────────────┐
 │ parent_id ─┼─┐    │ (region, species)│      │  gbif_key │           │                       │
 └────────────┘ │    └──────────────────┘      └───────────┘           │ species_id            │ species_id
       ▲        └─▶ regions (self)                   ▲  ▲         ┌────┴──────────┐      ┌─────┴────────┐
       │                                             │  │         │ captures_all  │      │ user_species │
 ┌─────┴──────────────────────┐   species_traits ────┘  │         │ fingerprint   │      │ (user,species│
 │ region_species_user_added  │   species_rarity        │         │ deleted_at    │      │  state,cover)│
 │ (user, region, species)    │   species_reference_    │         │ hidden_at     │      └──────────────┘
 └────────────────────────────┘     photos              │         │ trip_id ──────┼──▶ trips
                                    species_synonyms ───┘         └──┬─────────┬──┘
 ┌──────────┐   ┌──────────────────┐                                  │         │
 │sea_zones │◀──│ sea_zone_species │──▶ species              photos ◀─┘         └─▶ originals
 └──────────┘   └──────────────────┘                     (derivatives)          (file on disk,
                                                                                  RAW/JPEG/video)
 downloaded_packs ◀── pack_species ──▶ species          albums ◀── album_captures ──▶ captures_all

 users ◀── sessions, api_keys, user_inaturalist_accounts         albums ◀── shared_links
```

Every user table carries `user_id REFERENCES users ON DELETE CASCADE`. Catalog tables have no `user_id`.

## Catalog

Global rows, built by the [data pipeline](./data-pipeline.md) and delivered by the catalog seed and region packs, never by migrations.

| Table | What it holds | Key and rules |
|---|---|---|
| `species` (M001) | One row per species: names, taxonomy, eBird and iNaturalist ids, reference photo and description with their credits, local file paths of the cached photo | PK `id` (uuid); `gbif_key` unique. CHECKs require a credit whenever a photo or description is set. `genus` is a generated column. `is_other_taxa` (M089) marks species a user added from iNaturalist (below). `photo_withheld` (M123) marks species whose photo can't be redistributed. |
| `species_traits` (M001) | Habitat, population, endemism, extinction, occurrence counts, IUCN status | PK = FK `species_id`, cascade. IUCN status lives only here since M129, with CHECKs on its code and source. |
| `species_rarity` (M001) | Each species' worldwide rarity tier and the scores behind it | PK = FK `species_id`, cascade. Tier names are fixed by a CHECK (M119). |
| `species_reference_photos` (M003) | The gallery of reference photos per species | Unique `(species_id, photo_url)`. |
| `species_synonyms` (M053) | Other names for a species, from Catalogue of Life, iNaturalist, eBird or a merge | `synonym_name` is unique across the whole table, so a name points at one species only. |
| `species_search_names` (M111) | Normalised names for search | Derived: kept current by triggers on `species` and `species_synonyms`. Don't write to it. |
| `species_merges` (M113) | `old_species_id → new_species_id` for duplicates the pipeline merged | `old_species_id` has no FK on purpose: the old row is deleted once applied. |
| `species_splits` (M118) | Parent and daughter species after a taxonomic split | Both FKs cascade. |
| `regions` (M001) | World, continents, countries, provinces, with outlines and external codes | Self-referencing `parent_id`. Unique `(name, parent_id)` (M049). `nearby_sea_zone_ids uuid[]` links a region to its sea zones. |
| `region_species` (M001) | A region's checklist: frequency, seasonality, local tier, vagrant and introduced flags | PK `(region_id, species_id)`, both cascade. Holds catalog rows only (see M125). |
| `sea_zones`, `sea_zone_species` (M019) | Marine areas and their species | Unique zone `name`; checklist PK `(sea_zone_id, species_id)`. |
| `reference_photo_blocklist` (M106) | Photo URLs that must never be shown | PK `photo_url`. |
| Vector tables (M058, M101, M102, M105) | Image and text vectors per species and reference photo, for CLIP and BioCLIP 2 | Plain `real[]` with a `model_version` column; no pgvector. |

Some catalog-side tables are maintainer inputs that the seed doesn't ship: `region_species_manual_overrides`, `region_group_effort`, `region_unmatched_taxa`, `species_nonnative_countries`. `region_species_hotspots` reaches installs through packs.

## User library

| Table | What it holds | Key and rules |
|---|---|---|
| `captures_all` (M002, renamed in M061) | One row per photo or video the user has: species, time, place, camera fields, rating, tags, cull marks | `species_id` → `species` with no `ON DELETE` (a species with captures can't be deleted). `fingerprint` is the SHA-256 of the file. `tags text[]` (M098); there is no tags table. `trip_id` and `region_id` are `SET NULL` on delete. |
| `captures` (view) | `SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL` (M130) | What almost all code reads. See [Trash and hidden photos](#trash-and-hidden-photos). |
| `photos` (M002) | The displayable versions of a capture: paths to `display`, `thumb` and video preview derivatives, size, kind | `capture_id` cascades. `captures_all.current_photo_id` points at the shown one. |
| `originals` (M007) | The actual files: a RAW, JPEG or video, by path, S3 key or Immich id | Unique `(capture_id, kind)`. `managed` says whether Lifer filed the file and may move or write it. `content_hash`, EXIF fingerprints for RAW pairing, `volume_id` for external drives. `capture_id` is nullable: an unpaired RAW can wait for its JPEG. |
| `capture_species` (M021) | Extra species in the same photo | PK `(capture_id, species_id)`. |
| `user_species` (M002) | The user's relationship with a species: `state` (`collected`, `seen` or none), target flag, cover photo and card crop, first collected date, best rating | PK `(user_id, species_id)`: at most one row per user and species. |
| `albums`, `album_captures` (M071) | Albums and their photos | `album_captures.capture_id` references `captures_all`, not the view; trashed photos are filtered in queries. |
| `trips` (M046) | A trip: its source folder, destination folder (M112), cover | A capture belongs to at most one trip, through `captures_all.trip_id`. |
| `storage_volumes` (M050, M104) | External drives (per user) and server library roots (per install) | A CHECK enforces the two shapes: a drive has a user and no path; a root has a path and no user. |
| `capture_migrations` (M033) | Which captures were sent to which server by the desktop migration | PK `(capture_id, server_url)`. |
| `ignored_library_files` (M063) | Files the user told reimport to skip, by content hash | Unique `(user_id, content_hash)`. |

There's no encounters table. Encounters are computed when needed by `apps/api/src/lib/clusterEncounters.ts` (captures less than 60 minutes apart form one encounter).

### Trash and hidden photos

Trashing sets `captures_all.deleted_at`; a cull reject imported as hidden sets `hidden_at` (M130). The `captures` view leaves both out, so ordinary queries never see them. Code reaches past the view to `captures_all` only on purpose: trash and restore (`apps/api/src/captures/trash.ts`, which also purges with `DELETE FROM captures_all`, since a delete through the view would miss trashed rows), hidden photos (`captures/hidden.ts`), and the few places that must include hidden photos, such as writing file metadata (`uploads/xmpSidecarSync.ts`), moving and reorganizing files (`uploads/managedFolders.ts`, `settings/routes.ts`), and serving the owner's own photo files (`photos/routes.ts`, which includes trashed ones too, for the Trash page).

**When you add a column to `captures_all`, drop and recreate the view in the same migration.** A `SELECT *` view keeps the column list it was created with (M098 and M130 show the pattern).

## Per-user overlays on the catalog

These tables change how the shared catalog looks to one user without touching it, so a catalog update can't erase them:

| Table | Effect |
|---|---|
| `user_archived_species` (M037) | Hides a species everywhere for this user. |
| `region_species_hidden` (M100) | Hides a species in one region's checklist. |
| `user_tier_overrides` (M115) | The user's own rarity tier for a species, in one region or everywhere (`region_id` NULL). Unique on `(user_id, COALESCE(region_id, zero uuid), species_id)`. |
| `region_species_user_added` (M124) | A species the user added to a region's checklist. |
| `sea_zone_species_user_added` (M126) | The same for a sea zone. |

Before M124, user additions were rows in `region_species`, where a catalog update could overwrite or prune them. M125 moved them out. Additions that matched an existing catalog row couldn't be told apart and stayed in `region_species` (see the comment in M125).

**Other Taxa species** are a partial exception. A user can add any species from iNaturalist (`apps/api/src/species/otherTaxa.ts`); it becomes a row in the shared `species` table with `is_other_taxa = true`, with no `user_id`. Which user "has" it is recorded only by their captures, `user_species` and checklist additions. The catalog seed never includes these rows (`build-catalog-seed.ts` removes them before dumping), so a catalog update doesn't touch them.

Per-user preferences are columns on `users` (photo folder organisation, species naming styles, suggestions on or off, and so on).

## Packs and install state

| Table | What it holds |
|---|---|
| `downloaded_packs` (M034) | Installed region packs: PK `pack_id`, `content_version` (M045) for skipping unchanged packs, the provinces applied (M056). |
| `pack_species` (M054) | Which species each pack brought, and whether it supplied their photos (`provided_enrichment`). Removing a pack uses it as a reference count. |
| `install_settings` (M103) | Key and JSON value per install: the catalog seed version, whether to fetch withheld photos, the versions of installed vector sets. |
| `inat_server_config` (M075) | One row (`id boolean PRIMARY KEY CHECK (id)`): the iNaturalist client id and redirect URI. No client secret. |

Pack photos have no table of their own: their state is the path columns on `species` and `species_reference_photos`, which point into `APP_DATA_DIR`.

## Auth

| Table | Key and rules |
|---|---|
| `users` (M002) | Unique `email`; `password_hash` is Argon2id. The app allows one account per server (`/auth/register` refuses once a user exists); the desktop app creates `local@lifer.app` automatically. |
| `sessions` (M002, M109) | `id` is the SHA-256 of the cookie token, never the token. `expires_at` indexed for the daily cleanup in `lib/maintenance.ts`. |
| `api_keys` (M072) | `key_hash` (SHA-256, unique) and `permissions text[]`, the scopes. |
| `shared_links` (M071, M132) | A share of one album: unique `token_hash`, the SHA-256 of the link's token, which is how a link is found; `token_encrypted`, the owner's copy for the share list, encrypted with the server's key (`lib/secretBox.ts`); `token` is only set on rows from before M132 until the API's next start encrypts it. Optional `password_hash`, `expires_at`, `revoked_at`, download and metadata flags. |
| `user_inaturalist_accounts` (M075) | OAuth tokens for posting observations, encrypted with the server's key (`inaturalist/tokenStore.ts`). `capture_inaturalist_observations` records which capture became which observation (unique `capture_id`). |

The schema is multi-user throughout (every user table has `user_id`) even though the app creates one account. Don't rely on it as an isolation boundary: it hasn't been built or tested as one. See [Security model](../security-model.md).

## Caches and bookkeeping

- `gbif_response_cache` (M040), `inat_response_cache` (M055): raw API responses keyed by URL. Safe to empty.
- `collection_data_version`: a sequence, not a table. Statement-level triggers on the species, checklist, capture and overlay tables bump it on every change (M111, M121, M124, M126). `GET /collection` uses it in its ETag (`apps/api/src/collection/routes.ts`). **A new table that changes what the collection page shows needs the trigger too**, or browsers keep showing a stale page.
- `schema_migrations`: applied migration file names, created by `packages/data-pipeline/src/migrate.ts`.
- `pipeline_runs` (M115): the maintainer pipeline's stage log. Unused by installs.

Two leftovers, `scan_roots` (M013, replaced by trips in M046) and `users.catalog_seed_version` (moved to `install_settings` in M103), were dropped in M131.

## Invariants to keep

- **Catalog tables never hold user data, and user tables never hold catalog data.** User-made rows go in the overlay tables. The publish gate fails if a user's Other Taxa species ends up in a pack.
- **Catalog species ids are stable across installs.** Seeds, packs and the photo store are keyed by the same `species.id`, and updates upsert on it. A catalog species that disappears upstream is merged (`species_merges`), never just deleted, because captures and `user_species` reference it with no cascade.
- **One `user_species` row per user and species.** Merges fold two rows into one (`packages/core/src/species/speciesMerges.ts`).
- **Files are referenced, not stored.** `originals.ref` is a path, S3 key or Immich id; `photos` paths point into `APP_DATA_DIR`. The database never holds image bytes.
- **Duplicates aren't prevented by the schema.** `captures_all (user_id, fingerprint)` is indexed but not unique; the import flow detects duplicates and asks (see [Imports and metadata](./imports-and-metadata.md#duplicates)).
- **Foreign keys without `ON DELETE`** (`captures_all.species_id`, `captures_all.current_photo_id`, `user_species.species_id`, `user_species.cover_photo_id`, `albums.cover_photo_id`) block deletes deliberately. Clear or re-point the reference first.

## What the catalog seed contains

`packages/data-pipeline/src/scripts/build-catalog-seed.ts` dumps exactly these tables, data only: `species`, `species_reference_photos`, `species_traits`, `species_rarity`, `species_synonyms`, `species_merges`, `species_splits`, `regions`, `region_species`, `sea_zones`, `sea_zone_species`, `reference_photo_blocklist`. It blanks local file paths and removes Other Taxa rows first. Vectors ship as separate binary files. Everything else in the database is either user data or install state, and no download writes to it.
