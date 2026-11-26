# Phone app: alignment with the refined feel

Status: audit and plan only, 2026-11-25. No app code changed. Mockups are in the scratchpad for review (see
[Mockups](#6-mockups)); nothing is built until the maintainer signs them off.

Read first: `refined-feel.md`, `ux-rules.md` (sections 1 to 16), `mobile-ux-plan.md` (the signed-off phone design this
plan builds on), `mobile-implementation-plan.md` (scope, sync, pairing).

## Summary

- **The shell already follows the standing rule.** Four native tabs with icons (Collection, Gallery, Albums, Identify),
  native stacks with large titles, search in the bar, native UIMenu menus, form sheets with detents, the account
  button and the trip bar were built on 2026-10-26 (`mobile-ux-plan.md`, Implementation notes). No restructure is
  needed.
- **What drifted is everything the desktop changed since then.** `apps/mobile` has had only fixes (aa8d975, 801c4ba)
  while the desktop got the refined-feel round: two rarity pills and Unrated, View and Filters as two controls,
  Photos taken, grey uncollected covers with a colour option, progress by group, the one viewer, Photos over time,
  and many plain-language renames.
- **One data bug sits under the most visible gap.** The hub's phone checklist sends one tier per species
  (`COALESCE(override, local_tier, worldwide)` in `apps/api/src/sync/phone.ts`), and the phone stores it in the global
  `species` table, so the last region synced decides the tier shown everywhere, including Everywhere. The desktop now
  shows "Rare here" and "Common worldwide" side by side; the phone cannot until both scopes are synced.
- **Gaps: 33.** High 4, Medium 16, Low 13. Names that differ from the desktop: 27.
- **The app was not run.** There is no `react-native-web` and no simulator build on this machine, and an iOS build is
  too heavy beside the running workers. Everything below is from the code, read on 2026-11-25.

## 1. Gap table

Severity: **High** shows wrong or clearly different information, or breaks a platform requirement; **Medium** is a
visible parity or rule break; **Low** is polish. Effort: S 1 to 2 days, M 3 to 5 days, L 1 to 2 weeks.

### Collection

| ID   | What the phone does now                                                                                                       | What the desktop does now                                                                                                                                   | Gap                                                                                                                 | Sev    | Effort |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| C-1  | One uppercase sage pill, only for Rare and Legendary (or every tier when arranged by Rarity) (`ui/SpeciesCard.tsx`)           | Two quiet `TierLabel` pills under the names whenever a tier exists: "Rare here" and "Common worldwide"; only the plain worldwide tier outside a region (U2) | Different look, wording and rule; the phone hides most tiers                                                        | High   | M      |
| C-2  | Stores one tier per species, last region wins; the hub sends override, else local, else worldwide as one value                | Local tier per region and worldwide tier kept apart                                                                                                         | The phone can show British Columbia's tier while browsing Everywhere or Ontario (U2 trust break)                    | High   | M      |
| C-3  | No Unrated                                                                                                                    | Thin data reads **Unrated**; no tier shows nothing                                                                                                          | Missing state; needs the tier reason from the hub                                                                   | Medium | S      |
| C-4  | No way to hide tier pills                                                                                                     | View > **Show rarity tags**                                                                                                                                 | Missing option                                                                                                      | Low    | S      |
| C-5  | One filter button, "Show and arrange", mixing Show, Arrange, Group, Card size and More filters                                | Two controls, **View** (Arrange, Group, size, Hide names, Show rarity tags, Show progress by group, Show uncollected species in colour) and **Filters**     | Breaks C4 (one View and one Filters declaration); options sit in different places on each app                       | Medium | M      |
| C-6  | No Photos taken                                                                                                               | Filters > **Photos taken**: Anywhere, In {region}, Only outside {region}; the header count follows it                                                       | Missing filter; the phone has `captures.region_id` and the region tree, so it can compute it offline                | Medium | M      |
| C-7  | Uncollected species at 55 percent opacity, never grey                                                                         | Grey with a warm sepia (`cover-uncollected`); seen covers fade (`cover-seen`); View > **Show uncollected species in colour**                                | The most visible card difference; no colour option                                                                  | High   | M      |
| C-8  | Section header: glyph, "Birds", small "318 of 402"                                                                            | **Show progress by group** (on by default): a band per group with a big "212 of 480", a bar and your best photos                                            | Flatter headers; no option                                                                                          | Medium | M      |
| C-9  | One glass badge top right: target icon, or eye plus "Seen"                                                                    | Small round line-icon marks top left (seen, target), the badge slot kept for unusual things                                                                 | Different place and look; the phone shows only one of the two marks                                                 | Low    | S      |
| C-10 | Arrange: Common name, Scientific name, Rarity, Photographed first, Seen first, Targets first. Group: Broad group, No grouping | Also **Field guide order**, **Likely this month**, Rarity here; Group by **Family group**                                                                   | Phone now stores order and family names (migration 3) but no sort sequence; seasonality is not on the phone         | Medium | M      |
| C-11 | Switch "Include vagrants"                                                                                                     | Records: Vagrants, Endemic, Introduced, each Any, Only, Hide                                                                                                | Different control; Endemic and Introduced have no phone data                                                        | Low    | S      |
| C-12 | Not stored or shown                                                                                                           | **Needs a better photo**: a filter and a species toggle                                                                                                     | The hub already sends and accepts `needsBetterPhoto` (`sync/changes.ts`); the phone drops it. A field-friendly mark | Medium | S      |
| C-13 | No card badges                                                                                                                | One badge at most: Heard, Name changed, Not seen in 25 years, Rarely recorded, Endemic, Vagrant, Added by you                                               | Vagrant data is on the phone; others need fields                                                                    | Low    | M      |
| C-14 | "Search species"                                                                                                              | "Search species here, e.g. "owls""                                                                                                                          | W10 example missing                                                                                                 | Low    | S      |

### Species page

| ID  | Now                                                                                  | Desktop                                 | Gap                                                                                  | Sev    | Effort |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------ | ------ | ------ |
| S-1 | More > Open in Collection switches tabs and leaves Collection where it was           | Show in Collection lands on the species | Label promises more than it does (W8)                                                | Medium | S      |
| S-2 | Fact "Last seen" shows the latest photo date (sightings were dropped in migration 5) | No such fact                            | Mislabelled fact (U2); should read "Latest photo"                                    | Medium | S      |
| S-3 | Share sends the species name as text                                                 | No species share                        | A primary-looking button that does little (A3, L5); share the cover photo or drop it | Low    | S      |

Tier pills (C-1) and Needs a better photo (C-12) also land here.

### Photo viewer

| ID  | Now                                                                                          | Desktop                                                                                    | Gap                                                                         | Sev    | Effort |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------ | ------ |
| V-1 | Two More buttons (top right and bottom right) open the same system action sheet              | One shared viewer: Close, photo menu, fullscreen, the same controls everywhere, time taken | Duplicate control (C11); an action sheet, not a menu anchored to its button | Medium | S      |
| V-2 | Filmstrip neighbours are 28 by 40 pt tap targets                                             | n/a                                                                                        | Under 44 pt (MR1)                                                           | Medium | S      |
| V-3 | The Info lift and the drag-to-close spring run under Reduce Motion; group fold has no motion | Motion skipped under reduced motion                                                        | Y3                                                                          | Low    | S      |
| V-4 | Opens with a fade                                                                            | n/a                                                                                        | The plan's zoom from the tile (MR8 feel) is still open                      | Low    | M      |

The caption already shows date and time, as the desktop now does.

### Gallery

| ID  | Now                                                                     | Desktop                                                     | Gap                                                                                                          | Sev    | Effort |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ | ------ |
| G-1 | Show > Favourites: photos in an album named "Favourites" or "Favorites" | No Favourites concept; **Featured** photos and star ratings | A phone-only convention with a name the desktop never shows; Featured needs a field in the capture feed      | Medium | M      |
| G-2 | Info lists tags flat                                                    | Smart tags plan: accepted tags are ordinary tags, by facet  | When smart tags ship, accepted ones arrive as tags and are searchable already; show the facet (Habitat) only | Low    | S      |

The View and Filters split (C-5) and the search placeholder (names list) apply here too.

### Albums and Trips

| ID  | Now                                                  | Desktop                                                                                  | Gap                                                                                          | Sev    | Effort |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ | ------ |
| A-1 | Album cover from `cover_photo_id` in the albums feed | Lifer picks a cover (`albums.cover_auto_photo_id`, M204) and moves it to an edited photo | The feed has no auto cover field, so an album without a chosen cover falls back on the phone | Medium | S      |

The Albums and Trips switch now exists on both; only its label differs.

### Stats

| ID   | Now                                          | Desktop                                                            | Gap                                                                          | Sev    | Effort |
| ---- | -------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------ | ------ |
| St-1 | Tiles, Species by group, New species by year | **Photos over time**: stacked bars by month or year in five groups | Missing; the phone holds `taken_at` and the group, so it can draw it offline | Medium | M      |
| St-2 | Largest number is a 28 pt title              | `text-display` numerals and an overline style (refined feel)       | No display numeral or overline token                                         | Low    | S      |

### Your Lifer and Settings

| ID   | Now                                                              | Desktop                                                 | Gap                     | Sev    | Effort |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- | ------ | ------ |
| Se-1 | "Regions" page of species lists kept on the phone                | **Species downloads** (Settings group, command palette) | Name parity; decision 1 | Medium | S      |
| Se-2 | Photo cache, Showcase, Smart search under "Photos on this phone" | **Offline data**                                        | Group name              | Low    | S      |

### Across the app

| ID  | Now                                                                                   | Gap                                                                                  | Sev    | Effort |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | ------ |
| X-1 | Android tab icons, menus, pinch and sheets never run on a device (no JDK or SDK here) | Windows and Linux desktop plus Android are required (platforms rule)                 | High   | M      |
| X-2 | 27 strings differ from the desktop (section 2)                                        | Standing rule: same names for the same things                                        | Medium | S      |
| X-3 | VoiceOver reads one tier with no scope                                                | Must read "Rare here, Common worldwide"; group bands need one spoken label           | Medium | S      |
| X-4 | No Tree of life                                                                       | Desktop-only today; decision 4                                                       | Low    | n/a    |
| X-5 | `check:ui` has no rule for tiers                                                      | A lint that tier text only renders through the phone `TierLabel` (no uppercase pill) | Low    | S      |

**Counts:** High 4 (C-1, C-2, C-7, X-1). Medium 16. Low 13. Total 33.

## 2. Names parity

Phone keys are in `apps/mobile/src/locales/en.json`, desktop keys in `apps/web/src/locales/en.json`.

| #   | Phone key                                            | Phone text                                      | Desktop text                                    | Desktop key                                                    | Do                                     |
| --- | ---------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| 1   | `collection.menu`, `gallery.menu`                    | Show and arrange                                | View, Filters                                   | `collection.toolbar.view`, Filters button                      | Split into two controls (C-5)          |
| 2   | `collection.cardSize`                                | Card size                                       | Species card size                               | `collection.toolbar.sizeLabel`                                 | Rename                                 |
| 3   | `collection.size.large`, `.small`                    | Large, Small                                    | 2 columns, 3 columns                            | `collection.toolbar.sizeColumns`                               | Rename; keep List                      |
| 4   | `collection.searchPlaceholder`                       | Search species                                  | Search species here, e.g. "owls"                | `collection.toolbar.searchPlaceholder`                         | Copy                                   |
| 5   | `filters.traits`                                     | Traits                                          | Records                                         | `collection.toolbar.recordsSection`                            | Rename                                 |
| 6   | `filters.vagrants`                                   | Include vagrants                                | Vagrants (Any, Only, Hide)                      | `collection.toolbar.vagrants*`, `traitAny`                     | Rename and three-way control           |
| 7   | `filters.year`                                       | Photographed in                                 | Photographed in year                            | `collection.toolbar.year`                                      | Rename                                 |
| 8   | `filters.rarity` section with `rarityNote`           | Rarity, plus a note                             | Rarity, Rarity here                             | `collection.toolbar.rarity`, `.rarityHere`                     | Add Rarity here once C-2 lands         |
| 9   | `tiers.*`                                            | no Unrated                                      | Unrated                                         | `collection.tiers.unrated`                                     | Add                                    |
| 10  | none                                                 | none                                            | {tier} here, {tier} worldwide                   | `speciesCard.tierHere`, `.tierWorldwide`                       | Add                                    |
| 11  | `species.unmarkSeen`                                 | Remove seen mark                                | Mark as unseen                                  | `speciesCard.menu.markUnseen`                                  | Rename                                 |
| 12  | `species.openInCollection`                           | Open in Collection                              | Show in Collection                              | `speciesLists.actions.show`                                    | Rename (and fix, S-1)                  |
| 13  | `viewer.openSpecies`, `identify.openSpecies`         | Open species page                               | View species                                    | `photoMenu.viewSpecies`                                        | Rename                                 |
| 14  | `species.lastSeen`                                   | Last seen                                       | none (phone-only fact)                          |                                                                | "Latest photo" (S-2)                   |
| 15  | `species.yourPhotosCount`                            | Your photos (14)                                | Your photos                                     | `species.photos.yourPhotos`                                    | Count moves to the sort line           |
| 16  | `toast.seen`                                         | {name} marked as seen                           | Marked {name} as seen.                          | `speciesCard.markedSeen`                                       | Copy (no trailing period on the phone) |
| 17  | `toast.target`                                       | {name} added to targets                         | Added {name} to your targets.                   | `speciesCard.addedToTargets`                                   | Copy                                   |
| 18  | `toast.targetRemoved`, `toast.seenRemoved`           | removed from targets, Seen mark removed         | Removed from your targets, Marked as not seen   | `species.detail.removedFromTargets`, `.markedNotSeen`          | Copy, with the name                    |
| 19  | `stats.count.top`                                    | Top rated                                       | Top rated (5-star)                              | `stats.filter.topRated`                                        | Copy                                   |
| 20  | `settings.appearanceSystem`                          | Match my phone                                  | Follow system                                   | `settings.general.theme.system`                                | Copy                                   |
| 21  | `settings.appearance`                                | Appearance (as the choice's label)              | Theme (inside Appearance)                       | `settings.general.theme.label`                                 | Label the row Theme                    |
| 22  | `settings.names`, `.namesCommon`, `.namesScientific` | Names: Common name first, Scientific name first | Names and labels; Main name: Common, Scientific | `settings.general.names.title`, `collection.toolbar.mainName*` | Copy                                   |
| 23  | `regions.title`, Your Lifer row                      | Regions                                         | Species downloads                               | `settings.groups.regions`                                      | Decision 1                             |
| 24  | `settings.photosOnPhone`                             | Photos on this phone                            | Offline data                                    | `settings.groups.offlineData`                                  | Rename                                 |
| 25  | `gallery.searchPlaceholder`                          | Search photos                                   | Search, e.g. "heron in water"                   | `gallery.toolbar.searchPlaceholder`                            | Copy                                   |
| 26  | `gallery.favourites`, `settings.showcaseFavourites`  | Favourites, Favourites only                     | Featured, Featured only                         | `gallery.toolbar.featured`, `stats.filter.featured`            | Decision 2                             |
| 27  | `albums.segments`                                    | Show albums or trips                            | Albums or trips                                 | `albums.*.switchLabel`                                         | Copy                                   |

Phone-only words that stay: Identify, Is this a lifer?, Sunlight, Showcase, Smart search offline, Your Lifer, trip bar
wording. They name things the desktop does not have.

## 3. What belongs on the phone

The phone is a companion: it reads a synced copy, pushes species marks only (`POST /sync/user-species`: seen, target,
cover, card crop, and the already supported `needsBetterPhoto`), and never runs heavy jobs or deletes
(`mobile-implementation-plan.md`, What it is and isn't).

### Bring to the phone

| Desktop change                                     | On the phone                                                                                       | Why                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Two rarity pills, Unrated, Show rarity tags        | Same pills, same words, same View option                                                           | Trust (U2) and the parity rule                  |
| Show uncollected species in colour, grey covers    | Grey by default, the same View option                                                              | The card is the app's signature (C3)            |
| Show progress by group                             | Group bands with the big number, on by default                                                     | Life-list progress is the top field question    |
| View and Filters, Photos taken, Vagrants three-way | One View menu and one Filters sheet, shared by Collection and Gallery                              | C4; Photos taken works offline from `region_id` |
| Needs a better photo                               | Species toggle and filter                                                                          | A field mark; already in the sync protocol      |
| Shared viewer controls, time in captions           | One photo menu, Close, Share, Info (time already shown)                                            | C11                                             |
| Photos over time                                   | A small stacked bar chart, year or month; tap a bar to open Gallery for that period; no drag brush | Local data; a brush is fiddly on a phone        |
| Cover auto-upgrade                                 | Nothing to build beyond sending the album auto cover (A-1); species covers already follow the hub  | Hub-side feature                                |
| Plain-language renames                             | Section 2                                                                                          | Parity                                          |
| Smart tags (accepted only)                         | Accepted tags show in Info under their facet and are searched offline as tags                      | Reading is cheap; review is not a phone job     |

### Desktop only, on purpose

| Desktop feature                                                                                                  | Why not on the phone                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add species menu, Add other species (three tabs), Add a list from iNaturalist, Add targets for a group or a list | Each calls iNaturalist and runs a hub job with batches and reference vectors; the phone pushes marks only and never calls third parties itself. Targeting one species stays on the phone |
| Smart tags suggestions strip, Review smart tags, vocabulary settings                                             | Review is by tag over thousands of photos with select and Shift-click; nothing on the phone writes tags                                                                                  |
| HDR in the viewer                                                                                                | `hdr-display.md`: the phone keeps SDR; `/photos/:id/hdr` is owner-only and outside the companion scope; about 1 MB a photo on cellular                                                   |
| Version labels (Original, RAW, Edit) and the Versions dialog                                                     | The phone holds one display copy per photo and never sees files                                                                                                                          |
| Instant delete with Undo, Trash                                                                                  | The phone never deletes                                                                                                                                                                  |
| Species downloads with sizes and the country map                                                                 | A paired phone mirrors the hub's downloads by itself; a phone-only user picks from a list. Only the name aligns                                                                          |
| Tree of life (list and circle)                                                                                   | The circle needs width and hover; see decision 4 for a phone drill list                                                                                                                  |
| Photo map, map relief                                                                                            | Detailed map tiles are out of the phone's scope                                                                                                                                          |
| Keyboard shortcuts and the keymap                                                                                | No keyboard; gestures have button alternatives instead (MR12)                                                                                                                            |
| Plugin launcher and the Cull entry                                                                               | Installs desktop apps; the phone never mentions culling                                                                                                                                  |
| Metadata templates, keyword lists, Apple Photos keywords                                                         | Writes files                                                                                                                                                                             |

## 4. Native-pattern review

Checked against the iOS Human Interface Guidelines and Material 3. "OK" means it already meets the guidance.

| Area                | Now                                                                                                               | Verdict and fix                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab bar             | Native `UITabBarController` with Liquid Glass and SF Symbols, four tabs, minimise on scroll in Gallery and Albums | OK on iOS. Android: Material navigation bar with active pill is wired but never run (X-1)                                                      |
| Navigation          | Native stacks, minimal back button, edge swipe, tab bar hidden on Species and Trip                                | OK. Back restores scroll (MR8) is tested only in unit tests; add a device check                                                                |
| Large titles        | Collapse on scroll; species page uses a transparent bar over the hero                                             | OK                                                                                                                                             |
| Menus               | Bar menus are native UIMenu; long press and the viewer use the system action sheet                                | View becomes a UIMenu; Filters becomes a sheet (MR3: choices needing more than a checkmark). Viewer: one anchored menu (V-1)                   |
| Sheets              | `formSheet` with detents and grabber for every sheet                                                              | OK. Filters sheet: medium and large detents, Clear left, Done right                                                                            |
| Haptics             | Selection on mark changes, success on queue, a step on pinch                                                      | OK (MR9). Add nothing for the new toggles beyond selection                                                                                     |
| Dynamic Type        | iOS text sizes, grid falls back to List above 1.3x; trip bar caps at 1.3x                                         | OK. Bands and two pills must wrap at AX5: pills stack, the big number drops under the name                                                     |
| Safe areas          | Insets respected in the viewer and toolbars                                                                       | OK                                                                                                                                             |
| Dark mode, Sunlight | Follows the system; Sunlight is solid                                                                             | Tier pills need a Sunlight pair (solid fill, 7:1 text) and a contrast test entry                                                               |
| Reduce Motion       | Only the Gallery pinch checks it                                                                                  | Viewer lift and dismiss, the new band fold animation: crossfade or none (V-3)                                                                  |
| Reduce Transparency | iOS 26 glass handles it natively; the fallback is already solid                                                   | OK                                                                                                                                             |
| Touch targets       | 44 pt round buttons, 46 pt toggles, whole card is the target                                                      | Filmstrip tiles are 28 pt wide (V-2). Card marks stay decorative (the card is the target)                                                      |
| One-handed reach    | View and Filters top right (iOS convention), primary actions low on Species and Identify                          | OK. The Filters sheet opens with its most used section (Show) in thumb reach at the medium detent                                              |
| VoiceOver           | Labels on cards, headers, viewer, tiles; custom actions on cards                                                  | Cards: "Pileated Woodpecker, Dryocopus pileatus. Photographed. Uncommon here, Common worldwide." Bands: "Birds, 212 of 480 photographed" (X-3) |
| Smart Invert        | Photos excluded                                                                                                   | OK                                                                                                                                             |
| Android back        | Predictive back depends on react-native-screens                                                                   | Check on a device (X-1)                                                                                                                        |

## 5. Implementation plan

Model per the review split: Opus for data, sync, API and anything that could show wrong numbers; Sonnet for UI,
copy and tests. Every UI package ends with the screenshot HIG review (light, dark, Sunlight, AX5, the extreme seed:
5,000 species, 60-character names, 60,000 photos) on an iPhone simulator, and on Android once X-1 is unblocked.

### Wave 0: sign-off (no code)

The maintainer reviews the mockups and answers the decisions below.

### Wave 1: data and names

| ID   | Scope                                                                                                                                                                                                                                                      | Model                  | Depends | Effort |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------- | ------ |
| MA-1 | Tier scopes: `/sync/regions/:id/checklist` sends `localTier`, `worldTier` and `tierReason` (override still wins on its scope); phone migration adds `region_species.local_tier` and `species.world_tier`, reads by region; Everywhere shows worldwide only | Opus                   | none    | M      |
| MA-2 | Needs a better photo: store the hub field, push it, species toggle with Undo, Filters row                                                                                                                                                                  | Opus (sync), Sonnet UI | none    | S      |
| MA-3 | Names parity: the 27 rows in section 2 that need no decision, `check:i18n`                                                                                                                                                                                 | Sonnet                 | none    | S      |
| MA-4 | Albums feed carries the auto cover (M204); phone uses chosen, else auto                                                                                                                                                                                    | Opus                   | none    | S      |

### Wave 2: cards and Collection

| ID   | Scope                                                                                                                                                                                                             | Model                                               | Depends    | Effort |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------- | ------ |
| MA-5 | `ui/TierLabel.tsx` (the desktop look: quiet pill, sentence case, footnote); SpeciesCard and SpeciesRow show here and worldwide; Unrated; Show rarity tags; VoiceOver wording; Sunlight pair; lint (X-5)           | Sonnet                                              | MA-1       | M      |
| MA-6 | Card marks top left as line icons; grey uncollected and faded seen covers; Show uncollected species in colour                                                                                                     | Sonnet, Opus review if the hub renders grey squares | decision 3 | M      |
| MA-7 | One declared View menu and one Filters sheet for Collection and Gallery (Show, Photos taken, Records with Vagrants Any, Only, Hide, Rarity, Rarity here, Needs a better photo, When); Hide names; 2 and 3 columns | Sonnet                                              | MA-1, MA-2 | M      |
| MA-8 | Show progress by group bands: display numeral token, overline token, best-photo strip, fold with motion skipped under Reduce Motion; one spoken label per band                                                    | Sonnet                                              | MA-7       | M      |
| MA-9 | Field guide order and Family group: the checklist bundle sends a taxonomic sort index; phone stores it                                                                                                            | Opus (API), Sonnet (UI)                             | MA-1       | S      |

### Wave 3: species page and viewer

| ID    | Scope                                                                                                                                                                | Model  | Depends    | Effort |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ------ |
| MA-10 | Species page: two pills with the region name, Latest photo, Needs a better photo row, Show in Collection lands on the species, share the cover photo or remove Share | Sonnet | MA-5, MA-2 | S      |
| MA-11 | Viewer: one photo menu anchored top right (View species, View full size, Info), bottom keeps Share and Info, 44 pt filmstrip targets, Reduce Motion                  | Sonnet | none       | S      |

### Wave 4: Stats, Gallery, smart tags

| ID    | Scope                                                                                                                                                  | Model               | Depends              | Effort |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | -------------------- | ------ |
| MA-12 | Photos over time: stacked bars from local captures in the five desktop groups, Months and Years, tap opens Gallery for the period; table for VoiceOver | Sonnet              | none                 | M      |
| MA-13 | Featured in place of Favourites (if decision 2 is yes): capture feed sends featured, Gallery Show and the showcase use it                              | Opus (feed), Sonnet | decision 2           | M      |
| MA-14 | Accepted smart tags in Info, grouped by facet                                                                                                          | Sonnet              | smart tags ST phases | S      |

### Wave 5: platform and accessibility

| ID    | Scope                                                                                                                                                    | Model                        | Depends                 | Effort |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------- | ------ |
| MA-15 | Android pass on a real device: tab icons, menus, sheets, pinch, predictive back, 48 dp, TalkBack. Needs a JDK and Android SDK on a build machine         | Sonnet, Opus review of fixes | the maintainer's device | M      |
| MA-16 | Full sweep: AX5, VoiceOver and TalkBack, Sunlight, Reduce Motion, extreme seed, HIG checklist per screen; copy approved mockups to `docs/design/mobile/` | Sonnet                       | waves 1 to 4            | M      |

Rough size: waves 1 to 3 about three weeks of conventional effort; waves 4 and 5 about two more.

### Decisions for the maintainer

1. **"Regions" or "Species downloads" on the phone?** The phone plan named it Regions after the desktop sidebar;
   the desktop now says Species downloads. Recommend **Species downloads** for the page and the Your Lifer row; the
   Collection picker keeps "Region".
2. **Favourites or Featured?** The phone's Favourites is any album called Favourites, a name the desktop never
   shows. Recommend **Featured** (the desktop's word, a small feed field), with the showcase keeping "best photo per
   species plus Featured".
3. **How to grey uncollected covers.** (a) React Native's `filter` style if 0.88 supports grayscale and sepia on iOS
   (spike first), or (b) the hub serves a grey square, cached like any thumbnail. Recommend (a), fall back to (b).
4. **Tree of life on the phone?** Recommend **not this round**: group bands and Field guide order cover the field
   need. If wanted later, a drill-down list (class, order, family, species) from local data, never the circle.
5. **Photos over time on the phone?** Recommend **yes, simple**: bars and tap-to-filter, no drag brush, no map.
6. **Smart tags on the phone?** Recommend **accepted tags only**, read-only in Info and search; no suggestions or
   review on the phone.

## 6. Mockups

Static HTML at 390 px, light and dark, screenshotted with Playwright. Photos are coloured placeholders; nothing from
the maintainer's library was used. Folder:
`/private/tmp/claude-501/-Users-judahstarkey-Development-lifer-app/a7e6bee3-8dee-42e2-978c-143148dcb851/scratchpad/mobile-mockups/`
(rerun with `node shoot.cjs` there).

| Screen        | Shows                                                                                                                                                                        | Files                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Collection    | View and Filters buttons, group band "212 of 480 photographed", two quiet tier pills, line-icon marks top left, grey uncollected cards, long names, trip bar, iconed tab bar | `1-collection.html`, `1-collection-light.png`, `1-collection-dark.png`          |
| View menu     | Arrange, Group, Species card size as submenus; Show rarity tags, Show progress by group, Show uncollected species in colour, Hide names                                      | `2-view-menu.html`, `2-view-menu-light.png`, `2-view-menu-dark.png`             |
| Filters sheet | Show, Photos taken (with its one-line note), Records (Vagrants Any, Only, Hide; Rarity; Needs a better photo), When                                                          | `3-filters-sheet.html`, `3-filters-sheet-light.png`, `3-filters-sheet-dark.png` |
| Species page  | "Uncommon in British Columbia" and "Common worldwide", Photographed and Target toggles, Latest photo, Needs a better photo                                                   | `4-species.html`, `4-species-light.png`, `4-species-dark.png`                   |
| Photo viewer  | One menu top right (View species, View full size, Info), date and time, filmstrip, Share and Info only                                                                       | `5-viewer.html`, `5-viewer-light.png`, `5-viewer-dark.png`                      |

Not mocked: Stats with Photos over time (decision 5 first), Android variants (Material 3 equivalents of the same
structure, as in `mobile-ux-plan.md`).
