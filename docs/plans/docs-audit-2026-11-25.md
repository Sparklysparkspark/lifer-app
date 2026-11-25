# Docs audit, 2026-11-25

An audit of the user guides, contributor pages, API pages, READMEs and `SCRIPTS.md` against the
code, covering the ~150 commits since the last docs pass (f8f9495, 2026-11-20). Labels were checked
against `apps/web/src/locales/en.json`, shortcuts against `apps/web/src/lib/keymap.ts`, routes
against `apps/web/src/api/openapi.gen.json`, and the data model against migrations up to 205.

## Fixed

### User guides

- **collection-and-checklists.md:** View option **Show progress by group**; the full Filters list
  (Targets list picker, **Needs a better photo**, **Only RAW photos so far**, Rarity pills,
  Endemic, Introduced and Vagrants with Any, Only or Hide, the When and Records sections); the
  one-pill rarity rule ("Rare here", else "Rare worldwide"; one badge per card); the **Heard** and
  **Name changed** badges; **Unrated** in place of "Not enough data here"; what the Add targets
  **Import a list** tab takes.
- **stats.md:** "Highlights" (not "At a glance"), **Set region** label, the tree's **Show
  uncollected species in colour**, vagrant-only species left out of a region's tree.
- **offline-packs-and-map.md:** removal progress on a folded country row.
- **faq.md, intro.md:** the one-pill rarity description, no "Not enough data here", adding a whole
  group from iNaturalist.
- **trash.md, gallery-and-search.md:** delete is instant with **Undo**; **Delete with RAW files**
  replaces the old checkbox; **Empty trash** casing.
- **gallery-and-search.md:** viewer shortcuts (plain arrows only change photo; Shift+arrows skip
  10 s; `,` `.` step a frame; 0 clears; Shift+0 to 5 rate and move on; S corrects the ID); Compare
  shortcuts (K features, F full screen, no C key); no key enters select mode; the **Appearance**
  filter.
- **filters-and-pins.md:** Appearance takes several values.
- **importing.md:** the trip suggestion on import groups; the folded section is **Skipped** with
  **Already in Lifer**.
- **photo-versions.md:** **Use as the photo**, the **Versions** button (Shift+A), **Used as the
  photo**.
- **library-folders.md:** the one **Reorganize existing photos** row replaces two removed ones.
- **albums-and-sharing.md, trips.md:** the Albums page's **Albums** / **Trips** switch; **Import RAW
  files**.
- **README.md:** nearby seas cover all marine life, not just fish; iNaturalist can add a whole
  group in a place.

### Settings, integrations and install

- **settings.md:** the Metadata tab; the Server tab in a browser lists only Linked devices; short
  sections for Show HDR photos in the viewer, Edit photos with, Tips, Target lists and species
  lists, Photo versions, Watched folders, Library locations with **Connect**, Moved photos, Immich,
  Assistants and API keys, Connected apps, Detailed maps; Portfolio in the Manage panel; **API
  keys** row (not server-only); **Reorganize existing photos**; Offline map and missing reference
  photos under **Offline data > Species data**; dropped the removed "View regions" link.
- **inaturalist.md:** the shared selection bar; **Include all** and **Leave all out**; the sighting
  split rule (over 200 m apart, or another camera or lens).
- **sync.md:** extra species in one photo, lists from iNaturalist and named target lists don't
  sync (their target marks do).
- **connected-apps.md:** the per-chip download and the Intel Mac CPU-only note; **Show suggested
  apps**; **Remove from Lifer**.
- **culling-with-other-apps.md:** the sidebar suggestion is labelled **Cull**.
- **lightroom.md, api/plugins.md:** **Show code** under **Connect an app**.
- **install/desktop.md, getting-started.md:** Import is Shift-Command-I.
- **install/upgrading.md:** the desktop app backs up the database before an update (last three
  kept) and an older Lifer refuses a newer database.
- **install/connect-desktop-to-server.md, faq.md, api/overview.md:** API keys work on the desktop
  for connected apps and assistants; the full API is for servers.
- **install/environment-variables.md:** `MAP_DETAIL_INDEX_URL`.
- **troubleshooting.md:** downloads retry and resume on their own; a removed waiting step; four
  quoted messages corrected.
- **security-model.md:** the desktop accepts API keys on plugin, assistant and phone routes
  (`desktopGate.ts`), and the pairing scopes.
- **privacy.md:** linked iNaturalist downloads, lists from iNaturalist, Immich; companion app
  installers are downloaded from their maker when you press Install.
- **roadmap.md:** sending observations to iNaturalist has shipped.

### Contributor and API pages

- **data-model.md:** appearance columns (M196), `imported_by_key_id` (M202, outside the `captures`
  view), `albums.cover_auto_photo_id` (M204), `target_lists` and `target_list_species` (M195),
  list-to-targets columns (M205).
- **state-and-sync.md:** saved spots sync (they were listed as local only); target lists and lists
  from iNaturalist are local only.
- **architecture.md:** PostgreSQL is bundled, not downloaded; the desktop's sync and companion app
  jobs.
- **data-pipeline.md:** a new species group is an entry in `seed-groups.ts`, not its own script.
- **remembered-state.md:** rows for apps kept from the background or with notices off, and for
  species name choices (31 rows, each with a test).
- **imports-and-metadata.md:** **Use as the photo** label.
- **api/overview.md:** AVIF, JPEG 2000 and JPEG XL uploads; the add-species `400` codes
  (`primary_species`, `unknown_species`); `/opendata/v1/species-lists` in the `opendata.read` scope.
- **development.md, CONTRIBUTING.md:** `npm run check:all` and `check:licences`.
- **SCRIPTS.md:** `restore-published-rows`, `benchmark-matching`, `load-species-notes`.

## Needs the maintainer

- **Screenshots** in `docs/static/img/` date from 2026-10-14. `collection.jpg` (rarity pills,
  group cards, Add species menu), `stats.jpg` (Photos over time), `photo-viewer.jpg` (viewer
  controls) are certainly stale; `species-detail.jpg`, `species-about.jpg`, `offline-packs.jpg`
  and `photo-menu.jpg` probably. `collection.jpg`, `species-about.jpg`, `offline-packs.jpg`,
  `gallery.jpg` and `stats.jpg` also appear in the root README.
- **In-app help strings** (`en.json`, code, so not edited here):
  - `guide.faq.rarity.badges` still describes a plain badge plus a second "here" badge, and "Tap a
    rarity badge". Suggest: "Each species card shows one rarity: "Rare here" when the species is
    rarer in this region than worldwide, otherwise its worldwide rarity. ..." (keep the method
    sentences).
  - `guide.faq.rarity.endangered` says "Not enough data"; the UI says **Unrated**.
  - `guide.faq.otherTaxa.answer` describes only the search-box route under "Settings → Species &
    Import". Suggest pointing at **+ Add species > Add other species** on a checklist (one species,
    a whole group in a place, or a list), and the tab label "Species and import".
- **Two "add other species" dialogs:** Settings > Species and import > Add a species from
  iNaturalist > Search opens an older dialog (One species / Import a list), separate from the
  Collection's three-tab Add other species. Merge or keep both?
- **Map tilt removal:** not found in committed code (PhotoMap still has 3D / Flat), so the "Flat
  or 3D" section of photo-map.md is unchanged. Rewrite it when tilt removal lands.
- **No keyboard shortcuts page** in the docs: shortcuts are spread over the viewer, import,
  versions and desktop pages, with the in-app **?** sheet as the full list. Add a reference page
  generated from `keymap.ts`, or keep it in-app only?
- **roadmap.md** still lists "Built-in culling (exploring)", which contradicts culling being a
  separate suggested app. Remove it?
- **Phone companion app** (Settings > Integrations > Connect a phone) has no user guide. Is it
  released? Immich and Watched folders have only short settings.md entries.
- **Culling marks line** in the viewer (`apps/web/src/lib/cullInfo.ts`) is hard-coded English, not
  in `en.json` (code).
- **Not re-read line by line:** install/docker.md, hardware-acceleration.md, reverse-proxy.md,
  requirements.md, backup-restore.md, ebird-import.md, support.md, credits.md (labels, quoted
  messages and env vars were checked); metadata-and-file-names.md and other-apps-and-keywords.md
  (updated with their feature in b04cba0).
- **CI gaps:** CI runs the parts of `check:all` one by one but not `check:remembered-state` or
  `check:token-export`.
- **remembered-state.md** still has no rows for the Gallery's group-by-region choice, recent
  albums (`lifer:recentAlbums`, album ids that can go stale), the photo map camera, the interface
  language (`lifer.locale`), the sidebar hidden flag and Show suggested apps. Recent albums and the
  language point at things that can disappear and have no test yet.
- **Parallel commits:** another worker committed `gallery-and-search.md` and `importing.md` during
  the audit (9aae688, 0057a94), which took in most of this audit's edits to those pages under their
  messages. Only the Appearance filter line there is still uncommitted.

## Pending (work in progress elsewhere, not documented here)

- HDR in the viewer for more formats (migration 206, `apps/api/src/photos/hdr/`): its docs lines
  in gallery-and-search.md and `docs/plans/hdr-display.md` belong to that worker.
- Import page "move into library" fix (`apps/api/src/uploads/pickedFiles.ts`).

## Checks run

- `docusaurus build` into a scratch folder: passes with `onBrokenLinks`, `onBrokenAnchors` and
  `onBrokenMarkdownLinks` set to throw; rerun after the edits.
- Every docs.sparklysparkspark link in the READMEs, CONTRIBUTING, SECURITY and the data-pipeline
  docs resolves to a built page and anchor.
- Every `npm run` command and repo file path named in a non-plan markdown file exists (desktop
  script paths are relative to `apps/desktop`, data-pipeline ones to its `src`).
- Every route in `docs/docs/api/*.md` exists in the OpenAPI document (the `/lifer-host` routes are
  the desktop host's), and the routes added since 2026-11-20 were checked for integration scopes.
- Shortcut tables against `keymap.ts`, `Lightbox.tsx`, `CompareView.tsx` and the desktop menu
  (`menu.rs`).
- Browser storage keys in `apps/web/src` against remembered-state.md.
- Migrations 192 to 205 against data-model.md.
- `npx prettier --write` on the changed markdown, then `npm run check:all`.
