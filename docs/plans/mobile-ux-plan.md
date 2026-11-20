# Lifer phone app: UX and UI plan

Status: signed off and implemented in `apps/mobile`, 2026-10-26 (see Implementation notes at the end). Proposed 2026-10-25. Mockups: `docs/design/mobile/index.html` (iPhone 16 Pro, light and dark).
This plan replaces the "Mobile-first interface" section of `docs/plans/mobile-implementation-plan.md` for everything visual and
structural. Scope, sync, offline store, pairing and the work packages there stay as they are.

## Why

The first build works but reads as the desktop app squeezed onto a phone. What the maintainer saw on an iPhone:

- Tab names don't match the desktop (Home, Life list, Photos), and the tabs are text only (`tabBarIcon: () => null`).
- Filters are a sideways-scrolling chip strip; search is a custom text box; titles are body content, not navigation bar titles.
- Pages are stacks of full-width buttons and plain rows. The desktop's best feature, the species card, is missing.
- Settings is a text button in Home's corner. Nothing uses the platform's own tab bar, search bar, menus or sheets.

The one part that works is the photo grid. The plan keeps it and rebuilds the rest around the same idea: the person's photos
are the content, and the platform's own parts frame them.

## Principles

1. **Same names as the desktop.** Collection, Gallery, Albums, Trips, Stats, Regions, Settings mean the same things on both. A
   feature that exists on both has one name. Phone-only moments (Identify, trip mode) get names that read well beside them.
2. **A phone app, designed for one hand.** Native tab bar with icons above labels, large titles, search in the navigation bar,
   menus and sheets for choices, primary actions in the lower third (MR2). Nothing scrolls sideways except photos you swipe
   through and the region tree you drill into.
3. **Native parts first.** Use the platform's tab bar, navigation bar, search controller, pull-down menus, context menus, sheets
   and segmented controls. Build our own only for Lifer things (species card, photo grid, stats tiles), and build those once in
   `apps/mobile/src/ui`.
4. **Mirror the desktop's beautiful parts, not its density.** Species cards, the cream and sage palette, taxa colours, the quiet
   map, the black photo viewer. Leave behind toolbars full of controls, side panels and hover states.
5. **Offline is calm.** Every screen opens from the phone's store at once (MR5). Sync state lives in one place (the account
   button and its sheet), never as banners on every screen (MR4, F6).
6. **Holds up at the extremes.** 5,000 species, 60,000 photos, 200 albums, 50 trips, 60-character names, the largest
   accessibility text size, Sunlight appearance, a cracked-screen-bright afternoon outdoors.
7. **No game look.** Plain records, the person's own photos, no celebration, no badges for their own sake (T5, MR9).

## Information architecture

### Tab bar (decided 2026-10-26)

Four tabs, icons above labels, in this order. The maintainer chose four ("Lets go down to 4"): Trips moved inside Albums.

| Tab | What it is | Desktop page | iOS SF Symbol | Android Material Symbol |
|---|---|---|---|---|
| Collection | Species cards for a region or everywhere; seen, targets, not yet photographed | Collection | `square.grid.2x2.fill` | `grid_view` |
| Gallery | Every photo by date, with search | Gallery | `photo.on.rectangle.angled` | `photo_library` |
| Albums | Album covers; an album opens as a photo grid. A native segmented control under the large title switches **Albums | Trips** | Albums, Trips | `rectangle.stack.fill` | `photo_album` |
| Identify | "Is this a lifer?" for a photo or a name | none (phone only) | `binoculars.fill` | `image_search` |

**Albums | Trips.** The Albums tab keeps the large title "Albums" and puts a native segmented control (UISegmentedControl) right under it. The app remembers the last choice. Everything Trips had moves under the Trips segment unchanged: the trips list, trip page, starting a trip, trip mode and "Your targets in [region]". Search and the bar menu adapt per segment: Albums gets the arrange menu, Trips gets the plus button that starts a trip.

Collection opens first, as on the desktop. The app reopens on the last tab used (N3).

**Account button.** Every tab's navigation bar ends with a round `person.crop.circle` button (Android: `account_circle` in the
top app bar), the pattern Apple Music, Photos and the App Store use. It opens the **Your Lifer** sheet:

- Sync status in plain words ("Up to date. Synced with Judah's MacBook Pro 2 min ago", or "Offline. 3 changes will sync when
  you're home") and Sync now. In standalone mode: "Lifer on this phone only" and Connect to a Lifer.
- **Stats**, **Regions** and **Settings**: the rest of the desktop sidebar, under their desktop names.
- Storage used for offline photos, one line.

The button carries a small badge only when something needs the person (a pairing expired, sync failing for a day). Normal
offline is not a badge.

**Where the phone-only moments go:**

- **Identify** is a tab, so "Is this a lifer?" is one tap from launch (the plan asked for two).
- **Trip mode** is the active trip page, opened from the Trips segment of Albums. While a trip is active, a compact **trip accessory** sits above the tab
  bar on every tab, so Trips stays one tap away from anywhere (iOS 26 tab bar accessory, like the mini player in Apple Music; Android: a slim bar docked above the
  navigation bar): trip name, "34 of 212 seen", and a Log button. Tap it for trip mode.
- **Your targets in [region]** is a section of Trips (no location, no nearby claim; location-based likelihood is too sparse to work as people expect).
- **Log sighting** is the primary action on a species page, in trip mode and in an Identify result. Never a tab.
- **Home goes away.** Each of its parts has a better home: trip progress in the accessory and Trips, targets in Trips, recent
  photos at the top of Gallery, the sync line in the account sheet.

### Alternatives considered

| Option | Tabs | Gains | Costs |
|---|---|---|---|
| A (five tabs, superseded 2026-10-26 by the four-tab layout above) | Collection, Gallery, Albums, Trips, Identify; Stats, Regions, Settings in the account sheet | Desktop names on every tab; Identify one tap away; Albums (the "show people my photos" job) one tap away | Stats is one level deeper than on desktop |
| B | Collection, Gallery, Trips, Stats, Identify; Albums inside Gallery (a segmented "Photos / Albums" control at the top, like Photos' Collections) | Stats one tap away | Albums lose their tab; two levels of navigation inside Gallery |
| C | Collection, Gallery, Albums, Trips, plus the iOS 26 search tab (the separate round button at the trailing end) holding universal search and Identify | Matches iOS 26 search conventions; one place to find any species or photo | Identify hides behind "search", which undersells it; Android has no equivalent |
| D | Four tabs plus a "More" tab | Room for everything | "More" tabs are a known anti-pattern; buries Stats and Regions without context |

### Navigation map

```
Tabs
  Collection ─ Species page ─ Photo viewer
      └ region picker sheet (Regions tree), More filters sheet
  Gallery ─ Photo viewer ─ (Info sheet, Share sheet, Add to album sheet)
  Albums ─ [Albums | Trips switch]
      ├ Albums: Album page (Gallery grid) ─ Photo viewer
      └ Trips: Trip page (trip mode) ─ Species page / Log sighting sheet
  Identify ─ result sheet ─ Species page
Account button (any tab) ─ Your Lifer sheet ─ Stats / Regions / Settings
First run: Welcome ─ Connect (scan or code) or Use on this phone ─ choose regions
```

Pushing a detail page (Species, Trip, Album, Stats, Regions, Settings) keeps the tab bar on list-like pages (Album, Stats,
Regions, Settings) and hides it on Species and Trip, where a floating toolbar carries the primary action (MR2).

## Screens

Common layout on iOS (iPhone 16 Pro, 402 by 874 pt; safe area 62 pt top, 34 pt bottom):

- **Navigation bar:** large title (34 pt bold) that collapses to an inline title on scroll; bar buttons as iOS 26 glass circles,
  adjacent buttons grouped in one capsule; account button last.
- **Search:** the native search controller under the large title (`headerSearchBarOptions`), hidden until pulled on Albums and
  Trips, always visible on Collection and Gallery. Cancel returns the exact previous state (N1).
- **Filters and sort:** one filter button (`line.3.horizontal.decrease`) opening a native pull-down menu. Anything that needs
  more than a checkmark (rarity tiers, years, traits) goes in a **More filters** sheet with native list rows and toggles.
  When filters are active, a one-line summary under the title says so in words ("Targets, likely this month") with a Clear
  button. No chips, no pill rows.
- **Side margins** 16 pt for grids and inset groups, 20 pt for titles and text.
- **States:**
  - Loading: local data paints in the first frame; tiles not yet cached show a flat surface-muted square, never a spinner.
    Network-only content (hub search, full-size photo) shows an inline activity indicator where the result will appear.
  - Empty: the shared empty state (symbol, one-line title, one line of why, one button for the next step). Different copy
    for "nothing here yet" and "nothing matches", with Clear filters on the second.
  - Offline: content as usual, the account sheet explains. Hub-only features say once, in place, what they need ("Full size
    needs your Lifer. Showing the saved copy.").
  - Error: inline with Retry, plain words (S1), never a raw message.
- **Android:** the same structure with Material 3: bottom navigation bar with active indicator pills, large top app bar that
  collapses, the M3 search bar at the top, dropdown menus from the top app bar, modal bottom sheets, extended FAB for Log
  sighting, predictive back.

### Collection

The desktop's species cards on a phone. Mockups: "Collection", "Collection filters".

- Title "Collection". Under it, the **region** as a tappable subtitle in the link colour with a chevron ("British Columbia"),
  opening the region picker sheet: Everywhere (the whole life list), recent regions, then the country > group > province tree
  from the regions on the phone, with search. Same scope rules as desktop (N3, N4).
- Search field ("Search species"), live and prefix-aware, same matching as desktop (Q1 to Q4).
- One progress line: "412 of 1,180 species photographed" with a thin sage bar. Tap opens Stats for that region.
- **Grid:** two columns of species cards (about 179 pt wide). Grouped by broad group by default with a section header: the
  group glyph in its taxa colour, the name, and "318 of 402" at the trailing edge. Sticky headers while scrolling.
- **Menu** (filter button), using the desktop toolbar's words:
  - Show: All, Photographed, Seen only, Targets, Not yet photographed (checkmarks, one choice)
  - Arrange: Field guide order, Common name, Scientific name, Photographed first, Seen first, Targets first, Likely this month
  - Group: Broad group, Family group, No grouping
  - Card size: Large (two across), Small (three across, names hidden), List (rows with a thumbnail)
  - More filters: rarity (Common to Legendary), rarity here, endemic, introduced, vagrants, photographed in year
- **Long press** a card: native context menu with preview: Mark as seen, Add to targets, Log sighting, Share. Each has a visible
  alternative on the species page (MR12).
- **Extremes:** 5,000 species render in a recycled list (FlashList or the native collection view); the section index on the
  trailing edge jumps between groups (or letters when arranged by name). Names wrap to two lines and then truncate with the
  full name in the VoiceOver label; scientific names truncate on one line. At accessibility text sizes the grid falls back to
  List.

### Species card (the shared component)

- A square photo (the desktop's card crop, `cardCropUrl` equivalent from the thumbnail cache) with 16 pt corners, and a name box
  in the surface colour: common name in Headline (15 to 17 pt semibold, up to two lines), scientific name in Footnote italic,
  muted. Respects the naming preference (scientific first when chosen).
- At most one badge (the desktop's rule): a glass chip at the top right for Target (`scope`) or Seen only (`eye` plus "Seen").
  Rarity shows as a small tier label under the names only when Arrange is by rarity or the species is Rare or rarer.
- Not yet photographed: the flat group illustration (the maintainer's own SVGs, tinted with the taxa colour) on surface-muted,
  at reduced opacity, as on the desktop.
- Pressed state: a brief scale to 0.97 and a darker overlay, no shadow change.

### Gallery

Mockup: "Gallery". The part the maintainer liked, renamed and polished.

- Title "Gallery", search "Search photos" with dictation. Offline it matches species names and synonyms on the phone; with the
  hub reachable it also runs the hub's photo search and says "Also searching your Lifer" in the results header, not a banner.
- Edge-to-edge grid, 2 pt gutters, three columns by default; **pinch** between 1, 3 and 5 columns (Apple Photos), with the
  same choice in the menu as "Grid size" (MR12). A menu option "Aspect ratio grid" switches to justified rows that keep each
  photo's shape, matching the desktop (L7).
- Month headings with the place ("May 2026, Tofino, British Columbia"), sticky while scrolling. A date scrubber on the trailing
  edge appears on fast scroll and shows the month bubble.
- Menu: Show (All photos, Favourites, edited only), group filter by broad group, Trip, Region, year.
- **Select** at the top right, Photos-style: tap tiles to toggle, drag across to select a run, a bottom toolbar with Share, Add to
  album, Favourite. Select all and Deselect all (D4).
- **Extremes:** 60,000 photos in a recycled grid from the thumbnail cache; the first screenful within 150 ms (MR5), month
  index precomputed in SQLite. Missing thumbnails show the flat placeholder and fill in.

### Photo viewer

Mockup: "Photo viewer". Black in every appearance (BACKDROP stays).

- Opens with a zoom from the tapped tile (iOS 18 zoom transition where available, else a fast crossfade); swipe down or tap
  Close to return to the exact tile (MR8).
- Top: glass Close (`xmark`) and More (`ellipsis`) circles; title is the species name and the date. Tap the photo to hide all
  chrome.
- Bottom: a filmstrip of neighbours, then a floating toolbar: Share (`square.and.arrow.up`), Favourite (`heart`), Info
  (`info.circle`), More. More holds View full size, Add to album, Open species, Set as card photo.
- Pinch and double tap to zoom; swipe between photos. Frame size never jumps (L9): showcase copy, then display, with the
  thumbnail as the placeholder.
- **Info** opens a sheet at the medium detent and the photo slides up above it (Photos' pattern): species row (opens the species
  page), date and place (obscured for sensitive species), camera and exposure, trip, albums, tags.
- Share goes through the system share sheet with the location rules; sensitive species ask once in a sheet (existing logic).

### Species page

Mockup: "Species page".

- A fixed-height hero (about 340 pt) with the card photo under a transparent navigation bar; back and More as glass circles.
  Swipe the hero sideways to see the other featured photos; a page control appears only when there are more.
- Common name (Title 1), scientific name (italic), then group (glyph in taxa colour) and rarity in the current region.
- Status as two equal toggles: **Photographed** (a status, not a button, when there are photos) or **Seen** (toggle), and
  **Target** (toggle). Selection feedback haptic on change; Undo through a toast (F3).
- One inset group of facts: First photographed, Last seen, Sightings (opens the list), Photos.
- Your photos: three-column grid, "14 photos" opens them all in a Gallery grid.
- About (catalog description), collapsed to four lines with "More", only when it's on the phone.
- Floating bottom toolbar: Share circle and the primary **Log sighting** capsule (MR2). Android: an extended FAB.
- More menu: Add to album, Mark as not seen, Don't count this species (the desktop's archive wording), Open in Collection.

### Albums

Mockup: "Albums".

- Title "Albums", plus button to make an album (a sheet with a name field; smart album rules stay on desktop until pulled).
- Two-column cover grid with name (two lines max) and count, like the desktop. Favourites first with a heart glyph; smart
  albums carry a small gear glyph. Arrange menu: Custom, Name, Recently added.
- Album page: the Gallery grid and viewer scoped to the album, title from the album, Share and Select in the bar.
- Extremes: 200 albums scroll fine; a long name wraps to two lines then truncates.

### Trips and trip mode

Mockup: "Trips".

- Title "Trips", plus to start a trip (sheet: name, region from the picker, dates; "before you go" downloads show their size first
  and run in the background, F2).
- **Now:** the active trip as one wide card: cover photo, "Now", name, "Day 3 of 6, Tofino"; body with "34 of 212 species seen",
  "8 targets left", a progress bar and Log sighting.
- **Your targets in [region]:** the person's targets on the current region's checklist, seen but not yet photographed first, then never
  seen, each by difficulty tier (hardest first) then name, as rows with the group illustration and a plain status. No location
  is asked for and nothing claims to be nearby. "See all" opens Collection on Targets.
- **Past trips:** rows with a cover thumbnail, name, dates and species count. Upcoming trips appear above Past.
- **Trip page (trip mode):** large title with the trip name, a native segmented control: Targets, Seen, Photos. Targets is a list
  ordered by seasonality with a one-tap Log on each row (trailing button) and swipe actions with menu equivalents. Floating Log
  sighting at the bottom. End trip in the More menu.
- **Log sighting sheet:** species search field focused, recent and nearby species first, then optional count; Log at the bottom.
  Success haptic, toast with Undo.

### Identify

Mockups: "Identify", "Identify result".

- Title "Identify", one line: "Is this a lifer? Check a photo or a name against your list."
- Search field "Type a species name" at the top; matches show inline with their status ("Seen, no photo yet").
- Recent checks with the person's photo, species and verdict.
- **Choose photo** (primary) and **Take photo** sit in the lower third above the tab bar (MR2). The system picker needs no
  library permission; the camera is asked for when tapped (MR10).
- Until the on-device model ships, a quiet footnote above the buttons says photo matching is coming and that the name does
  the finding. No banner, no warning colour.
- **Result sheet** over the person's photo: species names, the verdict in a sage-tinted panel in plain words ("New for your life
  list", "Seen, no photo yet", "Photographed, 12 photos" with their best photo beside it to compare), then Mark as seen
  (primary), Add to Lifer (queues the photo with the chosen species) and Target, and "Not this one? Change species". Nothing is added without a tap (P-16).
- When the model ships, the sheet shows the top suggestions as rows with confidence in words, the same verdict for each.

### Stats

Mockup: "Stats". Opened from the account sheet and from Collection's progress line.

- Title "Stats", and the desktop's "Photos to count" choice as the subtitle menu (All keepers, Featured only, Top rated).
- Four number tiles: species photographed, seen without a photo, photos, countries.
- Species by group: horizontal bars in taxa colours, direct labels. New species by year: sage columns.
- Most photographed, One-and-done species and Could use a better photo as rows that open filtered Collection or Gallery views.
- Export CSV stays on the desktop. Offline shows the last synced numbers with the date in the footer.

### Regions

- Pushed from the account sheet; the region picker in Collection reuses its tree.
- Title "Regions", "On this phone" group: each region with progress ("318 of 1,180") and size, swipe or long press to remove
  (with a menu equivalent and a system alert to confirm, MR3).
- Add region: a sheet with search and the country > group > province tree, download size before the tap, background download
  with progress on the row (F2, F4).

### Settings

- Native grouped list (inset groups, label left, control right, L3). Sections: Connection, Appearance (System, Light, Dark,
  Sunlight as a native picker), Names (Common first, Scientific first), Photos on this phone (cache size, Wi-Fi only, clear),
  Adding photos (watched album, suggestions, both opt-in), Privacy (location on shared photos), About and licences.
- Technical words stay where they're the right words (Automatic URL Switching on desktop; on the phone the hub address and
  certificate fingerprint live under Connection, Advanced).

### First run

- Welcome: the Lifer mark, one sentence, two large buttons in the lower third: Connect to my Lifer, Use on this phone only.
- Connect: the camera scanner full screen with a glass Close and "Type the code instead" (existing logic).
- Use on this phone: the region picker, then straight into Collection.

## Visual design

### Typography

System fonts (SF Pro on iOS, Roboto Flex or the device font on Android), matching the desktop decision to keep system faces.
Every style scales with Dynamic Type and Android font scale.

| Lifer style (desktop name) | iOS text style | Size at default | Android M3 | Used for |
|---|---|---|---|---|
| large-title | Large Title | 34 pt bold | Headline Large | Tab and page titles |
| title-1 | Title 1 | 28 pt bold | Headline Medium | Species name on its page |
| title-2 | Title 2 | 22 pt bold | Headline Small | Trip name on its card, sheet titles |
| title-3 | Title 3 | 20 pt semibold | Title Large | Section headers ("Birds", "Your targets") |
| headline | Headline | 17 pt semibold | Title Medium | Row titles that need weight, button labels |
| body | Body | 17 pt | Body Large | Rows, text |
| callout | Callout | 16 pt | Body Medium | Notes |
| subheadline | Subheadline | 15 pt | Body Medium | Card names, row subtitles |
| footnote | Footnote | 13 pt | Body Small | Scientific names on cards, meta lines |
| caption | Caption 1 / 2 | 12 / 11 pt | Label Medium / Small | Tier labels, tab labels (system) |

`apps/mobile/src/theme/theme.ts` currently reuses the desktop rem sizes; replace `type` with these iOS sizes and use
`allowFontScaling` (default) everywhere. Never set a maximum font multiplier on content text.

### Spacing and shape

- 16 pt side margins for grids and groups, 20 pt for titles; 12 pt between cards; 24 to 28 pt between sections.
- Corners concentric with the device: species cards 16 pt, inset groups 22 pt, sheets 38 pt at the top, buttons are capsules,
  Gallery tiles square with no corners (Photos' look), album covers 14 pt.
- Touch targets 44 pt minimum (48 dp on Android), including the badge on a card (the whole card is the target) (MR1).

### Colour

- Tokens from `apps/web/src/theme.css` through `@lifer/shared` (already wired): canvas cream `#f6eedc`, surface `#fbf7ee`,
  surface-muted `#f1e8d4`, ink `#242c34`, sage accent `#68745e`, link sage `#4e5a45`; dark canvas `#141516`, surface `#1c1e1f`,
  link `#b3c0a5`.
- **Tint:** sage link colour for the selected tab, bar buttons' active state, links and toggles that are on. Primary buttons are
  sage fill with white text (4.9:1).
- **Taxa colours (option B)** only for group identity: section glyphs, the group label on a species page, chart series, the
  not-yet-photographed illustration. Never as button colours.
- **Glass:** the native material on iOS 26 takes the canvas tint; on iOS 18 to 25 the bars use the system chrome material.
  Custom floating pieces (species toolbar, trip accessory if the navigator lacks it) use `expo-glass-effect` where available
  and a translucent surface with blur otherwise.
- **Sunlight:** the existing phone-only appearance (pure ink on white, 7:1 text, 4.5:1 controls, MR6). It also turns off glass
  translucency (solid bars), thickens separators to 1 pt, and makes tier labels and badges solid. Offered in Settings and as a
  Control Center style quick toggle later.
- Dark mode follows the system by default (T1), including the launch screen, sheets and the overscroll area.

### Iconography

SF Symbols on iOS through `expo-symbols` (they scale with Dynamic Type and match the system's weight); Material Symbols
Rounded on Android. One meaning per icon (T6):

| Meaning | iOS | Android |
|---|---|---|
| Collection | `square.grid.2x2.fill` | `grid_view` |
| Gallery | `photo.on.rectangle.angled` | `photo_library` |
| Albums | `rectangle.stack.fill` | `photo_album` |
| Trips | `map.fill` | `map` |
| Identify | `binoculars.fill` | `image_search` |
| Account and sync | `person.crop.circle` | `account_circle` |
| Stats | `chart.bar.fill` | `bar_chart` |
| Regions | `globe.americas.fill` | `public` |
| Settings | `gearshape.fill` | `settings` |
| Search | `magnifyingglass` | `search` |
| Filter and sort menu | `line.3.horizontal.decrease` | `filter_list` |
| More | `ellipsis` | `more_vert` |
| Target | `scope` | `my_location` |
| Seen | `eye` | `visibility` |
| Photographed | `checkmark.circle.fill` | `check_circle` |
| Log sighting | `mappin.and.ellipse` | `add_location_alt` |
| Favourite | `heart` / `heart.fill` | `favorite` |
| Share | `square.and.arrow.up` | `share` |
| Info | `info.circle` | `info` |
| Take photo | `camera` | `photo_camera` |
| Choose photo | `photo.on.rectangle` | `add_photo_alternate` |
| Smart album | `gearshape` (small) | `auto_awesome_motion` |
| Sync | `arrow.triangle.2.circlepath` | `sync` |
| Offline | `wifi.slash` | `wifi_off` |

Group glyphs (bird, mammal and so on) are the maintainer's own illustrations, not SF Symbols, so they match the desktop.

## Motion and haptics

- Native push, sheet and menu animations only; no custom page transitions. Zoom transition into the viewer where supported.
- Large titles collapse on scroll; the iOS 26 tab bar minimises on scroll down in Gallery and Albums (`tabBarMinimizeBehavior`),
  never in Collection, where the bar is used constantly.
- Reduce Motion: crossfades instead of zooms, no parallax on the species hero.
- Haptics (MR9, only to confirm): selection feedback when Seen or Target changes, success notification when a sighting is
  logged or a photo is queued for Lifer, a light impact when a long press opens a context menu (system-provided). Nothing on
  scroll, tab change or opening screens.

## Accessibility

- **Dynamic Type to AX5.** Collection switches to List at accessibility sizes; Gallery keeps the grid (photos don't scale) but
  month headings wrap. Tab labels use the system's large content viewer (long press on a tab), free with the native tab bar.
  Buttons in the lower third stack vertically when their labels don't fit side by side. Screenshot sweep at AX5 (MR7).
- **VoiceOver labels:**
  - Species card: "Pileated Woodpecker, Dryocopus pileatus. Photographed, 14 photos. Uncommon." Custom actions: Mark as seen,
    Add to targets, Log sighting.
  - Photo tile: "Pileated Woodpecker, 12 May 2026, Stanley Park." Selected state announced in Select mode.
  - Section header: "Birds, 318 of 402 photographed", marked as a header for the rotor.
  - Account button: "Your Lifer. Up to date." or "Your Lifer. 3 changes waiting to sync."
  - Trip accessory: "Vancouver Island trip, 34 of 212 seen. Opens trip mode." with Log as a separate element.
- Bold Text, Increase Contrast (maps to Sunlight-strength separators), Reduce Transparency (solid bars), Smart Invert (photos
  excluded with `accessibilityIgnoresInvertColors`).
- Android: TalkBack labels from the same strings, 48 dp targets, font scale to 200%.

## Components

What changes in `apps/mobile/src/ui` and the navigator. Native first; every new dependency needs the maintainer's approval
(see decisions).

| Need | Use | Replaces |
|---|---|---|
| Tab bar | React Navigation's native bottom tabs (`createNativeBottomTabNavigator` from `@react-navigation/bottom-tabs/unstable`, backed by `react-native-screens`): real `UITabBarController` with Liquid Glass, SF Symbol icons, minimise on scroll, and Material bottom navigation on Android. Fallback: the JS tab bar with `expo-symbols` icons | Text-only JS tabs in `App.tsx` |
| Large titles | native-stack `headerLargeTitle`, `headerTransparent`, per-tab stacks | `Heading` used as a page title, `Screen`'s manual top padding |
| Search | native-stack `headerSearchBarOptions` (`UISearchController`, Android `SearchView`) | `TextField` used as a search box on Life list, Photos, Identify, Regions |
| Bar buttons and menus | native-stack header items with native menus where the installed `react-native-screens` supports them; otherwise `@react-native-menu/menu` (`UIMenu`, Android popup menu) | Text buttons in the header row, `Chip` strips |
| Context menus | `@react-native-menu/menu` with long press, or `@expo/ui` context menu if it is already in the SDK | none today |
| Sheets | native-stack `presentation: "formSheet"` with `sheetAllowedDetents` and grabber | `ui/BottomSheet.tsx` (custom modal) |
| Segmented control | `@react-native-segmented-control/segmented-control` or the `@expo/ui` picker | none |
| Icons | `expo-symbols` (`SymbolView`) on iOS, Material Symbols font on Android, behind one `ui/Icon.tsx` | none (no icons today) |
| Species card | new `ui/SpeciesCard.tsx` (photo, name box, one badge, placeholder illustration, VoiceOver actions) | `screens/parts/SpeciesRowItem.tsx` as the main view (kept for List size) |
| Section header | new `ui/SectionHeader.tsx` (glyph, title, count, sticky) | `Heading level="section"` |
| Inset group and rows | restyle `ui/ListRow.tsx` into `ui/InsetGroup.tsx` + `ListRow` (icon tile, value, chevron, separators inset) | plain `ListRow` stacks |
| Buttons | `ui/Button.tsx` gains `capsule` primary and secondary sizes, icon slot, and a busy state | full-width stacked buttons |
| Floating toolbar | new `ui/FloatingToolbar.tsx` (glass on iOS, extended FAB on Android) | buttons in page content |
| Trip accessory | native tab bar accessory if the navigator exposes it, else `ui/TripAccessory.tsx` above the tab bar | Home's trip row |
| Empty state | `ui/EmptyState.tsx` gains a symbol, title, line and one action | text-only empty states |
| Photo grid | keep `photos/PhotoGrid.tsx` and `Scrubber.tsx`; add pinch column change, select mode, sticky month headers with place | |
| Viewer | keep `ViewerScreen` logic; new chrome (glass circles, filmstrip, toolbar, Info sheet); Android pinch zoom needs `react-native-gesture-handler` and `react-native-reanimated` | current Close/Share button row |
| Stats | new `ui/StatTile.tsx` and two small bar charts in plain views (no chart library) | none |
| Glass | `expo-glass-effect` for custom floating pieces on iOS 26, blur fallback | none |
| Haptics | `expo-haptics` (installed) through one `ui/haptics.ts` with the three allowed calls | |

Removed from `ui`: `Chip.tsx` (filters become menus), `Page.tsx` and `Screen.tsx` title handling (the navigator owns titles),
`Banner.tsx` for status messages (toasts and inline notes instead). `check:ui` gains a rule: no horizontal `ScrollView`
outside `photos/` and the viewer.

## Mapping: current screen to new screen

| Current | New | Thrown away |
|---|---|---|
| Home tab | Removed. Active trip: trip accessory and Trips. Your targets in a region: Trips. Recent photos: top of Gallery. Sync line: account sheet | The tab, the "Settings" text button, stacked plain rows, the horizontal recent-photos strip |
| Life list tab | **Collection** tab | The name "Life list", the chip strip, the custom search box, the count note, row-only list as the default view |
| Identify tab | **Identify** tab with result sheet | The warning banner about the model, inline result buttons stacked in the page |
| Trips tab | **Trips** segment of Albums | Plain list layout; gains Now card, Your targets, Past trips |
| Photos tab | **Gallery** tab | The name "Photos", the custom search box and hint text |
| Species screen | **Species page** | Three stacked full-width buttons, status as a sentence, Banner for "logged" (becomes a toast with Undo) |
| Trip screen | **Trip page (trip mode)** with segmented control and Log sighting sheet | Custom BottomSheet for logging |
| Viewer screen | **Photo viewer** with toolbar and Info sheet | Text Close and Share buttons, position text ("3 of 40") |
| Regions screen | **Regions** (from the account sheet) and the region picker sheet | "Keep" text as a trailing control, inline add mode with Done |
| Settings screen | **Settings** (from the account sheet), native grouped list | Headings with loose buttons |
| Welcome, Connect, Pair | Same flows, restyled: lower-third buttons, full-screen scanner | |
| none | **Albums** tab and Album page; **Stats** page; **Your Lifer** sheet | |

## Build order

1. Navigator and shell: native tabs with icons, per-tab native stacks with large titles and search, account button and sheet,
   rename tabs and i18n keys (`tabs.collection`, `tabs.gallery`, `tabs.albums`). Remove Home.
2. Shared parts: `Icon`, `SpeciesCard`, `SectionHeader`, `InsetGroup`, capsule `Button`, `EmptyState`, `FloatingToolbar`,
   haptics, the new type scale.
3. Collection with the menu and More filters sheet; Gallery polish (pinch, select, headers).
4. Species page and viewer chrome with the Info sheet.
5. Trips, trip page, Log sighting sheet, trip accessory.
6. Albums and Album page (needs the album list and membership already synced).
7. Identify and its result sheet; Stats; Regions and Settings restyle.
8. Accessibility sweep (AX5, VoiceOver, Sunlight), Android pass, extreme fixture sweep, HIG screenshot review of every screen.

Each step ends with screenshots in light, dark and Sunlight on iPhone and a mid-range Android, reviewed against this plan,
`ux-rules.md` (sections 1 to 16) and the HIG checklist.

## Decisions for the maintainer

1. **Tab bar layout.** Decided 2026-10-26: four tabs (Collection, Gallery, Albums, Identify), Trips inside Albums behind an
   Albums | Trips segmented control; Stats, Regions, Settings in the account sheet.
2. **Drop Home.** Recommendation: yes; its parts move to Trips, Gallery and the account sheet, and the tab goes to Albums.
3. **Collection default scope.** Recommendation: open on the last region chosen, with "Everywhere" (the whole life list) as the
   first choice in the picker and the default for a brand-new standalone user with no region yet.
4. **Species cards on the phone.** The implementation plan said "never collectible cards". Recommendation: use the desktop's
   card look (photo plus name box, one badge, no points or rarity frames), which reads as a field guide plate, not a game.
5. **Native tab bar API.** Recommendation: React Navigation's native bottom tabs (marked unstable) for real Liquid Glass and
   accessibility for free, with the JS tab bar plus `expo-symbols` as a fallback if it misbehaves on Android.
6. **New dependencies** (all MIT or Apache-2.0, no network calls): `expo-symbols`, `@react-native-menu/menu`,
   `@react-native-segmented-control/segmented-control`, `expo-glass-effect`, `react-native-gesture-handler` and
   `react-native-reanimated` (Android pinch zoom and grid pinch), `@shopify/flash-list` (5,000 species and 60,000 photos).
   Recommendation: approve all; `@expo/ui` can replace the menu and segmented packages later if it covers both platforms.
7. **Gallery grid default.** Recommendation: square tiles, three across (Apple Photos), with the desktop's aspect ratio grid as
   a menu choice. Alternative: aspect ratio grid by default for desktop parity.
8. **Trip accessory.** Recommendation: show it on every tab while a trip is active, with a "Hide during this trip" item in its
   long press menu.
9. **Account button glyph.** Recommendation: `person.crop.circle`. Alternative: the Lifer mark in a circle, which says "your
   Lifer" without implying an account in desktop-only mode.
10. **Sunlight in Control Center.** Recommendation: later; Settings only for 1.0.

## Implementation notes (2026-10-26)

Built as signed off: every decision above was taken as recommended. Verified on an iPhone 17 Pro simulator (iOS 26.5) in light,
dark, Sunlight and the largest accessibility text size; not yet run on Android hardware or a phone.

### Spike outcomes

- **Native tabs:** `createNativeBottomTabNavigator` from `@react-navigation/bottom-tabs/unstable` works: real `UITabBarController`,
  Liquid Glass, SF Symbol icons, minimise on scroll in Gallery and Albums. No fallback needed on iOS.
- **Trip bar above the tab bar:** the navigator's `bottomAccessory` option works and shows on every tab while a trip is active.
  Hiding it per trip is kept in Settings data (`hiddenTripBar`) and offered from a long press and from the trip page.
- **Header buttons and menus:** native-stack `unstable_headerRightItems` gives real glass bar buttons, grouped capsules, badges and
  native `UIMenu` menus (Show, Arrange, Group, Card size). `@react-native-menu/menu` 2.0.0 does not compile against React Native 0.88
  (`RCTBridge.h`), so it is not used. Long press on a card opens the system action sheet instead of a context menu with a preview;
  `@expo/ui`'s context menu would restore the preview if it is approved later.
- **Sheets:** native-stack `formSheet` with detents and grabber works for every sheet. A sheet with no header drew blank, so every
  sheet has the small title bar with Done.
- **Large titles:** a scroll view must sit inside a plain `View` under the screen, or the large title starts collapsed.
- **expo-symbols on Android:** its types take Material Symbols and `unstable_getMaterialSymbolSourceAsync` draws tab icons; wired but
  not run on a device.
- **Pinch:** react-native-gesture-handler 3 needs `react-native-worklets`; `react-native-reanimated` is not needed and is not installed.

### Deviations from the mockups and plan

- Stats, Regions and Settings push over the tab bar from the account sheet (the sheet closes first), not under it.
- The region picker is a flat list (Everywhere, recent, regions on the phone): the phone holds no country > group > province data.
- Collection has no Field guide order, Family group or Likely this month (the phone holds no taxonomy or seasonality), and no endemic or
  introduced filters (no data). It adds Rarity as an arrangement.
- Group glyphs are SF Symbols and Material Symbols, not the maintainer's illustrations (no SVG library approved).
- Stats shows "regions on this phone" where the mockup shows countries (no country data on the phone).
- Not built because the sync engine can only send marks to the hub: making an album, Favourite and Add to album, Set as card photo,
  Select mode with a toolbar, Add to Lifer from Identify, a count on Log sighting, and "Don't count this species".
- The viewer opens with a fade, not a zoom from the tile; the Info sheet lifts the photo above it.
- Card photos are centred crops, not the desktop's saved card crop.
- Camera and Material icons for the Android tab bar, the Android pinch zoom and the Android menus are untested.

