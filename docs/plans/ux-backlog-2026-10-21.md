# UX backlog (2026-10-21)

Queued from the maintainer's testing, not started. Follow the HIG review, shared components and design
tokens rules for each.

1. **Gallery selection bar and toolbar.**
   - Drop the trailing … from the selection buttons.
   - The bar is sticky while selecting; it can scroll past otherwise.
   - "Save as smart album" goes into the ⋯ menu.
   - Swap Select and ⋯, so ⋯ sits far right.
   - Add "Clear all filters".
2. **Sensitive species are regional.** eBird's list is per area (e.g. Common Goldeneye only in the UK).
   Treat a species as sensitive only for photos whose region or coordinates fall in that area.
3. **Text hierarchy.**
   - The New smart album title is smaller than "Or choose your own rules".
   - Stats "Year over year": the empty text is bigger than its title.
   - Audit this app-wide.
4. **Rating.** Use a star-range control instead of the dropdowns, and drop "1+ stars".
5. **Multi-value filters.** OR within a filter (e.g. BC + Alberta), AND across filters. Covers the API,
   smart album rules (v1 compatible) and the UI.
6. **Smart album suggestions.**
   - "Groups of animals" included single-animal photos.
   - There's no way to restore dismissed suggestions.
   - Show the live count and a preview at the top of the builder.
7. **Find similar photos.**
   - Remove "Find similar photos" from the ⋯ menu inside that view.
   - Add a visible way back to the group list.
   - Add "Not similar" / "Keep all" to dismiss a group.
8. **Wording.** "Found in year" becomes "Photographed in year".
9. **API parity.** Integrations get every filter, sort and search, plus smart albums, suggestions,
   similar photos and the map, with docs.
10. **Album and trip card size control** via the shared View menu.
11. **Dark mode.** Sliders use the accent green, and other controls get a check.
12. **MCP server** on top of the API (after item 9), so assistants like Claude can search, ask and make
    changes:
    - it uses a scoped API key (read-only possible)
    - every change is one undo step
    - destructive actions ask first
    - setup snippets go in Settings > Integrations
13. **Traffic lights.** Get the native look while keeping them inline with the toolbar:
    - keep the overlay title bar
    - give the sidebar a slightly darker tint (as Finder and Photos do), so macOS's own background-window
      grey buttons stay visible
    - remove the custom disc backdrop (`window_controls.rs` and its focus and theme syncing)
    - check the sidebar-hidden and full-screen cases
14. **Free-space checks.** Before any big download or copy (models, map, region packs, catalog, library
    moves, export, culling ingest):
    - check free space first and explain clearly if it's short ("needs 3.4 GB, 1.2 GB free")
    - handle a full disk mid-download cleanly: stop, delete the partial file, show the same message
    - show free space next to download sizes
15. **"Open in…" external editors.**
    - detect installed editors and offer them; available from the photo menu, the viewer and selections
    - prefer the RAW
    - reuse the culling hand-off
16. **⌘1 to ⌘9** jump to the sidebar pages in order, and are shown in the Go menu.
17. **Pinned filters.** One-click filter chips in the Gallery toolbar, built on the shared filter state,
    with "Save as smart album" from a pin.

18. **Lightroom Classic catalog import.**
    - read the catalog without changing it: ratings, flags, labels, keywords, captions, GPS, and
      collections as albums (smart collections as smart albums where the rules map)
    - preview the changes before applying
19. **eBird checklists matched to photos.**
    - match by time and place, and link each photo to its checklist on eBird
    - trips list their checklists
    - gathering a checklist's photos for upload is a hand-off to eBird (it has no media API)
    - no in-app sighting maps or recent-sightings feeds: eBird's site does that better, so link to it

20. **Performance sweep: near-instant everywhere.**
    - known issue: opening a featured photo shows black for about a second; show the loaded thumbnail
      at once and swap in the full image, and preload neighbours
    - measure first-paint and interactive times on every main page with a large library; fix the worst
    - set budgets (navigation under ~100 ms perceived, photo open under ~150 ms with no blank frame)
    - add a regression check

21. **Windows and Linux parity pass (required, before culling).**
    - Mac-only code paths in the desktop shell
    - platform wording (Finder / Explorer, ⌘ / Ctrl)
    - NAS mapping for drive letters, UNC and /media
    - recognition acceleration on each OS
    - native title bars
    - bundled tools on each OS
    - e2e in CI on all three systems
    - native feel:
      - one platform conventions module (words, shortcut labels, dialog button order: Windows puts the
        primary first)
      - Windows: Snap Layouts, taskbar progress and notifications, scaling and high contrast, a proper
        installer, right-click everywhere
      - Linux: Flathub, the desktop's own decorations, portals for dark mode and the file chooser,
        Wayland and fractional scaling, freedesktop services
      - all systems: window memory and screen readers; keep Lifer's own look
22. **Year in Review and seasonal nudges.**
23. **Sound recordings** attached like videos (no recognition); they count as "heard".
24. **Portfolio, curated site and public life list** (static export or server share link).
25. **Save a video frame as a photo** (small and optional). It borders on editing, so keep it to an
    exact frame at full resolution, with no adjustments.

26. **Saved spots** ("Kingfisher Pond" = coordinates, region and a default iNaturalist geoprivacy).
    - apply to a selection, trip or import in one go, written to files
    - suggest nearby spots automatically
    - iNaturalist observations arrive already located
    - needs one migration (approval required)

27. **Region search:** constituent countries, territories and aliases. "Scotland" finds "Scotland, part of
    the United Kingdom", and a sovereign lists its realms. The data side goes with the catalog
    republish.

28. **iNaturalist sign-in trust model.**
    - desktop signs in directly on loopback (never through the relay)
    - a desktop connected to a server passes the token to the server
    - browser-only servers use the relay: a first-time warning per address, then remembered trust
    - callbacks are bound to the session
    - the threat model is documented
    - the iNat app registration needs both redirect URIs

29. **Testing depth.**
    1. Dangling-reference audit: everything remembered, tested deleted, renamed, moved, unplugged or
       missing.
    2. Life-cycle e2e journeys: do, undo, come back.
    3. Exploratory agent passes as personas, before each release.
    4. Monkey testing with invariants in CI.
    5. Extreme fixture libraries.
    6. Error injection: slow, failing or offline API and failing files.

30. **Group headings look clickable.** In the Collection's group mode, an open group's name shows no
    hover state, so it isn't obvious it collapses. Match the collapsed heading (underline on hover)
    and consider a stronger chevron.

31. **Select species in the Collection.** Select one, several or all (Shift-click ranges, select a
    whole group) and act in bulk: add to targets, mark as seen, archive. Reuse the Gallery's select
    mode and selection bar so both feel the same.

32. **Remove regions dialog: lead with reassurance.** "Your own photos aren't affected" is set as a
    footnote, smaller than the lines above, so it reads like fine print. Make it the same size and
    put it first, since it's what people worry about most. Check other confirmations for the same
    pattern.

33. **Removing regions must not block the app.** Today the confirm dialog stays open on a spinner
    until `/offline-packs/offload-batch` finishes, because the API deletes inline. Run it as a
    background job like pack downloads: close the dialog at once, show "Removing..." on the affected
    rows, toast when done, keep the rest of the app usable. Sweep for other long actions that wait
    inside a dialog.
    - Mark packs "removing" up front: deletePack empties species in chunks and drops the pack last,
      so without that a country would stay listed while half-empty.
    - Removing countries disappear from the Collection region picker and search at once; if you're
      viewing one, fall back like a removed restore (`restoreFallback`).
    - If the job fails, the country comes back with a clear message, never half-removed.

34. **Rich tooltips (Adobe-style) on toolbar buttons and tools:** name, shortcut and one plain line,
    shown on hover after a short delay and on keyboard focus. One shared tooltip component (extend
    `InfoTip` or add one), replacing bare `title` attributes, so Lifer and the culling app look the same.

35. **Settings buttons come in two sizes** (maintainer, 2026-10-27). Most settings buttons are
    `size="sm"` (59 of them), but about 13 use the default `md`:
    - AccountSettings (both Save buttons)
    - PhonesSettings (Done)
    - BringInWorkGroup (Look again, Bring in)
    - LibraryReimportSection (Choose folder)
    - WatchedFoldersGroup (Add folder)
    - ServerSettings (Connect, Sign in, Add address)
    - StorageSettings (Save, Cancel, Use this folder)

    Make them all one size. Where a button sits beside a text field, match the field height (size both
    `sm`). To stop it coming back, add a check (extend `scripts/check-raw-controls.mjs`, or a small
    sibling run by `npm run check`) that fails on a `<Button>` in `pages/settings/` without
    `size="sm"`.

36. **"Take the tour" in Settings does nothing** (maintainer, 2026-10-27). The cause is in
    `components/Tour.tsx`:
    - `startTour()` navigates to `/` and calls `begin()` straight away.
    - `begin()` looks for the tour's parts while still on the Settings page. The sidebar's Import
      button and nav (`data-tour="import"` and `"nav"`) are already on screen there, so it accepts the
      steps at once.
    - Arriving on `/` then trips the "leaving the page ends the tour" reset, so the tour closes before
      it shows.

    Fix: make the start event navigate to `/` with `state: { tour: true }`, so the existing "requested"
    path begins the tour once the collection has drawn. Test it from Settings and from the collection
    itself, and with a library that already has photos.

37. **Phone app gesture ideas, not built** (from the 2026-10-30 gesture audit):
    - The photo viewer closes back into its exact thumbnail, with the grid scrolled to the last photo
      viewed.
    - Swipe actions on rows (remove region, log on trip rows). These need Reanimated; long press already
      covers the actions.
    - Open reference photos in the viewer, in a mode without Share, Info and Full size.
    - Move the swipe-to-close drag off the JS thread (also needs Reanimated).

    Also still to check on a device: tab re-tap scrolling to top, the Info sheet over the transparent
    viewer, Android, and whether the swipe-to-close threshold (15% of the screen) feels right.

38. **Checks that were already failing before recent work** (found 2026-10-30). Fix them in one pass
    before the next commit batch:
    - `deviceKeyReach.test.ts` stops on `GET /api/sync/region-tree`.
    - `integrationsDocs.test.ts` wants prose for `GET /userdata/v1/name-display`,
      `GET /opendata/v1/regions/tree`, `POST /opendata/v1/species/names` and
      `POST /opendata/v1/species/rank`.
    - Prettier fails on the `name-display` row in `docs/docs/api/plugins.md`, and on one line in
      `opendata/routes.integration.test.ts`.
    - Mobile ESLint has 10 errors (a missing `react-hooks` rule in the config, plus `require` imports).
    - `scripts/check-raw-controls.test.mjs` and `scripts/check-copy.test.mjs` aren't run by
      `npm run check` or CI.

39. **Small open items** (2026-11-02):
    - Confirm the support address `hello@liferwildlife.com` (there's a TODO in the docs site's Feedback
      and support page).
    - The crash reporter doesn't catch panics before Tauri setup, api crashes before the handlers
      register, or the OS killing the api. The desktop shell's restart code could file a report.
    - The 32 GB of downloaded iNaturalist photos in `packages/data-pipeline/data/open-vectors/inat/` are
      only needed to extend that run. Decide: delete them, or move them to the NAS with the GBIF caches.
    - Phone crash reporting is out of scope for now.

Polish bar for 15 to 17: only worth shipping if done well (maintainer, 2026-10-21).

Also pending: Immich sync (server only), the feature tours, and the catalog republish checklist in
`next-catalog-republish.md`.
