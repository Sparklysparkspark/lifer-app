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

## [0.5.7] - 2026-09-24

### Changed

- The species catalog download is much smaller (about 60 MB instead of 1.2 GB), so installers and
  app updates shrink back to a normal size. The per-photo species reference vectors that make
  suggestions accurate now download automatically right after the species-matching model, as a
  second step of that same download, and refresh with each catalog update.
- Species catalog updates in Settings now show real progress, can be cancelled, resume an
  interrupted download instead of starting over, and apply all at once: if anything goes wrong
  partway, the catalog is left exactly as it was. The update check is now per install, so a
  second account no longer sees an update that's already been applied.
- Long-running downloads and jobs (catalog, map, species-matching model, packs, server migration,
  library recovery, trip scans and imports) share one progress display with consistent sizes,
  steps, and Cancel/Retry buttons.
- In-app update notes now show this changelog instead of a link.

### Fixed

- App updates stopped reaching anyone after 0.5.5: one platform's build failed, which kept the
  update information for every platform from being published. A failed platform no longer
  blocks the others, and a release only becomes "latest" once its update information exists.
- Update failures now show the real reason. On macOS, Lifer tells you when it's running from a
  temporary location (move it to Applications) and offers the download when macOS blocks the
  in-place update.
- Downloads (catalog, map, model, packs) no longer give up on slow but working connections, and
  no longer crash or hang when the connection drops.
- Security: remote pages loaded in the desktop app no longer get access to your files or the
  ability to run programs, the local server rejects requests from other sites, offline packs can't
  read files outside their folder, share-password and login limits can't be bypassed, and links
  only open in the browser if they're web or email links.
- "Delete local library" after moving to a server now refuses if any photo wasn't actually
  transferred.
- Fixed: switching modes in Settings could crash the app; Settings "Sign in", "Use current
  connection" and the server reachability check always failed; a bad saved server address left
  the app stuck on the splash screen; a quick relaunch or force-quit could leave the app unable
  to start; photo download from the desktop app did nothing.
- Species folders for species with several alternate names no longer create nested folders, and
  folder names that end in a dot or space work on Windows.
- Uploading several duplicates at once could freeze the upload queue.
- Download filenames with non-Latin characters, video-seek requests near the end of a file,
  "Reveal in folder" on Windows and Linux, and RAW files for species-scoped captures.
- Drives whose name contains a space, and importing a trip from the root of a drive.
- Republished `catalog-latest`: the version live since 2026-09-22 had an incomplete Canada
  checklist (902 of 2,056 species) from a recompute that wasn't followed by a fresh seed publish.
  It likely affected every country's checklist proportionally, not just Canada's, on any install
  that bootstrapped or updated from that version.

## [0.5.5] - 2026-09-23

### Changed

- Downloading the offline basemap in Settings no longer shows a redundant confirmation popup —
  the button's own label and description already say exactly what it does.

### Fixed

- The published species catalog seed no longer includes Other Taxa species (Settings > Species
  & Import's any-taxa search) added on whichever machine last built it. Those are meant to be
  personal, install-specific additions, but the seed's underlying dump had no way to exclude
  them, so one added while testing the feature could ride along into every fresh install's
  catalog — confirmed live with a bumble bee, added once on a dev machine, showing up in an
  unrelated freshly-wiped install's Canada checklist. Offline packs were never affected by this;
  only the catalog seed was.
- Species-matching suggestions could come back inconsistent between machines for the same photo
  (confirmed live with a Cedar Waxwing scoring a confident #1 match on one install and missing
  from the top 5 entirely on another) — quantized model inference isn't guaranteed bit-identical
  across CPU architectures, and two separate spots in the matching pipeline were sensitive enough
  to that tiny variance to flip results: the subject-detection step could fall on either side of
  its confidence threshold and skip cropping to the animal entirely, and the suggestion list could
  drop a genuinely close alternative based on its rank position rather than how close its actual
  score was to the top pick.

## [0.5.4] - 2026-09-23

### Changed

- The species-matching model (used for import suggestions and Gallery content search) now
  unloads from memory after 15 minutes of inactivity instead of staying resident for the entire
  life of the server process — meaningful on a self-hosted install that isn't always actively
  matching photos. Reloads automatically, with no user action needed, the next time it's used.

### Fixed

- The Species catalog updates section in Settings now shows the same loading spinner used
  everywhere else in the app while checking for or applying an update, instead of plain text.
- Fixed a crash ("duplicate key value violates unique constraint
  species_reference_photos_species_id_photo_url_key") applying a species catalog update on any
  install with reference photos that arrived via a downloaded offline pack rather than the
  original catalog seed — which, after normal use, is most of them.

## [0.5.3] - 2026-09-23

### Changed

- The first-run setup screen's taxon-group picker now matches Offline Packs' own picker exactly
  (including the Marine Invertebrates/Reptiles & Amphibians groupings), instead of a simplified
  version that looked like a different feature.
- Settings' "species-matching model isn't downloaded" notice now links straight to Offline Data
  instead of vaguely pointing at a "section below" that isn't even on the same page.

### Fixed

- The first-run setup screen's in-progress download card no longer uses mismatched colors that
  made the progress bar nearly invisible against its own background.
- Opening the Getting Started guide from first-run setup and then going back no longer drops you
  on Collection with a misleading "Settings" label — it now returns you to setup.
- Applying a downloaded pack no longer copies reference photos one file at a time — file copies
  now run concurrently, and a further fix ensures a species' photo path is never recorded as
  ready before the actual file has finished copying.
- Fixed the same "thousands of one-at-a-time database writes" problem in gap-finder hotspot data
  that the previous release fixed for the rest of a pack's checklist — this was the remaining
  cause of a pack still taking many minutes to apply even after that fix.
- A one-time cleanup script removes leftover stale `collector_shells`/`crocodylia` entries from
  the published offline-pack catalog (merged into other taxon groups a while back, but never
  actually removed from the index).
- Applying a pack no longer risks leaving a checklist half-written if the server restarts
  mid-apply (a redeploy, a container running out of memory) — a pack's checklist now either
  fully applies or leaves nothing behind to retry, instead of silently committing whatever had
  finished at the moment of interruption.

## [0.5.2] - 2026-09-23

### Added

- The first-run setup screen's region-download step now lets you narrow to specific taxon groups
  (birds, mammals, reptiles, etc.) instead of always fetching every group for your chosen
  country/countries.

### Fixed

- Collection's "couldn't load this view" error now shows as a proper styled message with a Retry
  button instead of a single plain, oddly-formatted sentence.
- The first-run setup screen's offline-map download step now shows the same spinner used
  everywhere else in the app instead of plain "Downloading…" text.

## [0.5.1] - 2026-09-22

### Added

- Collection page: a "found in year X" filter, using every calendar year you've actually
  captured a species in (not just the year you first found it) — useful for a "big year" style
  check.
- Offline Packs: a Cancel button while a download is in progress, instead of only being able to
  wait it out.

### Changed

- Empty states across Gallery, Trash, Albums, API Keys, the iNaturalist tabs, and species detail
  now match the rest of the app's styled icon + message pattern instead of a single plain
  sentence.
- Settings now shows your library's data directory (useful on Docker/self-hosted to confirm which
  volume is actually mounted) and, if an in-app update install fails, points you at a manual
  download plus the exact steps macOS/Windows need to approve it.
- Desktop's in-app auto-update now covers Windows and Linux (AppImage) as well as macOS, instead
  of only prompting Mac users to update in-app.

### Fixed

- Applying a large offline pack (e.g. a big country) no longer sits for a long time with the
  progress bar barely moving — writes are batched instead of one at a time.
- A downloaded offline pack no longer disappears from the Offline Packs page if it briefly drops
  out of the published catalog.
- Collection's "Most likely this month" sort/filter now actually reflects the current month —
  it silently stopped returning any signal from April onward.
- Species enrichment no longer permanently records "no photo found" for a species when
  iNaturalist was just temporarily rate-limiting requests.
- The catalog update (Settings > Species catalog updates) no longer fails once the bundled
  reference-photo/text embeddings push it past a size limit.
- Reassigning or moving a photo's species no longer leaves an empty, orphaned folder behind on
  disk.

## [0.5.0] - 2026-09-18

### Added

- Offline packs now offer a "small" download variant that skips reference-photo galleries
  (checklist and auto-suggest embeddings are still included) for a much smaller download —
  gallery photos still fetch on demand once you're online.
- Species auto-suggest now stores an embedding for every gallery photo, not just a species' one
  main reference photo, so a real photo taken from a different angle or pose can still match
  confidently.
- Import: species suggestions can now be assigned entirely from the keyboard — Enter accepts the
  highlighted suggestion and moves to the next photo, arrow keys pick a different suggestion
  first, and Up undoes the previous photo's pick if you hit Enter on the wrong one.
- Setting one of your photos as a species' featured image now centers the default crop on the
  actual animal (using the same object-detection model species auto-suggest uses) instead of a
  plain center crop.

### Changed

- Species auto-suggest accuracy: photos are now cropped to the detected subject before matching
  (with a tiled fallback pass for small or distant subjects), blended with a zero-shot text
  signal, and gated by a data-derived confidence margin instead of a flat score cutoff — plus
  low-relevance trailing suggestions and species with no displayable photo no longer show up in
  the list.
- Collection's "Hide rarity labels" toggle is now "Hide labels" and also hides Endemic, Vagrant,
  Ghost, Lost, and Rediscovered badges, not just the rarity tier ones.
- Albums and Trips' empty states and Albums' card badges now match the rest of the app's visual
  style instead of being a single plain sentence.
- Settings is now organized into a left-hand sidebar (General, Account, Species & Import,
  Library, Storage, Server, Integrations, Offline Data) instead of one long scrolling page.
- Account/logout moved off the main nav bar into a small account-icon menu, matching how API
  keys were already moved into Settings for the same reason.
- The Offline Packs country picker and the import flow's region picker now share one component
  instead of two independently-built ones.
- First launch now walks through an explicit setup: choose whether to download the offline map
  (with its real size shown), then pick at least one region to build your checklist for — no
  more landing on an empty Collection page not knowing where to start.
- Desktop's "Enable IP switching" is now "Automatic URL Switching": it compares against your
  actual current Wi-Fi network before preferring the local address, supports multiple external
  addresses tried in your own chosen order (drag to reorder), and each one is tested live with a
  green check the moment you add it instead of just being saved blind. A "Use current connection"
  button fills in your local address and Wi-Fi name for you. Lives in Settings > Server.

### Fixed

- A suggested species' photo viewer (during import) now actually steps through that species'
  other reference photos with its arrow buttons/keys instead of doing nothing.
- The pack-update "Updating…" banner and per-pack update list now reflect the real in-progress
  download instead of resetting on navigation.
- Species suggestions and gallery semantic search now work offline from first launch on both
  desktop and Docker/self-hosted — the underlying model is bundled at build time instead of
  quietly downloading itself (~307MB) the first time either feature was actually used.
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
- Applying a large pack (a country with hundreds of thousands of hotspot clusters, e.g. Canada)
  could take an hour or more with zero visible progress — one database round-trip per cluster
  is now a handful of batched ones instead.

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
