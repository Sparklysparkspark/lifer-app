# Phone app: foldables, tablets and large windows

Status: plan only, 2026-11-25. No app code changed. Mockups in the scratchpad (section 6). Builds on
`mobile-alignment.md` (its Decisions hold: the phone is an accessory, not a second Lifer) and `mobile-ux-plan.md`.

## Summary

- **Targets:** iPhone Duo (Apple's foldable, on sale since 23 October 2026), Samsung Galaxy Z Fold, Google Pixel
  Fold, other Android book-style folds, Android tablets and iPad. Surface Duo only through the generic crease rules.
- **One idea:** every screen reads one size class from the window width (compact, medium, expanded). The layout
  widens; it never switches to a different app. Fold posture is optional polish, not a layout input.
- **Today the app is a portrait-only iPhone app.** `app.json` locks portrait, `supportsTablet` is false, the iOS
  target is iPhone only, and nothing reads the window width except Albums and the Gallery aspect mode (a hard-coded
  700). On an open Fold, Android 16 already ignores the lock (the app targets API 36), so Lifer runs full screen
  with 2 stretched columns of 460 px cards. On iPhone Duo the app is scaled or framed as an old iPhone app.
- **Deadlines that make this 1.0 work:** from April 2027, Google Play blocks new apps and updates that miss the
  adaptive Tier 3 bar on foldables and needs 3 foldable screenshots; from August 2027 apps must target API 37, which
  removes every orientation and resize opt-out on large screens.
- **Gaps: 18.** High 5, Medium 9, Low 4 (section 4).
- **Cheapest path:** build the Wave 2 cards, View menu and Filters sheet size-class aware from the start, then one
  foldables wave for navigation, two panes and the viewer.
- **Not run on a device.** This machine has Xcode 26.2 (the iPhone Duo simulator needs Xcode 27.1) and no Android
  SDK or JDK. Everything below is from the code and the sources in section 8.

## 1. How the platforms work

### Android

| Topic                             | Facts                                                                                                                                                                                                                                                                                                                                         | Source                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Window size classes               | Width: compact under 600 dp, medium 600 to 839, expanded 840 to 1199, large 1200 to 1599, extra large 1600 up. Height: compact under 480, medium 480 to 899, expanded 900 up. Classes follow the window, never the device, and change while the app runs                                                                                      | [S1]                                                            |
| Where devices land                | Phones portrait: compact. Unfolded inner screens in portrait: mostly medium. Unfolded in landscape and tablets in landscape: expanded                                                                                                                                                                                                         | [S1]                                                            |
| Android 16 (API 36)               | On displays with smallest width 600 dp or more, `screenOrientation`, `resizeableActivity`, `minAspectRatio`, `maxAspectRatio` and `setRequestedOrientation()` are ignored; apps fill the window, no pillarbox. Opt-out property `android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`                                                | [S2]                                                            |
| Android 17 (API 37)               | The opt-out stops working. Play requires API 37 for new apps and updates from August 2027                                                                                                                                                                                                                                                     | [S2], [S3]                                                      |
| Play adaptive quality, April 2027 | New apps and updates must meet Tier 3 ("Adaptive ready") on foldables, or cannot publish, and must upload 3 foldable screenshots (1:1 inner, 4:3 inner, 10:16 outer) on top of 2 phone ones. Existing un-updated apps stay downloadable                                                                                                       | [S3]                                                            |
| Tier 3                            | Fill the window, no letterbox or compat mode; keep scroll position, typed text and playback through rotation, fold, unfold and resize, and combinations of them; fully working in split screen and multi-resume; camera preview correct in every orientation, fold state and window size; external keyboard, basic mouse, trackpad and stylus | [S4]                                                            |
| Tier 2                            | Layouts by window size class: navigation rail instead of a bottom bar, grids that add columns, multi-pane where useful; bottom sheets, buttons and text fields not full width on large screens; menus next to their item; 48 dp targets; hover and focus states; Esc closes                                                                   | [S5]                                                            |
| Tier 1                            | Tabletop and book postures, multi-instance (badge only, not required)                                                                                                                                                                                                                                                                         | [S3]                                                            |
| Fold and posture                  | Jetpack WindowManager `FoldingFeature` reports the fold bounds, `state` (flat or half opened) and orientation. Tabletop: half opened, horizontal fold. Book: half opened, vertical fold                                                                                                                                                       | [S6]                                                            |
| Continuity                        | Expo's generated `MainActivity` declares `configChanges` including `orientation`, `screenSize`, `screenLayout` and `smallestScreenSize`, so fold, unfold, rotate and resize do not recreate the activity: React keeps its state and only the window size changes                                                                              | Expo SDK 58 template (read in `node_modules/expo/template.tgz`) |
| Split screen                      | Any window size from about a third of the screen. A third of a Fold's inner screen is compact                                                                                                                                                                                                                                                 | [S1], [S4]                                                      |

### iOS and iPadOS

| Topic                | Facts                                                                                                                                                                                                                                                                                                                                                                 | Source                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| iPhone Duo hardware  | Inner 7.6 inch, 1878 x 2670 px, 430 ppi; outer 5.4 inch, 1398 x 2034 px, 460 ppi. Open: 164.6 x 117.8 mm, so it opens wide like a book with the crease running top to bottom. iOS 27                                                                                                                                                                                  | [S7]                               |
| iPhone Duo points    | Inner about **951 x 669 pt** open (669 x 951 turned upright), from the 2007 x 2853 px screenshot size at 3x; outer about **466 x 678 pt**. Not published by Apple; third-party figures                                                                                                                                                                                | [S8], [S9]                         |
| Size classes         | Outer: compact width. Inner full screen: regular width and height. Split View half: assumed compact; not published                                                                                                                                                                                                                                                    | [S9], [S10]                        |
| System chrome        | iOS 27 moves the status bar, tab bar and toolbar into an 84 pt vertical rail on the camera edge (outer display, and inner in landscape). Bars from system containers move by themselves; hand-built bars do not. Split View: the left window is 469 pt wide                                                                                                           | [S11], [S12]                       |
| Apps not rebuilt     | Built with iOS 26 SDK or older: centred, iPhone-sized, empty space around it when open. iOS 27 SDK: resizes, not edge to edge. iOS 27.1 SDK: full screen with the rail. A portrait lock applies on the outer display only; on the inner display the system scales the app                                                                                             | [S10]                              |
| Orientation          | Locks are a preference on iOS 27; `requireFullScreen` no longer opts out                                                                                                                                                                                                                                                                                              | [S11]                              |
| Fold APIs (iOS 27.1) | `UIHingeInteraction` (angle and status: closed, partially open, fully open) for effects, not layout; reserved regions (the fold is a `division`, the inner camera an `occlusion`), outside the safe area; `UIArrangementViewController` for primary and secondary panes that settle either side of the fold. Alerts, menus and sheets move off the fold by themselves | [S11], [S12]                       |
| Scene life cycle     | Required for apps built with the iOS 27 SDK. Lifer already has `SceneDelegate.swift` and a scene manifest                                                                                                                                                                                                                                                             | [S10]                              |
| iPad                 | With `supportsTablet: false` the app runs as a scaled iPhone app on iPad. With it on, iPad brings Split View, Slide Over and Stage Manager: any window size from compact to full, resized live                                                                                                                                                                        | Apple HIG, Layout and Multitasking |
| App Store            | No iPhone Duo specific rule found. Screenshot sizes reported as 1398 x 2034 (outer) and 2007 x 2853 (inner)                                                                                                                                                                                                                                                           | [S10]                              |

### Expo and React Native tools

| Tool                                                                              | What it gives                                                                                                                                                                                                                      | Verdict                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useWindowDimensions` (React Native)                                              | Window width, height, scale and font scale; re-renders on fold, unfold, rotate, split and Stage Manager resize                                                                                                                     | **Enough for 1.0 layout.** Read it at render; never cache a width in state or a ref without updating it [S11]                                                                    |
| `react-native-safe-area-context` (installed)                                      | Insets on all four sides, including the 84 pt iOS rail                                                                                                                                                                             | Use `insets.left` and `insets.right` everywhere, not only top and bottom [S11]                                                                                                   |
| Native tabs (`@react-navigation/bottom-tabs/unstable`, react-native-screens 4.30) | iOS: `UITabBarController`; moves into the iPhone Duo rail when built with the iOS 27.1 SDK; `tabBarControllerMode: 'tabSidebar'` gives the iPad sidebar. Android: Material bottom bar only, no rail                                | Keep on iOS. Android needs its own rail (gap F-12)                                                                                                                               |
| `@react-navigation/bottom-tabs` JS navigator (installed, 7.22)                    | `tabBarPosition: 'left'` draws a side rail; a prop change, not a remount                                                                                                                                                           | The Android rail candidate; spike first (FD-6)                                                                                                                                   |
| `expo-screen-orientation`                                                         | Lock and read orientation                                                                                                                                                                                                          | Not needed: we unlock, not lock                                                                                                                                                  |
| `expo-hinge` (Expo SDK 58)                                                        | Hinge angle and status on Android 11+ (FoldingFeature) and iPhone Duo (iOS 27.1, Xcode 27.1). Hooks `useHinge`, Reanimated entry. Android never reports `closed`; `unknown` when the window does not span the fold. No fold bounds | **Pick this if we do posture.** First-party Expo module, MIT like the rest of the SDK (confirm in its `package.json`), config through the normal dev-client rebuild [S13], [S14] |
| `@logicwind/react-native-fold-detection`                                          | Fold state on Android                                                                                                                                                                                                              | MIT, 0.3.2, last push August 2025, no Expo or New Architecture notes. Fallback only [S14]                                                                                        |
| `react-native-device-info`                                                        | `isTablet()`                                                                                                                                                                                                                       | Device checks are what both platforms tell us not to use; skip                                                                                                                   |
| Own Jetpack WindowManager module                                                  | Fold bounds and posture                                                                                                                                                                                                            | Not for 1.0. Only if we need the exact crease rectangle on Android                                                                                                               |

**Do we need a native module?** Not for 1.0. Window width covers every layout. The crease on every target (Duo,
Galaxy Z Fold, Pixel Fold) runs down the middle of the window when the app spans it, so a two-pane split at the
window centre lands on it. The system keeps sheets, menus and alerts off the fold on iOS. `expo-hinge` is the
optional extra for the tabletop viewer.

## 2. Lifer's design for large windows

### Size classes: one hook

`useSizeClass()` in `src/ui/`, the only place that reads window width for layout:

| Class    | Width      | Typical window                                                                                    | Navigation                                        | Collection                          | Viewer                                         |
| -------- | ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| compact  | under 600  | Phones, Fold and Duo cover screens, split screen at a third or half, iPad Slide Over              | Bottom tabs (as today)                            | One pane, 2 or 3 columns (as today) | As today                                       |
| medium   | 600 to 839 | iPhone Duo upright (669), most Galaxy Z Fold inner screens, iPad portrait, iPad Split View halves | Bottom tabs on iOS (system decides); Android rail | One pane, columns from width        | Full screen; Info as a side sheet in landscape |
| expanded | 840 up     | iPhone Duo open (951), Pixel Fold open, tablets in landscape                                      | System rail or sidebar on iOS; Android rail       | **Two panes**: list and species     | Photo plus an Info pane                        |

It returns `{ width: 'compact' | 'medium' | 'expanded', shortHeight: boolean, columns(min) }`. `shortHeight` (under 480) covers a phone in landscape: no two panes, no tall hero. Pure function plus a hook, so it is unit tested
without a device. Thresholds are the Android ones on both platforms; iOS size classes are not exposed to React
Native and would call the 669 pt Duo regular anyway.

### Navigation

- Same four destinations everywhere: Collection, Gallery, Albums, Identify, and the Your Lifer button. No extra
  destinations appear on large screens (no Stats or Settings in the rail): the layout widens, the app stays the
  same, and the names stay the desktop's.
- **iOS:** keep native tabs. iOS 27.1 puts them in the iPhone Duo rail; on iPad set `tabBarControllerMode` to
  `tabSidebar` at expanded. Your Lifer stays in the navigation bar.
- **Android:** a Material navigation rail at medium and expanded (icons with labels, active pill, 80 dp), Your Lifer
  at the foot. The trip bar moves from above the tab bar to the top of the content pane.

### List and detail

| Screen           | Expanded                                                                                                                                                                                                                                                                      | Medium and compact                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Collection       | Species grid left, species page right. The split sits at the window centre so it lands on the crease of an open fold. Tapping a card replaces the right pane (no push); the selected card has a ring. Nothing selected: the right pane shows the region summary (group bands) | One pane; a card pushes the species page        |
| Gallery          | One pane with more columns; the viewer carries the Info pane (a grid plus Info pane is more than an accessory needs)                                                                                                                                                          | One pane                                        |
| Albums and Trips | Album grid left, the album's photos right                                                                                                                                                                                                                                     | One pane                                        |
| Species page     | As the right pane: hero 16:9 capped at 40 percent of the height, facts below                                                                                                                                                                                                  | Hero height from width (4:3), never a fixed 340 |

Back on Android and the edge swipe on iOS close the right pane's pushed pages first, then leave the list (MR8).

### Grids

- Columns come from width, cards from a minimum size: **Large cards at least 160 pt, Small at least 110 pt**,
  12 pt gaps, never stretched past 1.5 times the minimum. At 390 pt that is 2 and 3 columns (as today); at 669 it
  is 4 and 5; in a 391 pt list pane, 2 and 3.
- The Gallery keeps its pinch ladder but starts from a width-based count; the aspect mode row height moves into the
  hook (today `width >= 700`).
- Text blocks, settings rows, buttons and search fields stop at 640 pt and centre (Tier 2: no full-width buttons or
  fields).

### Photo viewer

- **Expanded:** photo left, a 360 pt Info pane right (the same fields as `PhotoInfoSheet`), always open; the Info
  button toggles it. No lift animation.
- **Medium landscape:** Info opens as a side sheet from the trailing edge, not a bottom sheet.
- Controls never sit on the crease: at expanded the filmstrip centres in the photo pane, not the window.
- Pager width comes from the photo pane, and the current photo stays current when the width changes (F-4).

### Sheets and menus

- iOS: form sheets become centred cards on iPad and the system keeps them off the fold on iPhone Duo. Bar menus are
  `UIMenu` and anchor as popovers by themselves.
- Android at medium and up: sheets get a 640 dp maximum width (Material), and Filters becomes a side sheet. The
  long-press action sheet becomes a menu at the card.

### Cover screens

- Compact rules apply unchanged. The Galaxy Z Fold cover (about 344 x 882 dp) is the narrowest target: 2 columns of
  about 154 dp; long names clamp to 2 lines and the scientific name to 1, as in the mockup.
- iPhone Duo outer (466 x 678 pt) loses 84 pt to the system rail; content is 382 pt, a normal phone width.

### Crease and dual screens

- Nothing tappable or readable within 12 pt of the crease when an open fold is half open. Photos may cross it.
- Two panes split at the crease, so each pane sits on one half.
- Surface Duo (two screens and a real gap) gets the same split; no dedicated work.

### Tabletop (optional)

Half open with the crease across: the photo on the upper half, caption, filmstrip, Share and Info on the lower half.
Needs `expo-hinge` (status `partiallyOpen` plus a window taller than wide). Without it the viewer stays as is.

### Input

Hover and focus states come with the shared `ui/Tap` (Pressable already reports hover on iPad and Android pointer
devices); Esc closes the viewer and sheets; right-click opens the card menu. No keyboard shortcuts: the phone is an
accessory (`mobile-alignment.md`, desktop-only keymap).

### Text size and extremes

- Rules from `ux-rules.md` hold at every class: AX5 falls back to List (today above 1.3x), names clamp, pills wrap.
- At AX5 on expanded the list pane switches to rows and stays two-pane.
- Test seed at 344, 390, 469 (Duo Split View), 669, 951 and 1366 pt wide: 5,000 species, 60-character names,
  60,000 photos.

### Continuity

- Fold, unfold, rotate and resize keep: the tab, the pushed pages, the selected species, the viewer's current
  photo, typed search text, open sheets, and the scroll position.
- Scroll position is kept by **anchor key** (the first visible species or photo id), not by offset or row index,
  because row indexes change when the column count does.
- Android does not recreate the activity (Expo `configChanges`), and iOS keeps the scene, so React state survives.
  Nothing reloads from the store on a size change.
- Going from expanded to compact with a species selected pushes that species page, so the person still sees it;
  going back to expanded puts it in the right pane.

## 3. Mockups

See section 6 for files. Sized from the iPhone Duo figures above; the Galaxy Z Fold cover is included because it
is the narrowest real target.

## 4. Gap list

Severity: High breaks a Play requirement or shows the wrong thing after a fold; Medium is a visible large-screen
defect; Low is polish. Effort: S 1 to 2 days, M 3 to 5 days, L 1 to 2 weeks.

| ID   | Now (file)                                                                                                       | What breaks on a large or changing window                                                                 | Sev    | Effort        |
| ---- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| F-1  | `app.json` `orientation: "portrait"`; iOS plist portrait only                                                    | Android phones and covers locked; iPhone Duo inner display scales the app; rotation never tested          | High   | S             |
| F-2  | iOS build uses Xcode 26.2                                                                                        | iPhone Duo shows a framed iPhone app until built with the iOS 27.1 SDK (Xcode 27.1)                       | High   | S (toolchain) |
| F-3  | `ViewerScreen` and `HeroPager`: paging `FlatList` with `getItemLayout` from window width, no re-scroll on resize | After a fold or resize the pager shows half a photo or a different one; the viewer's index can jump       | High   | S             |
| F-4  | `CollectionScreen` chunks rows by column count; Gallery `buildGrid` rows by width                                | When columns change, the list keeps the old row index and jumps to other species (Tier 3 scroll position) | High   | M             |
| F-5  | No size-class hook; `AlbumsScreen` and `PhotoGrid` hard-code `width >= 700`                                      | Each screen decides on its own; no tests at other widths                                                  | High   | S             |
| F-6  | Collection: fixed 2 or 3 columns                                                                                 | 460 px cards on an open fold, stretched (Tier 2)                                                          | Medium | S             |
| F-7  | Gallery default 3 columns at any width                                                                           | 317 px tiles at 951 pt                                                                                    | Medium | S             |
| F-8  | Species page `HERO = 340`, full width                                                                            | 951 x 340 panorama crop, half the screen on an open Duo                                                   | Medium | S             |
| F-9  | `Screen` pads content 20 pt at any width                                                                         | Settings rows, buttons and fields run the full 951 pt (Tier 2)                                            | Medium | S             |
| F-10 | Android tabs: Material bottom bar only                                                                           | Bottom bar across 840 dp and up instead of a rail (Tier 2)                                                | Medium | M             |
| F-11 | Viewer: Info is a bottom sheet with a lift; filmstrip centred in the window                                      | Filmstrip sits on the crease of an open Duo; sheet wastes the side space                                  | Medium | M             |
| F-12 | Android form sheets (react-native-screens) set no max width                                                      | Full-width sheets on 840 dp and up (unverified; check on device)                                          | Medium | S             |
| F-13 | Viewer chrome, toasts and toolbars use `left: 16` and `right: 16`                                                | Under the 84 pt iOS rail on Duo (outer, and inner landscape)                                              | Medium | S             |
| F-14 | Identify camera preview (`expo-camera`) only seen in portrait                                                    | Tier 3 camera preview in every orientation, fold state and split                                          | Medium | S (test)      |
| F-15 | `TabClearanceContext` assumes a bottom bar                                                                       | Empty band at the bottom when the tabs are a rail                                                         | Low    | S             |
| F-16 | `supportsTablet: false`, iPhone-only target                                                                      | iPad runs a scaled iPhone app (decision 3)                                                                | Low    | S, M to test  |
| F-17 | Test harness renders at 390 x 844 only                                                                           | No test catches the above                                                                                 | Low    | S             |
| F-18 | `SectionHeader` stacks above 1.3x font scale only                                                                | Wide windows could keep one line at large text                                                            | Low    | S             |

Already fine: activity not recreated on Android (Expo `configChanges`), iOS scene life cycle present, safe-area
insets used for top and bottom, native tabs and `UIMenu` adapt by themselves on iOS.

## 5. How this lands in the waves

### In Wave 2 (no extra wave, small extra cost)

| ID   | Scope                                                                                                                                                                                                       | Model  | Effort       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| FD-1 | `useSizeClass()` hook and `columns(min)`; unit tests; harness takes a window size; replace the two `>= 700` checks                                                                                          | Sonnet | S            |
| FD-2 | MA-5 to MA-8 built on it: `SpeciesCard` from a minimum width (never stretched), View menu and Filters sheet declared once with their large-screen presentation (popover and side sheet), bands at any width | Sonnet | +S on Wave 2 |

### Wave F: foldables and tablets (after Wave 3)

| ID    | Scope                                                                                                                                                                                                       | Model                                    | Depends            | Effort |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ | ------ |
| FD-3  | Unlock orientation (decision 2); Xcode 27.1 and iOS 27.1 SDK build; `insets.left` and `insets.right` everywhere; content max width 640                                                                      | Sonnet                                   | maintainer's Xcode | S      |
| FD-4  | Continuity: pagers keep the current photo on resize; lists restore by anchor key; species selection survives class changes; tests that resize the harness and assert the same species and first visible key | Opus                                     | FD-1               | M      |
| FD-5  | Collection and Albums two-pane at expanded, split at the window centre; Species page as a pane; back order                                                                                                  | Opus (navigation state), Sonnet UI       | FD-4               | M      |
| FD-6  | Android rail: spike the JS tab navigator with `tabBarPosition` against native tabs (state kept on switch, predictive back, icons); iOS `tabSidebar` on iPad; trip bar placement                             | Opus spike, Sonnet build                 | FD-1               | M      |
| FD-7  | Viewer: Info pane at expanded, side sheet at medium landscape, filmstrip off the crease, hero sizes from width                                                                                              | Sonnet                                   | FD-4               | M      |
| FD-8  | Android sheets max width; long-press menu at the card on wide windows                                                                                                                                       | Sonnet                                   | FD-6               | S      |
| FD-9  | Optional: `expo-hinge` and the tabletop viewer (decision 5)                                                                                                                                                 | Sonnet, Opus review of the native config | FD-7               | S      |
| FD-10 | Screenshot HIG review at the six widths, light, dark, Sunlight, AX5, extreme seed; Play foldable screenshots                                                                                                | Sonnet                                   | all                | S      |

Rough size: FD-1 and FD-2 add 2 to 3 days to Wave 2; Wave F is about 2 to 3 weeks of conventional effort.

### Test plan

**In CI and on this machine (no new toolchain):**

- Vitest: `sizeClass()` at 0, 343, 599, 600, 669, 839, 840, 951, 1366 and the short-height cases.
- Jest with the existing harness (`src/testing/harness.tsx`): render Collection, Species, Viewer and Gallery at
  344 x 882, 390 x 844, 669 x 951, 951 x 669, 1366 x 1024; assert column counts, one or two panes, no element wider
  than 640 where capped. Then change the window size inside the test and assert the selected species, the viewer's
  photo id and the first visible key are unchanged.
- `check:ui` rule: no `useWindowDimensions().width` outside `ui/useSizeClass` and `photos/`.

**On the maintainer's machine (needs Android Studio with a JDK and Xcode 27.1):**

- Android emulators: "Foldable (1:1 inner display)", "Foldable (4:3 inner display)" (both named in Play's
  screenshot rules), a Pixel Fold profile, the "Resizable" emulator, a 10 inch tablet. Run each Tier 3 test:
  rotate, fold, unfold, split screen at a third, resize, with a scrolled list and typed search text.
- Xcode 27.1 Device Hub: iPhone Duo open, closed, half open, Split View, rotate; an iPad simulator in Split View and
  Stage Manager.
- Surface Duo emulator: skip; Microsoft no longer sells or updates the device (not re-checked in this pass).
- Real devices if at hand: one Galaxy Z Fold, one iPhone Duo. Camera preview in Identify on both.
- Maestro or Detox flows: later. Maestro needs Java on the runner; add it with the Android pass (MA-15), not now.

## 6. Mockups

Static HTML with coloured placeholders, nothing from the maintainer's library. Light and dark, at device size,
2x. Folder: `/private/tmp/claude-501/-Users-judahstarkey-Development-lifer-app/a7e6bee3-8dee-42e2-978c-143148dcb851/scratchpad/mobile-mockups/foldables/`
(rerun with `node shoot.cjs` there). The dashed red band marks the crease and is not part of the design.

| File                   | Window                     | Shows                                                                                                                                         |
| ---------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `1-open-collection`    | iPhone Duo open, 951 x 669 | Rail (four destinations, Your Lifer at the foot), Collection list pane to the crease, species pane right with both tier pills, toggles, facts |
| `2-open-viewer`        | 951 x 669                  | Photo pane with Close and a filmstrip off the crease, Info pane right with Share and the photo menu, View species                             |
| `3-tabletop-viewer`    | 669 x 951, half open       | Photo above the crease; caption, filmstrip, Share and Info below                                                                              |
| `4-upright-collection` | 669 x 951, flat (medium)   | One pane, 4 columns of phone-sized cards, bottom tabs, search capped                                                                          |
| `5-cover-screens`      | 466 x 678 and 344 x 882    | Duo outer with the system rail; Galaxy Z Fold cover with 2 narrow columns and long names                                                      |

Each has `-light.png` and `-dark.png`.

## 7. Decisions for the maintainer

1. **Two panes from 840 wide only?** Recommend **yes**: two panes on an open Duo held normally, a Pixel Fold and
   tablets in landscape; one wider pane on a Duo turned upright and most Galaxy Z Fold inner screens (600 to 839),
   where a list pane would leave the species page too narrow.
2. **Drop the portrait lock everywhere?** iOS 27 treats locks as a preference and scales a locked app on the Duo's
   inner screen; Android ignores it on large screens and will on all of them with API 37. Recommend **unlock on
   every device**; phones in landscape get the short-height rules (no tall hero, viewer full screen).
3. **iPad in 1.0?** Once the screens are size-class aware, iPad costs a build flag, screenshots and a test pass.
   Recommend **yes, after Wave F**; until then keep `supportsTablet: false`.
4. **Card size wording on wide windows.** "2 columns" and "3 columns" (desktop words, decision 1 in
   `mobile-alignment.md`) are wrong at 669 pt, where they mean 4 and 5. Recommend the phone says **Large cards** and
   **Small cards** and the desktop keeps its words, as a named exception to the parity rule. Alternative: change
   both apps.
5. **Tabletop viewer in 1.0?** Needs `expo-hinge` and a native rebuild; only Play's optional Tier 1 asks for it.
   Recommend **after 1.0**; Wave F keeps the viewer's panes ready for it.
6. **Play timing.** If Lifer reaches Google Play after April 2027, FD-3 to FD-8 and the foldable screenshots are
   required before the first upload. Recommend scheduling Wave F before the Android release (MA-15).

## 8. Sources and what is not confirmed

- [S1] Android, Use window size classes: https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes
- [S2] Android 16 behaviour changes (orientation, resizability, opt-out, API 37): https://developer.android.com/about/versions/16/behavior-changes-16
- [S3] Google Play adaptive quality standards, 18 Nov 2026: https://developer.android.com/blog/posts/google-play-adaptive-quality-standards
- [S4] Adaptive app quality, Tier 3: https://developer.android.com/docs/quality-guidelines/adaptive-app-quality/tier-3
- [S5] Adaptive app quality, Tier 2: https://developer.android.com/docs/quality-guidelines/adaptive-app-quality/tier-2
- [S6] Jetpack WindowManager for foldables: https://developer.android.com/codelabs/android-window-manager-dual-screen-foldables
- [S7] Apple, iPhone Duo tech specs: https://www.apple.com/au/iphone-duo/specs/
- [S8] iPhone Duo screen size: https://codeconfig.dev/blog/iphone-duo-screen-size
- [S9] Adapty, Adapt your iOS app to iPhone Duo: https://adapty.io/blog/adapt-your-ios-app-to-iphone-duo/
- [S10] iPhone Duo app checklist: https://dev.to/extensionbooster/iphone-duo-app-checklist-fix-bars-folds-and-scene-crashes-3dhc
- [S11] Expo, Supporting iPhone Duo: https://expo.dev/blog/supporting-iphone-duo
- [S12] MacRumors, how iOS 27 adapts to iPhone Duo: https://macrumors.com/2026/09/10/apple-details-how-ios-27-adapts-to-iphone-duo
- [S13] Expo, `expo-hinge` (SDK 58): https://docs.expo.dev/versions/v58.0.0/sdk/hinge/
- [S14] `@logicwind/react-native-fold-detection`: https://github.com/logicwind/react-native-fold-detection

Not confirmed: iPhone Duo point sizes (third-party, from screenshot sizes at 3x; check in Device Hub); the size
class of a Duo Split View half; whether iOS 27.1 fold APIs are reachable from React Native beyond `expo-hinge`;
`expo-hinge`'s licence text; Android sheet width in react-native-screens; Galaxy Z Fold cover size (about
344 x 882 dp from its 904 x 2316 px panel); Surface Duo support status.
