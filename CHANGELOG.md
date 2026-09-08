# Changelog

All notable user-facing changes to Lifer are recorded here, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style. This file is what actually reaches users — its `[Unreleased]` section gets extracted by
`.github/workflows/release.yml` into the GitHub release body for whatever tag you push, which is
exactly what the app's own update banners display (`AppUpdatesSection`'s `update.body`, and the
Docker/self-hosted release-notes link).

**Workflow**: as you land user-facing changes, add a bullet under `[Unreleased]` in the right
category. When you're ready to cut a release, rename `[Unreleased]` to the new version (matching
the git tag you're about to push, without the `v` prefix) and add today's date, then add a fresh
empty `[Unreleased]` section above it for whatever comes next.

Categories: `Added`, `Changed`, `Fixed`, `Removed` — omit any with nothing to say.

## [Unreleased]

### Fixed

- Docker/self-hosted deployments now bundle the species/region catalog into the image and
  restore it automatically on first start, instead of leaving the Offline Packs map and
  checklists blank until someone knew to click Settings > Species catalog updates.
- The catalog-update check and download no longer hang forever if the server's network can't
  reach GitHub — they now time out and show a real error instead of a permanently stuck
  "Updating..." message.
- Fixed a crash restoring the catalog on a genuinely fresh database (a foreign key violation on
  the self-referencing regions table, hit only on a truly empty install).
- Docker/self-hosted's "a newer version is available" notice no longer links to a dead Settings
  page (that update UI only exists on desktop) — it now links out to the release notes instead.
- The species catalog update now runs as a real background job instead of one long request —
  navigating away from Settings and back no longer strands it on "Updating..." forever with no
  way to tell whether it actually finished.
- Offline pack downloads no longer hang indefinitely if the connection to the pack host stalls.

## [0.4.0] - 2026-09-07

### Added

- Albums: create, rename, and delete albums; add photos to them from the gallery; share an album
  publicly via a link, no account required to view.
- API keys: generate scoped, revocable keys in Settings for programmatic access to your library.
- A target/wishlist list: mark a species you haven't found yet as one you're after, separate from
  collected/seen, and filter the collection view down to just your targets.
- Hotspot clusters and weekly sighting frequency per region/species: species detail now shows
  roughly where within a region a species is actually found (not just the province-wide tier) and
  a week-by-week chart of when it's typically recorded.
- iNaturalist sync: connect an account, push a confirmed capture as an observation, and pull its
  GPS back onto the matching photo.
- Central America is now its own continent grouping on the Offline Packs map, instead of being
  folded into North America.
- Desktop: an "Enable IP switching" option when connecting to a self-hosted server — store both a
  local-network address and an external (nginx-forwarded) one, and the app tries the local address
  first at every launch, falling back to the external one automatically when you're away from home.
- Species suggestions on import: uploading a photo now suggests likely species (learned from your
  own past photos and reference photos), narrowed to what's actually plausible for the region and
  season you're importing into. Marked experimental, with an off switch in Settings. A single
  certain match shows as "100% Match" and hides the rest.
- Near-duplicate detection: re-importing an edited or re-exported copy of a photo you already have
  (not just a byte-identical file) is now caught and flagged before import.

### Changed

- Import rows: picking a species now checks that row's box for import automatically; you can
  remove a row you added by mistake; you can click a photo's suggestion card to see a bigger
  version of the reference photo, and click back on an assigned species to reconsider it.
- The exact-duplicate warning now reads "Looks like you've already imported this photo before, do
  you want to import it anyway?" and, when there's a certain species match, hides the other
  (much less likely) suggestions entirely.
- Offline Packs' country picker is now pill-based: pick a continent to reveal its countries as
  unselected pills, with an explicit "Select all" (now also "Deselect all"), and a fully-downloaded
  country now shows as a solid green pill instead of a small dot.
- Offline update banners (app version + pack updates) are consolidated into one, and go quiet
  while offline instead of failing silently.
- Build a Trip now works like the rest of the app's import flow: drop in a batch of photos first,
  then assign each one to a species (individually or via multi-select), instead of picking one
  species at a time before you can upload anything.
- macOS window chrome now uses the OS's own native traffic lights, and the entire top of the
  window is draggable (not just the corner).

### Fixed

- A broken or missing gallery photo (species detail page) no longer breaks the photo viewer's
  back/forward navigation — it now shows a placeholder for just that one photo instead.
- Species reference photos that pointed at a file that didn't actually exist (a few hundred,
  found via an audit) are repaired; the app also now quietly re-fetches a reference photo from
  its original source the first time it notices the cached copy is missing, instead of leaving
  the page permanently blank.
- Offload confirmation for a pack now shows a real size estimate instead of "0 species, freeing
  0KB" when the pack predates per-species tracking.
- Clicking a country on the Offline Packs map now actually highlights it (a MapLibre id-typing
  issue silently broke this).
- Dozens of overseas territories (French Guiana, Hong Kong, Galápagos, and many more) no longer
  show up as their own fake "country" in the Offline Packs picker — they were duplicated data,
  now cleaned up.
- Species incorrectly flagged as vagrant in a region purely because GBIF's own record density was
  thin there (not because they're actually rare) are being corrected, cross-checked against real
  range data (GBIF's curated distributions, FishBase's country-status records) rather than raw
  occurrence counts alone.
- France's and Netherlands' overseas territories (Guadeloupe, Guyane, Martinique, Réunion,
  Mayotte, Bonaire/Saba/St. Eustatius) were missing their own real species data in the checklist
  recompute — GBIF tags their records with the territory's own country code, not the parent
  country's, so a country-level download never saw them.
- Swept all user-visible text for stray em dashes.

## [0.2.2] - 2026-08-20

Baseline entry — changelog tracking starts here; earlier history lives in git log and prior
release notes only.
