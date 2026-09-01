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

### Added

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

## [0.2.2] - 2026-08-20

Baseline entry — changelog tracking starts here; earlier history lives in git log and prior
release notes only.
