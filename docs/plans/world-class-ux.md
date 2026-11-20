# Making Lifer a world class app

Status: built 2026-10-18 (quick fixes and phases 1 to 5), uncommitted. Phase 6 is for people, not code. Differences from the plan below:
- Settings opens in the main window with Command-comma rather than a separate window: two windows would each cache settings, and a change in one would show stale in the other.
- The region step uses the existing country map, drawn on a plain background until the offline map has downloaded, rather than a new picker.
- Cards already showed at most one badge, so phase 4 changed nothing there.
- The accent green is a shade darker (#68745e) so white button text meets WCAG AA; contrast.test.ts keeps every token pair there.
- Not done: restoring the window's size and position on relaunch, and a dark window background before the first page loads.

## The problem in one paragraph

Lifer works well for someone who already knows it and poorly for someone who doesn't. A new user meets three visual styles before reaching the app (the splash, the setup picker with its own grey palette, the onboarding card in the app's palette), can't step back once a choice is made, and lands in a collection that speaks in packs, taxa, tiers, ghosts and sea zones without explaining any of them. Inside the app, every screen has the same visual weight: one top bar of small text links, `text-xs` and `text-sm` for almost everything, and settings that list about sixty rows in eight groups. Nothing tells the eye where to look first.

## What Apple's Human Interface Guidelines ask for, applied to Lifer

The guidelines rest on three ideas, and each one names a gap.

- **Hierarchy.** Controls and interface elements should elevate and distinguish the content beneath them. In Lifer the chrome, the filters and the species all compete at the same size and weight.
- **Harmony.** The interface should feel like it belongs on the platform. Lifer's Mac app is a web page in a window: no sidebar, no toolbar, no Settings window, top-bar links instead of a source list.
- **Consistency.** Familiar standards and paradigms should carry over between screens. Lifer has hand-written buttons beside the Button component, three setup palettes, and back paths on some flows but not others.

From the specific guideline pages:

- **Onboarding**: keep it short, let people skip anything optional, teach through use rather than up-front screens, and never trap someone in a step.
- **Navigation**: on the Mac, a sidebar for top-level areas and a toolbar for the current area's actions and search; a visible way back from every drill-down.
- **Typography**: a small set of named text styles with clear contrast between them, built so text can scale.
- **Writing**: plain words the person would use, the same term for the same thing everywhere, buttons named for what they do.
- **Accessibility**: visible keyboard focus, labels on every icon button, honouring reduced motion, and comfortably sized targets.
- **Settings**: on the Mac, a separate window opened with Command-comma, a few panes, and the rarely used options behind disclosure.

## Principles for Lifer

1. **The species and photos are the content. Everything else steps back.** Chrome uses quieter colour and smaller type than the cards it frames.
2. **One way to do each thing, everywhere.** One button component, one back gesture, one empty-state pattern, one word per concept.
3. **Every step has a way back.** Setup, onboarding, modals and drill-downs all have a visible Back or Cancel.
4. **Explain on first contact, then get out of the way.** A term is explained where it first appears, once, and is one click from its definition after that.
5. **Mac first in the desktop app, web first in the browser.** The same React app, but the shell adds a sidebar, toolbar, native menus and a Settings window when it runs in Tauri.

## Phases

Each phase ships on its own. Phase 1 fixes what a new user hits today; phases 2 to 4 are the structural work; phase 5 closes the gaps; phase 6 proves it.

### Phase 1: first run that a stranger can finish (about a week)

The whole path from launch to a populated collection, rebuilt as one flow in one visual style.

- **One setup window, one look.** The picker, splash and offline page move onto the app's theme tokens and dark mode. Today they use a separate grey palette.
- **A short welcome before the choice.** One screen: what Lifer is in a sentence ("Your wildlife photos, organised by species, with a checklist of what's left to find"), and one Continue.
- **Choices that explain themselves.** "Pick Local Storage Folder" and "Connect to a Server" become two cards with a title, one line of what it means, and who it's for:
  - "On this Mac": your photos and library stay on this computer. Best for getting started.
  - "On my Lifer server": you already run Lifer at home or online. You'll sign in with that account.
- **A Back button on every step**, top left, in the same place each time. The server form gets Back as well, which closes it and returns to the two cards.
- **A step indicator** ("Step 2 of 4") so people know how long setup takes.
- **A centred content column** at a fixed comfortable width for reading (about 640 px), with wide steps like the region picker allowed to use more width while staying centred. The card shape goes away: setup fills the window like a Mac assistant, not a modal floating on a page.
- **Region picker as a map, not a wall of buttons.** A world map to click countries on (the app already ships one), a search field, and "Suggested for you" from the Mac's region setting. The taxon groups move to a second, optional step with plain names ("Birds", "Mammals", "Reptiles and amphibians") and a sensible default already selected.
- **The automatic downloads are visible but not in the way**: a small progress line in the corner ("Getting species matching ready, 40%"), not a step.
- **The finish screen shows what to do first**: "Import your first photos" as the primary button, the guide as a secondary link.

### Phase 2: hierarchy and structure (about two weeks)

- **A type scale with names, used everywhere.** Replace ad-hoc `text-xs` and `text-sm` with roles modelled on the Apple styles: Large Title, Title 1 to 3, Headline, Body, Callout, Subheadline, Footnote, Caption. Body becomes 15 to 16 px, not 12 to 14. Defined once as theme tokens; a lint rule blocks raw `text-[11px]`-style sizes.
- **Spacing and elevation tokens** that give three levels of emphasis: window background, grouped content, and controls. Cards sit on the canvas; filters sit quieter than cards.
- **Mac navigation in the desktop app.** A translucent sidebar with the top-level areas (Collection, Gallery, Albums, Trips, Stats), regions and recent trips listed beneath; a toolbar with the current page's title, its primary action (Import), a visible search field, and the filter control. The browser version keeps a top bar, styled to match.
- **Import becomes an action, not a place.** It's the primary toolbar button and accepts drag and drop onto the window from anywhere.
- **Settings in its own window on the Mac** (Command-comma, from the app menu), with panes for General, Library, Species, Sync, and Advanced. In the browser it stays a page with the same panes.
- **One Button component everywhere.** Onboarding, EmptyState and the welcome panel move off hand-written classes. Sizes follow the target-size rule in phase 5.

### Phase 3: words people understand (about a week, alongside phase 2)

- **A term list, written once and used everywhere** (`apps/web/src/lib/glossary.ts` and the docs). Proposed changes, for a yes or no:

| Today | Proposed | Why |
|---|---|---|
| Offline pack, region pack | Region download, or just "region" | Nobody outside the project knows what a pack is |
| Taxon, taxa, taxon groups | Animal groups | Plain English; keep scientific names where they're the content |
| Other Taxa | Other animals | Same |
| Ghost | Rarely documented | Says what it means |
| Lost | Not seen in 25 years | Same |
| Tier, rarity tier | Rarity | Shorter, no second word to learn |
| Sea zone | Ocean area | Same |
| Species-matching model | Species recognition | Names the benefit |

- **Every filter explains itself.** Toolbar filters (Vagrants, Endemic, Introduced, Ghost only) get a one-line description in the menu, not just a hover title.
- **Empty states always offer the next step.** "Nothing matches that filter" becomes the specific reason ("No birds you've photographed in Canada yet") with a button that fixes it ("Show all of Canada" or "Download Canada").
- **The name Lifer is explained once**, on the welcome screen: "In birding, a lifer is a species you've seen for the first time."
- **Settings descriptions rewritten** for someone who's never seen the app, and the rarely used ones (diving depths, reimport options, URL switching) moved under Advanced.

### Phase 4: the collection as the home screen (about two weeks)

- **A clear top of page**: the region's name as a Large Title, progress as a single big number ("212 of 480 photographed"), then the grid. Filters live in the toolbar, not above the content.
- **Cards with one job each**: photo, common name, and at most one badge. Secondary facts move to the species page.
- **A first-week mode**: until the user has imported photos, the collection shows a short checklist (Import your first photos, Mark species you've seen, Set a target) instead of an empty grid.
- **Progressive disclosure for power features**: group by, sort, sea zones and tier filters sit behind a "View options" control, not all on screen at once.

### Phase 5: accessibility and polish (about a week, ongoing after)

- **Visible focus everywhere**: a shared focus ring on Pills, Switches, nav links, InfoTips and empty-state buttons, and no bare `outline-none` without a replacement.
- **Target sizes**: 28 px minimum for pointer controls in the desktop app, 44 px in the browser on touch screens. Today Pills, small Buttons and Selects are 32 px, InfoTips 20 px, nav links about 20 px tall.
- **Labels and roles**: the Lightbox gets a dialog role and focus trap like Modal; every icon-only button gets an accessible name, checked by a test.
- **Reduced motion** honoured for every animation, not just the progress bar.
- **Text that scales**: sizes in rem from the type scale, so the browser zoom and the Mac's text-size setting both work.
- **Native Mac touches**: menus with keyboard shortcuts for every main action, window state restored on relaunch, Command-F to search, the toolbar's search field focused by it.
- **Contrast checked** against WCAG AA for every token pair, in light and dark.

### Phase 6: prove it with new users (ongoing)

- **Five first-time users, five tasks**, recorded with their permission: set up Lifer, download a region, import ten photos, find a species you haven't photographed, share an album. Note every hesitation. Repeat after each phase.
- **Screenshot review per release**: every screen in light and dark, at the smallest supported window, checked against the principles above.

## Quick fixes worth doing before the phases start

These are the issues you hit this week and don't need the larger work:

- Back button on the setup picker's server form and on every onboarding step.
- Centre the onboarding content column horizontally and keep it top-anchored vertically, so tall steps scroll and short steps don't float.
- Description lines under the two setup choices.
- Move the picker onto the app's colours.

## Decisions for you

- **Renaming terms**, especially "pack". It's in the code, the docs and the API; the proposal changes only what users read.
- **Sidebar navigation on the Mac.** It's the largest structural change and the one that most makes Lifer feel native. The browser version would keep a top bar.
- **Default theme.** Decided: follow the system from first launch.

## Order and size

| Phase | Depends on | Size |
|---|---|---|
| Quick fixes | none | 1 to 2 days |
| 1 First run | quick fixes | about a week |
| 2 Hierarchy and structure | 1 | about two weeks |
| 3 Words | runs alongside 2 | about a week |
| 4 Collection home | 2, 3 | about two weeks |
| 5 Accessibility and polish | 2 | about a week, then ongoing |
| 6 New-user testing | after each phase | ongoing |
