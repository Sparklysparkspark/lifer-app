# Keyboard shortcuts

Lifer follows Adobe Lightroom Classic's keys wherever Lightroom has a key for the same action, so a
photographer's muscle memory carries over. Where Lightroom has no key, Lifer follows the platform
(macOS, Windows, Linux) and then the most common photo viewers (Apple Photos, Photo Mechanic).

This file is the convention table. The code version is `apps/web/src/lib/keymap.ts` (package U-13),
which is the single source of truth: no component listens for its own keys.

## Rules

1. **One registry.** Every binding is an entry in `lib/keymap.ts`: action id, default key per platform,
   label, where it applies. Components call the registry; tooltips, menus, the palette and the shortcut
   sheet read their labels from it.
2. **Same key, same meaning, everywhere in Lifer.** A key never means one thing on one screen and
   something unrelated on another.
3. **Lightroom first.** If Lightroom has a key for the action, use it. Then the platform, then the
   majority of photo viewers. Record the source in the table.
4. **Reserved keys stay free.** A key in the reserved list below is never bound to anything else, even
   if Lifer has no use for it yet.
5. **Position keys use `event.code`.** Digits (`Digit0` to `Digit9`, plus the numpad) and brackets
   (`BracketLeft`, `BracketRight`) are matched by position, so they work on AZERTY and other layouts.
   Letters with a meaning (P for pick, F for full screen) and symbols (`?`, `+`, `-`) are matched by
   `event.key`, so the printed letter works.
6. **Mod** means Cmd on macOS and Ctrl on Windows and Linux. Labels come from `shortcutLabel()` in
   `lib/platform.ts` (P-01).
7. **Never while typing.** Bare-key shortcuts are ignored while focus is in a text field
   (`isTypingTarget`). Mod chords for app-wide actions (palette, settings, pages) still work.
8. **Tab stays focus navigation** for keyboard and screen reader users (decided, choice 3).
9. **Server web app:** chords the browser owns (Mod+1 to 9, Mod+W, Mod+T) are only bound in the
   desktop app; on the web they show in the palette instead.

## Shared table

"Today" is what Lifer does now. "Change" means U-13 changes it.

### Navigation and views

| Action | macOS | Windows and Linux | Today | Source |
|---|---|---|---|---|
| Next, previous photo | Right, Left | Right, Left | Lightbox, Compare (focused pane), Tour steps | Lightroom |
| Next, previous group | Down, Up | Down, Up | Import review: next, previous photo, never confirming | Lightroom (rows), majority |
| Open photo (single view) | Enter or E | Enter or E | Click only. Change: add | Lightroom (E), majority (Enter) |
| Back to grid | G or Esc | G or Esc | Esc. Change: add G | Lightroom |
| Peek at photo from grid | Space | Space | None. Change: add | Apple Photos, Lightroom |
| Compare selected photos | C | C | Toolbar button. Change: add | Lightroom |
| Compare an import photo with its suggested species | C | C | Import and trip scan review | Lightroom (C) |
| Highlight suggestion 1 to 5 (import review and compare) | 1 to 5 | 1 to 5 | Import review highlights on the outlined photo; compare shows that species. Right, Left page the species' photos in compare | Lifer |
| Undo the last confirm or clear (import review) | Cmd+Z | Ctrl+Z | Import review | Platform |
| Clear a photo's species (import review) | Backspace | Backspace | Import review | Lifer |
| Not wildlife: leave the photo out (import review and compare) | Cmd+Backspace | Ctrl+Backspace | Import review, compare | Lifer (not S: in compare a letter starts the species search) |
| Full screen photo | F | F | Lightbox only. Change: also Compare | Lightroom |
| Previous, next version of the photo (prints, edits, exports) | Option+Left, Option+Right | Alt+Left, Alt+Right | Lightbox (V-18). Left and Right page photos and `[` `]` are the encounter keys, so neither fits; free in Lifer, the culling app and Lightroom | Lifer |
| Manage versions (the Versions panel) | Shift+A | Shift+A | Lightbox, any still photo | Lifer (alternates; Lightroom's S expands a stack but S is Change species, and Shift+G is the companion app's) |
| Use the version on screen as the photo | Shift+U | Shift+U | Lightbox version strip, Versions panel | Lifer (Lightroom moves to top of stack; Shift+S is the companion app's) |
| Link to another photo (as a version of it) | Cmd+G | Ctrl+G | Lightbox (opens the picker), Versions panel | Lightroom (group into stack) |
| Split out a version | Cmd+Shift+G | Ctrl+Shift+G | Lightbox version strip, Versions panel | Lightroom (unstack) |
| Link the focused suggested version; keep it apart | Cmd+G; Cmd+Shift+G | Ctrl+G; Ctrl+Shift+G | Import page version suggestions | Lightroom (group, unstack) |
| Link all suggested versions | Cmd+Enter | Ctrl+Enter | Import page version suggestions | Lifer |
| Show or hide info | I (also Mod+I) | I (also Ctrl+I) | None. Change: add | Lightroom (I), Apple Photos (Cmd+I) |
| Close, back, clear selection | Esc | Esc | Dialogs, menus, Lightbox, Compare, Gallery select mode | Platform |
| Show or hide sidebar | Ctrl+Cmd+S | Ctrl+Alt+S | Desktop menu | macOS Mail and Finder |
| Pages in sidebar order | Cmd+1 to Cmd+9 | Ctrl+1 to Ctrl+9 | Desktop Go menu, 1 to 6 | Platform (U-07) |
| Command palette | Cmd+K | Ctrl+K | Yes | Platform |
| Find | Cmd+F | Ctrl+F | Desktop menu, opens the palette | Lightroom, platform |
| Settings | Cmd+, | Ctrl+, | Desktop menu | Platform |
| Import photos | Cmd+Shift+I | Ctrl+Shift+I | Cmd+I. Change: move | Lightroom |
| Shortcut sheet | ? | ? | None. Change: add | Majority of web and photo apps |

### Zoom

| Action | macOS | Windows and Linux | Today | Source |
|---|---|---|---|---|
| Toggle fit and 100% | Z, or Space on a photo | Z, or Space on a photo | None. Change: add | Lightroom |
| Fit to window | Cmd+0 | Ctrl+0 | Lightbox, Compare, map region view (Reset view) | Lightroom, Photoshop |
| Zoom in, out | Cmd+= and Cmd+-; bare + and - also work | Ctrl+= and Ctrl+-; bare + and - also work | Compare: bare + and - only. Change: add Mod chords, add to Lightbox | Lightroom, platform |
| Card size larger, smaller (grids) | = and - | = and - | View menu only | Lightroom (grid) |

### Rating and marking

| Action | macOS | Windows and Linux | Today | Source |
|---|---|---|---|---|
| Set 1 to 5 stars | 1 to 5 | 1 to 5 | Lightbox (same key twice clears), Compare | Lightroom |
| Clear stars | 0 | 0 | Compare only. Change: add to Lightbox | Lightroom |
| Rate and move to next | Shift+0 to Shift+5 | Shift+0 to Shift+5 | None. Change: add | Lightroom |
| Red, yellow, green, blue label | 6, 7, 8, 9 | 6, 7, 8, 9 | Reserved (no labels yet) | Lightroom |
| Pick, reject, unflag | P, X, U | P, X, U | Reserved; bound only where Lifer shows flags read from XMP | Lightroom |
| Change species | S | S | Lightbox button. Change: add. Gallery S (select mode) moves | Lifer |
| Mark "needs a better photo" | B | B | Reserved (planned want-list) | Lifer |
| Feature as species photo | K | K | Compare: F. Change: move | Lifer (decided, choice 1) |
| Set album cover | none (menu) | none (menu) | Compare: C. Change: remove key | Lifer |

### Selection and editing

| Action | macOS | Windows and Linux | Today | Source |
|---|---|---|---|---|
| Select all | Cmd+A | Ctrl+A | Gallery | Platform |
| Select none | Cmd+Shift+A | Ctrl+Shift+A | Gallery, iNaturalist cards | Platform, Lightroom |
| Move to trash (asks first) | Delete or Backspace; Cmd+Backspace from the menu | Delete or Backspace; Ctrl+Backspace from the menu | Gallery, desktop menu | Platform, Lightroom |
| Confirm dialog | Enter | Enter | Delete dialogs, Modal | Platform |
| Undo, redo | Cmd+Z, Cmd+Shift+Z | Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z | Text fields only (native Edit menu) | Platform |
| Undo the last location change (map page, outside text fields) | Cmd+Z | Ctrl+Z | `undoLocation`, map scope (MAP-06) | Platform |
| Rotate left, right | Cmd+[ and Cmd+] | Ctrl+[ and Ctrl+] | Reserved | Lightroom |
| Open in external editor | Cmd+E | Ctrl+E | Reserved (I-02) | Lightroom (decided, choice 2) |
| Export | Cmd+Shift+E | Ctrl+Shift+E | Album export button. Change: add | Lightroom (decided, choice 2) |

### Video (Lightbox)

| Action | macOS | Windows and Linux | Today | Source |
|---|---|---|---|---|
| Play, pause | Space | Space | Yes | Every media player |
| Step back, forward one frame | , and . | , and . | New (N-06) | Video players |
| Skip back, forward 10 s | Shift+Left, Shift+Right | Shift+Left, Shift+Right | Bare arrows. Change: move (decided, choice 4) | Lifer |

## Reserved keys

Lifer does not use these yet. They keep their Lightroom meaning and are never bound to anything else:
`N` (survey view), `O` (focus point and subject overlay), `L` (lock zoom), `Shift+Z` (back to the last
zoom spot), `Shift+X` (reject the rest of a group), `Shift+C` (crop), `[` and `]` (previous, next
encounter), `Option+Up` and `Option+Down` (`Alt` on Windows and Linux, previous and next encounter),
Caps Lock (move to next after every mark), `T` (toolbar), `D` (develop), `R` (crop tool), `Y` (before
and after), `V` (black and white).

Reserved for the companion culling app, so the two apps stay consistent: `T` (show or hide the culling app's
decision bar, Lightroom's Show/Hide Toolbar, which Lifer already reserves) and `Mod+Alt+Shift+E` (Export
with Previous, a Lightroom chord) and `Mod+Alt+F` (the culling app's second pass view) and `H` (zoom to the animal's eye, 100 percent) and `Shift+G` (scenes view) and `Shift+S` (split a burst).

## Conflicts in Lifer today

1. **F** is full screen in Lightbox but "feature this photo" in Compare. Lightroom: F is full screen.
2. **C** is "set album cover" in Compare. Lightroom: C is compare.
3. **S** toggles select mode in Gallery. It is the change species key in the shared table.
4. **Cmd+I** opens Import. Lightroom uses Cmd+Shift+I for import, and Cmd+I is info on macOS.
5. **0** clears stars in Compare but does nothing in Lightbox.
6. **Zoom:** Compare uses bare `+` and `-`; Lightbox has no zoom keys; neither has Mod+= and Mod+-.
7. **Arrows on video** skip 10 s instead of moving to the next item, so Left and Right mean two
   things inside one Lightbox.
8. **Import review (fixed 2026-11-10):** Down used to act like Right (next suggestion) and Up undid the
   last confirm. Now Up and Down only move between photos, Left and Right (or 1 to 5) move the
   highlight, Backspace clears and Cmd/Ctrl+Z undoes.
9. **Digits use `event.key`,** so stars fail on AZERTY keyboards (where `1` needs Shift).
10. **Separate listeners** (useKeyboardShortcuts, Lightbox, Compare, import review, Tour, palette)
    each parse keys their own way; nothing shows the user which keys exist.

## Decided (maintainer, 2026-10-23)

All five recommendations below were accepted.

1. **Feature key.** Lightroom has no "feature" action. Recommendation: `K`, which is free in
   Lightroom's Library module and in this table. Alternative: menu only.
2. **Mod+E.** Lightroom: Mod+E opens the photo in an external editor and Mod+Shift+E exports. Several
   newer photo apps use Mod+E for export. Recommendation: follow Lightroom.
3. **Tab.** Lightroom hides the side panels with Tab, but Tab is how keyboard and screen reader users
   move between controls. Recommendation: keep Tab for focus; panels use the sidebar chord and `I`.
4. **Video arrows.** Recommendation: arrows always move between items; Shift+Left and Shift+Right skip
   10 s. Alternative: keep today's behaviour (skip, then move at either end).
5. **Select mode without S.** Recommendation: Gallery enters select mode on Mod+A, Shift-click or the
   Select button, and Esc leaves it; no letter key.
