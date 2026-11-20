# Lifer 1.0 implementation plan

**Reviewer model (maintainer, 2026-10-23):** Opus 5.5 reviews security, data and storage, engine and shell process code, models and accuracy, and anything that writes files; Sonnet 5.5 reviews docs, check scripts, wording, simple UI and test-only packages. This overrides the per-package review tag.

> **Calibration (2026-10-22):** effort figures in this plan are conventional engineering time. Lifer's
> measured pace is far faster for coding: about 176,000 lines (desktop, server, web, species matching
> and a 134,000-species catalogue) in roughly six effective weeks. Expect coding work to take a fraction
> of these estimates. Real-world time does not compress: maintainer reviews and decisions, beta periods,
> store review, real-device and real-card testing, and model labelling.

Status: tracked per package (a **Status:** line under each heading, audited 2026-11-04; D packages not audited). Drafted 2026-10-22. Every migration named here is a proposal; each file
needs the maintainer's approval before it is written, and its number is the next free one at that time
(160 is the last used today, so the first would be 161; check `packages/data-pipeline/migrations/`
and agree numbers with any other live session first).

Models: each work package names who builds it. Opus 5.5 builds hard or risky work (data, migrations,
sync, security, performance, pipelines, models). Sonnet 5.5 builds well-specified UI and wiring. Haiku
5.5 builds mechanical chores. Every package, whoever builds it, gets an Opus 5.5 review before
hand-back (see [Review step](#review-step)). Helpers read only their own package, the standing rules,
and the sections and plans it links to.

## What 1.0 is

Lifer 1.0 is the free, open-source (AGPL) wildlife photo archive and life list, finished to the polish
bar the maintainer has set: everything on the open task list, the UX backlog, the library-first plan,
the remaining world-class UX items, the catalog republish and the sync foundation. The maintainer's
rule is that all of it is a 1.0 must-have, so this plan sequences the work rather than cutting it.

Sources this plan covers:

| Source | Covered by |
|---|---|
| Open tasks #21 to #78 (except #68) | Packages below; the table in [Task map](#task-map) |
| #68 plugin host and integration API | Already planned as L-01 to L-14 in `plugin-host-and-integration-api.md`; referenced here, not re-planned |
| `ux-backlog-2026-10-21.md` (items 1 to 34) | U, F, P, I, N packages |
| `ux-rules.md` and its "Proposed checks to build" | Q packages, built first |
| `library-first.md` | V packages |
| `world-class-ux.md` (unbuilt leftovers, phase 6) | P-05, R-02 |
| `archive-health.md` (built, migration 160) | R-01 verifies it |
| `next-catalog-republish.md` (1 to 9, including 5g) | D packages |
| `desktop-server-sync.md` (foundation) | S packages |
| `mobile-app.md` | Not in 1.0; only the sync foundation it needs (S packages) |
| `TECH_DEBT_AUDIT.md` | Items that block 1.0 folded into D-01, S-05, R-04, R-05 |

Out of 1.0: the mobile app itself, a plugin store, translations (search stays English), anything on the
rejected list (field notes, an "IDs to double-check" queue that second-guesses the user's own picks,
"only on one drive" warnings, GPX or phone track geotagging, in-app eBird sighting maps or feeds).

## Principles

1. **Guardrails before features.** The `ux-rules.md` checks are built first so every later package is
   checked by machines, not only by review.
2. **Foundations early.** The sync foundation, platform conventions, free-space checks and the
   background-job pattern land before the features that need them.
3. **Look before screens.** The visual language is defined and signed off before the home view,
   onboarding, review queue, Year in Review and portfolio are built. Each major new screen starts as a
   high-fidelity mockup the maintainer signs off.
4. **Local, private, zero config.** Lifer never phones home and has no tracking. Anything that sends
   data off the computer (online map tiles, Immich, iNaturalist) is off until the user turns it on, and
   only that sub-piece is gated. Every setting has a working default.
5. **The user decides, Lifer handles the rest.** Anything that changes how photos are grouped, filed or
   identified is a suggestion with one-click accept. Mechanical follow-through is automatic.
6. **Never block.** Long work runs as a background job with progress where the item lives.
7. **Three platforms.** macOS, Windows and Linux are all first-class, checked in CI and in review.
8. **One command for data.** Every catalog refresh is a stage of the one parameterised, resumable
   `refresh` command; finished long jobs are never rerun.

## Standing rules

These come from the maintainer's saved feedback and project notes. They apply to every package.

**Repository and process**

- Never commit, branch, stash, open a PR, or push, on this or any repo. The maintainer owns commits.
- Other live sessions may own uncommitted edits. Make targeted edits only; never rewrite or split a file
  that another session may be editing; agree migration numbers up front.
- Regenerate `package-lock.json` only with `npx -y npm@11 install --package-lock-only`. Check
  `git diff package-lock.json | grep -c '^-\s*"libc"'` is 0. No AI attribution in anything committed.
- Don't rebuild or relaunch the desktop dev app while any worker is editing `apps/web` or `apps/api`.
  When it is safe, use the full sequence: `npm run build -w api && npm run build -w web && npm run
prepare-resources -w desktop && npm run fetch-catalog-seed -w desktop`, stop the app,
  `touch build.rs && cargo build` in `apps/desktop/src-tauri`, start `target/debug/lifer-desktop`, then
  confirm a new string is in `target/debug/api/dist/index.js`.
- Commands handed to the maintainer to paste are short single lines.

**Data and databases**

- Migrations that enable functionality already in the specs and plans are pre-approved (maintainer,
  2026-10-23): write them and list each one in the report. Anything outside the specs still needs the
  maintainer's approval first. Claim the next free number from the coordinator before writing, since
  packages run in parallel, and apply only to `lifer_test` and e2e databases.
- Never write to the Docker `lifer` database; it is the maintainer's catalog master, not the desktop
  app's embedded Postgres. Ask before any run against it. Tests use
  `TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test`.
- To inspect what the desktop app sees, use its embedded Postgres, not the Docker one.
- Data refreshes are one parameterised, resumable command (`packages/data-pipeline/src/scripts/refresh.ts`
  stages). Never rerun a finished long job; make passes incremental on what changed.
- Publishing the catalog or packs needs the maintainer's go-ahead every time.
- Gallery embeddings are never dropped from distribution. Rarity tier is absolute photography
  difficulty, never rank or quota. Vernacular region groupings (country, group, province) are canonical.
- Prefer iNaturalist's `wikipedia_summary` over direct Wikipedia calls.

**Code and copy**

- No em dashes anywhere: UI copy, comments, docs, commit text. Use a comma, colon, period or parentheses.
- Code comments are short why-comments. Never cite ad-hoc tests, benchmarks or incident stories.
- No legacy-version notes or back-compat paths for old installs; nobody runs old versions.
- Plain words for newcomers; technical settings keep their established names (Automatic URL Switching,
  Technical diving depths).
- Search vocabulary stays English and lives in data tables (`gallery/searchTerms.ts`).

**UI**

- Build every control from the shared components; extend a shared one rather than styling locally.
  `check:raw-controls` and `check:design-tokens` must pass, plus the checks the Q packages add.
- Read `ux-rules.md` before UI work and name the rules the change touches.
- Every UI change gets a screenshot-based HIG self-review before it is called done: light and dark, the
  smallest window, a 27 inch window, phone width for server pages, and seeded extremes.
- Design for extremes: 0 items, 1 item, hundreds of thousands, very long text, 50-state countries.
- Never block the user: long work closes its dialog at once and runs in the background.
- Theme follows the system from first launch. Zero-config install: no env vars, no email or SMTP, ever.
- Prefer pickers over typed paths; suggest and let the user confirm grouping and filing choices.
- New shortcuts go in `apps/web/src/lib/keymap.ts` and follow the convention table in
  `docs/plans/keyboard-shortcuts.md` (Lightroom first, reserved keys stay free). No component listens
  for its own keys.

**Product**

- Lifer never phones home and has no tracking or usage counts.
- iNaturalist data is non-commercial, which is fine for Lifer; keep its credits.
- Windows and Linux are required alongside macOS.
- Before building, apply the scope test: does it fit Lifer's goal, and does eBird or iNaturalist already
  do it better? If so, link out.

## Sub-agent briefing

Paste this at the top of every worker brief, then add the package text.

```
You are building one work package of the Lifer 1.0 plan
(docs/plans/lifer-1.0-implementation-plan.md). Read your package, the "Standing rules" section,
and any plan it links. Repo: /Users/judahstarkey/Development/lifer-app.

Hard rules:
- Never git commit, branch, stash, push or open a PR. The maintainer commits.
- Targeted edits only. Other sessions may own uncommitted changes in the same files.
- Migrations for spec'd functionality are pre-approved: claim the next free number from the
  coordinator, write it, and list it in your report. Anything not in the specs: stop and ask, with the SQL.
- Never write to the Docker `lifer` DB. Tests use
  TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test.
- No em dashes anywhere, including comments. Comments are short why-comments.
- Use shared components and design tokens; `npm run check:raw-controls`,
  `npm run check:design-tokens`, `npm run check:em-dashes`, `npm run check:i18n` must pass, plus
  any check the Q packages added.
- UI: read docs/plans/ux-rules.md, name the rules you touch, take screenshots (light, dark,
  smallest window, 27 inch, seeded extremes: 0, 1, 200,000 items, 300-character names) and review
  them against the rules and the HIG checklist before reporting.
- Long work runs in the background; never hold a dialog on a spinner.
- Lifer never phones home. Anything that sends data off the computer is off until the user turns it on.
- Windows and Linux matter as much as macOS: no Mac-only wording or code path without the others.
- Data jobs are stages of the one `refresh` command, resumable; never rerun finished long jobs.
- Lockfile only via `npx -y npm@11 install --package-lock-only`.
- Don't rebuild the desktop dev app; the coordinator does that when no worker is editing.

Report: what changed (files), tests run and results, the ux-rules checked with screenshot paths,
anything left undone, and any decision you need from the maintainer.
```

## Review step

Every package ends with an Opus 5.5 review before hand-back. The reviewer:

1. Re-reads the package's acceptance criteria and checks each one against the code and test output.
2. Runs or reads the results of `tsc` for touched workspaces, the unit and integration tests named in the
   package, and every `check:*` script.
3. For UI, looks at the screenshots (not only the code) against `ux-rules.md` and the HIG checklist:
   content aligned with the header, one control size, short descriptions, search in the toolbar, row
   actions in a menu, destructive actions confirmed, one primary action, grouped lists, empty, loading
   and extreme states, light and dark.
4. For data, migrations, sync and security, checks the data rules in that package and that no migration
   was written without approval.
5. Scans the diff for em dashes, raw controls, raw colours, comments that tell stories, and edits outside
   the package's file list.
6. Sends it back with a short list if anything fails; passes it otherwise.

Packages below write this as **Review:** Opus 5.5, plus anything extra that package's reviewer must check.

## Milestones

Effort is in worker sessions (one package is about one session) and in rough calendar weeks for one
coordinator running two to four workers in parallel. The maintainer tests each exit criterion on a
built desktop app (macOS, plus Windows and Linux where named) and on a Docker server.

| Milestone | Packages | Sessions | Calendar | Exit criteria the maintainer can test |
|---|---|---|---|---|
| M0 Guardrails | Q-01 to Q-12, P-02 | 13 | 1.5 weeks | `npm run check:all` runs every new lint; CI runs e2e on macOS, Windows and Linux; the extreme seed opens in the app; the back-navigation, menu, modal, failure, dark-mode and long-action sweeps run in CI (known failures listed in a baseline file that only shrinks) |
| M1 Foundations | S-01 to S-06, P-01, P-03, P-04, D-01 | 10 | 2.5 weeks | Albums, trips and tags made on a linked desktop appear on the server and back, deletions included; removing a region closes the dialog at once and the app stays usable; a download with too little disk says "needs 3.4 GB, 1.2 GB free" before starting; Windows shows Explorer and Ctrl wording |
| M2 Backlog polish | U-01 to U-13, P-05 | 14 | 2 weeks | Every item in UX backlog 1, 3, 4, 7, 8, 10, 11, 13, 16, 30 to 34 and tours behaves as written, in light and dark; every shortcut in `keyboard-shortcuts.md` works and shows in its tooltip and the `?` sheet |
| M3 Filters, API, MCP | F-01 to F-08 | 8 | 3 weeks | "BC or Alberta, and 3 to 5 stars" works in Gallery, in a smart album and over the API; pinned filters; restored suggestions; Claude Desktop connected through MCP can search, add to an album and undo it |
| M4 Visual language and library-first | V-01 to V-18 | 18 | 6.5 weeks | Signed-off mockups; a folder with an original, a crop and a panorama export of one fox imports as one photo with three versions; first run pointed at a folder of 5,000 photos fills Collection and Home live without blocking; review queue confirms 40 heron frames in one keystroke; detailed offline map for one country; saved spots; species re-checked after placing |
| M5 Integrations | I-01 to I-09, plus L-01 to L-14 | 23 | 5 weeks | Lightroom Classic catalogue imported with preview; the Lightroom plugin writes species keywords; eBird CSV matched to trips; Immich library linked on a server; Open in Photoshop or Lightroom; iNaturalist sign-in follows the trust model; the example plugin runs in the desktop app |
| M6 New features | N-01 to N-06 | 6 | 3 weeks | Year in Review for 2026; a sound recording counts as heard; a portfolio exported as a static site and a public life list link on a server; a video frame saved as a full-resolution photo |
| M7 Parity and performance | P-06 to P-10 | 5 | 3 weeks | Signed installers on all three systems; native feel items checked on each; every main page under budget on the extreme seed; photo open shows no black frame |
| M8 Catalog republish (parallel data track, starts in M1) | D-02 to D-08 | 7 | 4 weeks of work plus compute | Gate passes on the new data; placeholders show a real city per region; "Scotland" and "Holland" find their regions; open-licence vectors measured and the decision recorded; publish only on the maintainer's go-ahead |
| M9 Testing depth and release | T-01 to T-04, R-01 to R-06 | 10 | 3 weeks | Dangling-reference audit clean; journeys and monkey tests green in CI; five new-user sessions run; release checklist signed off on all three systems |

Totals: 114 work packages here (100 new plus the 14 L packages already planned). About 34 calendar
weeks for one developer working serially; about 18 to 22 weeks with the parallel tracks below.

## Order and parallel tracks

```
Track A (guardrails, then UI):  M0 Q-* --> M2 U-* --> M3 F-* --> M6 N-*
                                     \--> V-01 visual language --> V-08 mockups (sign-off)
                                                 --> V-02..V-16 library-first and home (M4)
Track B (foundations, data):    S-01 (migration) --> S-02 --> S-03 --> S-04 --> S-05 --> S-06
                                D-01 pipeline safety --> D-02..D-07 --> D-08 republish (go-ahead)
Track C (platform, integrations): P-01, P-03, P-04 (M1) --> L-01..L-14 (M5) --> I-* (M5)
                                --> P-06..P-10 (M7)
Track D (testing):              Q-05 seed --> Q-10 budgets --> P-09, P-10 --> T-* --> R-*
```

Key dependency edges:

```
Q-01..Q-04 lints ----------------> every UI package (they must pass)
Q-05 extreme seed --> Q-06..Q-11, P-09, P-10, T-03
S-01 migration --> S-02 --> S-03 --> S-05; S-04 after S-02; V-14 saved spots adds its own tracking
P-01 platform module --> U-07, U-13, I-02, P-07, P-08
P-03 free space --> P-04, V-11, D-06 (download sizes), I-08
F-01 multi-value filters --> F-02, F-03, F-05 --> F-06 MCP; F-05 --> I-05 plugin reads
V-01 visual language --> V-02 tokens --> V-03 map style --> V-08 mockups (sign-off)
                                                         --> V-04 onboarding, V-06 review queue,
                                                             V-09/V-10 home, N-01, N-04
V-05 suggested identifications --> V-06 review queue, V-10 home counts
V-14 saved spots --> V-15 re-check species, V-13 placing photos
D-03 places and D-04 aliases (shared migration) --> F-08 region search and placeholders
D-01 pipeline safety --> D-02..D-07 --> D-08; D-06 licence tags --> L-12 open vectors endpoint
L-06, L-07, L-10 --> I-05 Lightroom plugin
I-03 catalogue reader --> I-04 import UI --> V-04 onboarding (catalogue as a source)
```

What can run at the same time, by phase:

| Phase | In parallel |
|---|---|
| M0 | Q-01, Q-02, Q-03, Q-04, Q-05, P-02 together; Q-06 to Q-12 after Q-05 |
| M1 | S-01 (waits on approval) beside P-01, P-03, D-01; P-04 after P-03 |
| M2 | All U packages except U-05 before U-11 (shared View menu); P-05 alone in the shell |
| M3 | F-01 first; then F-02, F-04, F-07 together; F-03, F-05 after F-02; F-06 last |
| M4 | V-01 alone; then V-02, V-05, V-07, V-14 together; V-11 beside them; mockups V-08 before any screen |
| M5 | L track and I track together; I-03 beside I-06 and I-08; I-05 after L-07 and L-10 |
| M6 | N-02 beside N-04 and N-06; N-01 after V-08 sign-off |
| M7 | P-06, P-07, P-08 together; P-09 then P-10 |
| M8 | D-02, D-03, D-04, D-05 together once D-01 lands; D-06 alone (heavy compute); D-07 after; D-08 last |
| M9 | T-01 to T-04 together; R packages last |

Rebuild rule for the coordinator: only rebuild the desktop dev app between waves, when no running worker
is editing `apps/web` or `apps/api`.

## Task map

| Task | Packages | Task | Packages |
|---|---|---|---|
| #21 pipeline: seasonality, cities, populous region, index | D-02, D-03 | #53 Open in external editors | I-02 |
| #25 Immich sync | I-08, I-09 | #54 Cmd-1 to Cmd-9 | U-07 |
| #26 feature tours | U-12 | #55 pinned filters | F-03 |
| #38 selection bar and toolbar | U-01 | #56 Lightroom Classic catalogue import | I-03, I-04 |
| #39 sensitive species regional scope | F-07 | #57 eBird checklists | I-06, I-07 |
| #40 text hierarchy | U-02 | #58 performance sweep | Q-10, P-09, P-10 |
| #41 rating range picker | U-03 | #59 Windows and Linux parity | P-01, P-02, P-06, P-07, P-08 |
| #42 multi-value filters | F-01, F-02 | #60 Year in Review | N-01 |
| #43 smart album suggestions | F-04 | #61 sound recordings | N-02, N-03 |
| #44 find similar and keep both | U-11 | #62 portfolio and public life list | N-04, N-05 |
| #45 "Photographed in year" | U-04 | #63 save a video frame | N-06 |
| #46 API smart albums and filters | F-05 | #64 saved spots | V-14 |
| #47 album and trip card size | U-05 | #65 region search | D-04, F-08 |
| #48 dark-mode slider | U-06 | #66 iNaturalist trust model | I-01 |
| #50 MCP server | F-06 | #67 testing depth | Q-05, T-01 to T-04 |
| #51 traffic lights | P-05 | #69 group heading hover | U-09 |
| #52 free-space checks | P-03 | #70 Collection multi-select | U-10 |
| #71 region removal in background | P-04 | #72 remove-regions dialog copy | U-02 |
| #73 library-first onboarding | V-04, V-05, V-07 | #74 home dashboard | V-08, V-09, V-10 |
| #75 visual language | V-01, V-02, V-03 | #76 Lightroom plugin | I-05 |
| #77 detailed maps | V-11, V-12, V-13 | #78 re-check species after location | V-15 |
| #68 plugin host | L-01 to L-14 | UX backlog 34 rich tooltips | U-08 |
| Photo versions: edits and exports of one photo | V-17, V-18 | | |
| Shared keymap and shortcut sheet | U-13 | | |

## Work packages

Field guide: **Model** is who builds it. **Review** is the Opus 5.5 step above. **Scope** lists what is
in, then what is out. **Contracts** are the interfaces other packages rely on. **Parallel with** names
packages that touch different files and can run at the same time.

### Track Q: UX checks (M0)

These implement `ux-rules.md` "Proposed checks to build". Each new check starts with a committed
baseline file of today's known violations so it passes on day one; the baseline may only shrink, and
packages that touch a listed file fix its entries.

### Q-01 Raw controls and lookalike overlays lint

**Status:** done (2026-11-04): test:scripts runs the 11 script tests first in npm test and in CI

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus confirm no real violation was hidden in the baseline.
- **Goal:** LINT 1: raw controls are banned in all of `apps/web/src`, and lookalike modals and menus too.
- **Scope:** in: widen `check:raw-controls` from `pages/` to `apps/web/src` outside the shared component
  folder; second pattern list for `fixed inset-0`, `role="dialog"`, `role="menu"` outside `Modal`,
  `Menu` and their kin; baseline file. Out: fixing every violation (each later package fixes its own).
- **Files:** `scripts/check-raw-controls.mjs`, `scripts/raw-controls-baseline.json` (new), root
  `package.json` (`check:all` if absent).
- **Depends on:** none.
- **Contracts:** escape comment stays `raw-control: <why>`; baseline entries are `{ file, line text }`
  so line moves don't break it.
- **Steps:** reuse the walker; exempt the shared component folder by path; write the baseline from
  today's tree; fail on any new entry; print a "baseline shrank, please update" note when entries vanish.
- **Tests and acceptance:** unit tests for the regexes (arrow functions in attributes, escape comment,
  allowed input types); adding a raw `<button>` in any component fails; current tree passes.
- **UX checks:** C1, C2, C7 (the check itself).
- **Risks:** shared component folder naming; false positives on `role="menu"` in the shared Menu.
- **Parallel with:** Q-02, Q-03, Q-04, Q-05, P-02.

### Q-02 Design tokens lint for colour, spacing, focus rings and title

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** LINT 2, 6 and 7: no raw colours or pixel sizes, no bare `outline-none`, no `title=` on
  Button or IconButton.
- **Scope:** in: extend `check:design-tokens` with `#hex`, `rgb(`, Tailwind palette classes, arbitrary
  `[Npx]` outside `theme.css`; `outline-none` without a `focus-visible:` ring; `title=` on Button and
  IconButton; baseline. Out: the shared Tooltip (U-08).
- **Files:** `scripts/check-design-tokens.mjs`, `scripts/design-tokens-baseline.json` (new).
- **Depends on:** none.
- **Contracts:** escape comment `design-token: <why>`.
- **Steps:** add regexes; run against the tree; write the baseline; document in the script header.
- **Tests and acceptance:** unit tests per pattern; a new `text-green-600` fails.
- **UX checks:** C5, T2, Y1, M9.
- **Risks:** chart and map code that legitimately needs raw colours; give them tokens in V-02 rather
  than escapes where possible.
- **Parallel with:** Q-01, Q-03, Q-04, Q-05.

### Q-03 Copy check and em-dash scan hardening

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus check the jargon list against the approved renames.
- **Goal:** LINT 3 and 9 plus the N48 fix: one `check:copy` over `en.json`, and em dashes caught in
  untracked files and docs.
- **Scope:** in: emoji, trailing `...` or `…` on action keys, jargon (pack, taxon, tier, ghost, sea zone,
  instance, drill in, bulk import), platform words (Mac, Finder, Explorer, browser, ⌘) outside
  platform keys, "New:", "experimental", descriptions over 140 characters (warn), a literal "Select all"
  outside the shared toggle; `check-em-dashes.mjs` scans `docs/` whole and untracked files
  (`git ls-files -co --exclude-standard`), excluding only released migrations. Out: rewriting copy.
- **Files:** `scripts/check-copy.mjs` (new, reuse `flatten` from `check-i18n.mjs`),
  `scripts/copy-allowlist.json` (new, technical-setting keys), `scripts/check-em-dashes.mjs`,
  `package.json`.
- **Depends on:** none.
- **Contracts:** allowlist keyed by `en.json` key path.
- **Steps:** flatten, apply rules, baseline existing hits; keep Automatic URL Switching and Technical
  diving depths allowed.
- **Tests and acceptance:** unit tests per rule; today's tree passes with the baseline.
- **UX checks:** W1 to W7, W4, D4.
- **Risks:** "pack" inside other words; match whole words.
- **Parallel with:** Q-01, Q-02, Q-04.

### Q-04 ESLint rules for errors, links and menus

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** LINT 4, 5 and 8: no raw error text, external links only through the helper, no fields in
  menus.
- **Scope:** in: a shared `userMessage(error)` in `apps/web/src/lib/` (plain words for network, offline,
  disk full, permission, not found, unknown); `no-restricted-syntax` for `{x.message}` in JSX,
  `String(error)`, `target="_blank"`, `window.open`; a small rule banning TextField, input or Select
  inside menu content. Out: migrating every call site (baseline via eslint-disable with reason).
- **Files:** `eslint.config.mjs`, `apps/web/src/lib/userMessage.ts` (new), `apps/web/src/lib/openExternal.ts`
  (the helper), `apps/web/src/locales/en.json`.
- **Depends on:** none.
- **Contracts:** `userMessage(err: unknown): string` returns translated copy, never the raw message.
- **Steps:** write the helper with tests; add rules as errors; fix or annotate today's hits.
- **Tests and acceptance:** helper unit tests; lint passes; a new `{err.message}` fails.
- **UX checks:** S1, X3, M2.
- **Risks:** too many current hits; annotate with a reason and list them for later packages.
- **Parallel with:** Q-01, Q-02, Q-03.

### Q-05 Extreme fixture library

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus confirm the seed only touches the test database.
- **Goal:** one deterministic extreme seed for every sweep and for screenshots.
- **Scope:** in: 5,000 species, 60,000 photos (synthetic tiny images), 300-character names, a 50-state
  country, hundreds of exclusions, 1,000 albums, 500 trips, missing files, empty fields, sensitive
  species, videos; a sparse seed (0 and 1 item). Out: the sweeps themselves.
- **Files:** `e2e/support/extremeLibrary.ts` (new), `e2e/visual/seed.setup.ts`, `e2e/support/realistic*.ts`
  (reuse), `playwright.config.ts` (a project for the extreme seed).
- **Depends on:** none.
- **Contracts:** `seedExtreme(db)` and `seedSparse(db)`; deterministic ids; runs in under 2 minutes.
- **Steps:** bulk insert with `COPY` or `unnest`; tiny shared image files hard-linked; a flag to open the
  app on it for manual screenshots.
- **Tests and acceptance:** the seed builds in CI under the time limit; Collection, Gallery, Albums,
  Trips and Stats open on it.
- **UX checks:** S7 (enables).
- **Risks:** seed time; keep derivative files shared.
- **Parallel with:** Q-01 to Q-04, P-02.

### Q-06 Back-navigation round trip

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** E2E 1: back returns to the exact previous view.
- **Scope:** in: Collection, Gallery, Albums, Trips, Stats; region, drill-down, filters, search, scroll;
  back by button, `page.goBack()` and the swipe shortcut; back label equals the previous `h1`. Out:
  fixing failures (listed in the baseline for U and P packages).
- **Files:** `e2e/tests/back-navigation.spec.ts` (new), `e2e/known-failures.json` (new, shared by Q
  sweeps).
- **Depends on:** Q-05.
- **Contracts:** `known-failures.json` entries name spec, case and the package expected to fix it.
- **Tests and acceptance:** spec runs in CI on three systems; failures are only listed ones.
- **UX checks:** N1, N2, N4, P5.
- **Risks:** flaky scroll restoration timing; wait on the ready marker from Q-10 when it exists.
- **Parallel with:** Q-07 to Q-11.

### Q-07 Menu containment and modal contract

**Status:** partial (2026-11-04): menu sweep extended (Trips list, no-scroll check), harness fixes made, fixed version not re-run; earlier run showed possible M2 bug on Trips list (two menus open at once)

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** E2E 3 and 9.
- **Scope:** in: every menu and popover at four window edges at the smallest size (inside viewport, no
  page scroll, opacity 1, a second closes the first); every modal (scroll lock, Tab trap, Enter fires
  primary, Escape peels one layer, a way out). Out: fixes.
- **Files:** `e2e/visual/behaviour.spec.ts` (extend), `e2e/tests/modals.spec.ts` (new).
- **Depends on:** Q-05.
- **Contracts:** modals expose `data-modal` and a primary action marker for the test.
- **Tests and acceptance:** green or listed failures.
- **UX checks:** M1, M2, M3, M4, N5.
- **Risks:** discovering every modal; register them through the shared Modal.
- **Parallel with:** Q-06, Q-08 to Q-11.

### Q-08 Failure, sparse data, error injection and dark mode sweeps

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** E2E 4 and 6, plus testing-depth item 6 (error injection) for the API side.
- **Scope:** in: route API calls to 500, timeout, slow (3 s) and offline in turn; sparse seed; assert
  sidebar stays, styled error with Retry, no raw error text or `undefined/null/NaN`, images loaded;
  dark mode: no large light element, `html` and `body` backgrounds match. Out: failing files (T-04).
- **Files:** `e2e/tests/failure-sweep.spec.ts`, `e2e/tests/dark-sweep.spec.ts` (new).
- **Depends on:** Q-05.
- **Tests and acceptance:** runs on three systems; failures listed.
- **UX checks:** S1 to S4, S9, T1.
- **Risks:** pages that legitimately show "null" as a word; match whole tokens only.
- **Parallel with:** Q-06, Q-07, Q-09 to Q-11.

### Q-09 Long actions and hover affordance sweeps

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** E2E 7 and 8.
- **Scope:** in: delayed pack download and removal (dialog gone within 500 ms, busy state within 100 ms,
  another page opens, row updates without navigation); hover and focus change on every button, link and
  clickable heading, focus ring radius matches. Out: fixes (P-04, U-09).
- **Files:** `e2e/tests/long-actions.spec.ts`, `e2e/tests/affordance.spec.ts` (new).
- **Depends on:** Q-05.
- **Tests and acceptance:** green or listed failures (pack removal expected until P-04).
- **UX checks:** F1, F2, F4, F5, P6, M5, Y1.
- **Risks:** hover detection on transitions; compare after transition end.
- **Parallel with:** Q-06 to Q-08, Q-10, Q-11.

### Q-10 Performance and no-flash budgets

**Status:** partial: e2e/perf-baseline.json has macOS only; no Windows or Linux baselines, no proof of stable timings over 3 CI runs

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check the timings are stable across three CI runs.
- **Goal:** E2E 5: measured budgets that later packages must meet.
- **Scope:** in: a ready marker (`data-ready` on the page root) set by each main page when its first
  screen is drawn; click-to-ready timing for page switches, species open, photo open, back; frame
  capture failing on mostly black or blank frames; long tasks over 200 ms while scrolling. Budgets:
  navigation 100 ms perceived, photo open 150 ms with no blank frame. Out: fixing slowness (P-09, P-10).
- **Files:** `apps/web/src/lib/readyMarker.ts` (new), main page components (one line each),
  `e2e/tests/performance.spec.ts` (new), `e2e/perf-baseline.json` (new).
- **Depends on:** Q-05.
- **Contracts:** `useReadyMarker(isReady)`; budgets in one file; CI warns at budget, fails at 1.5x until
  P-10 lands, then fails at budget.
- **Steps:** add marker; measure with `performance.now()` in page and Playwright traces; record a
  baseline per OS.
- **Tests and acceptance:** report table per page per OS; stable within 20% across runs.
- **UX checks:** P1, P2, P3, P5, P6.
- **Risks:** CI machines are noisy; compare against a same-run baseline page.
- **Parallel with:** Q-06 to Q-09, Q-11.

### Q-11 Search golden queries

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** E2E 10: one query table through Gallery search, Collection filter and Command-K.
- **Scope:** in: queries (pil, PIWO, water crow, eating, fox playing, foxes playing, moo, purpl, tiger)
  with must-include and must-exclude; prefix narrowing; identical species sets across surfaces. Out:
  search ranking changes.
- **Files:** `e2e/tests/search-golden.spec.ts` (new), `e2e/support/searchGolden.json` (new).
- **Depends on:** Q-05 (fixed seed).
- **Tests and acceptance:** green or listed failures.
- **UX checks:** Q1 to Q4.
- **Risks:** CLIP scores vary by platform acceleration; assert sets, not order, for scene words.
- **Parallel with:** Q-06 to Q-10.

### Q-12 Screenshot review harness

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** one command that produces every screenshot a HIG review needs.
- **Scope:** in: `npm run screens -- --pages=gallery,collection` saving light and dark at 390, 1280 and
  2560 px, on the extreme and sparse seeds, into `test-results/screens/<date>/`; an index HTML page to
  flip through. Out: pixel diff gating (the existing visual config keeps that).
- **Files:** `e2e/screens.spec.ts` (new), `e2e/playwright.visual.config.ts`, `package.json`.
- **Depends on:** Q-05.
- **Contracts:** every worker attaches the folder path in its report.
- **Tests and acceptance:** one run covers every main page and Settings pane in under 5 minutes.
- **UX checks:** supports every VISUAL rule.
- **Risks:** none notable.
- **Parallel with:** Q-06 to Q-11.

### P-02 CI on all three systems

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus check action SHA pinning and job timeouts.
- **Goal:** Windows and Linux are checked on every PR, not at release (audit N22, N23, N46).
- **Scope:** in: `cargo check --locked` on windows-latest and macos-14 beside ubuntu; Playwright e2e on
  Linux, Windows and macOS; the Docker job runs the image against a Postgres service and curls
  `/health` as uid 568; a promotion date for the advisory behaviour job; unit tests run once under
  coverage. Out: native-feel work (P-07, P-08).
- **Files:** `.github/workflows/ci.yml`.
- **Depends on:** none.
- **Tests and acceptance:** a PR shows all three systems; a Windows-only Rust error fails CI.
- **UX checks:** X4 (enables).
- **Risks:** CI minutes; run the full e2e matrix on main and a smoke subset on PRs.
- **Parallel with:** Q-01 to Q-05.

### Track S: sync foundation (M1)

Built today (`desktop-server-sync.md`): instance id on `/health` (migration 148), the `sync` key scope
and `POST /auth/desktop-link`, `updated_at` and `pushed_at` with touch triggers on `captures_all` and
`user_species` (150), `sync_tombstones` for those two (152), a version-checked push and a cursor that
never skips. Not built: albums, trips, album membership and exclusions, tags, species corrections and
saved spots don't sync; desktop edits to mirrored rows aren't pushed; species marks have no version
check; a reinstalled server starts over without asking. 1.0 builds the foundation that server sync and
a later phone app both need, and nothing phone-specific.

### S-01 Change tracking for the rest of the library (migration)

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check every trigger skips bookkeeping-only updates
  and honours `lifer.sync_apply`.
- **Goal:** every user-owned table that must sync has `updated_at`, `pushed_at`, `remote_updated_at` and
  tombstones.
- **Scope:** in: a proposed migration for `albums` (has `updated_at`, no trigger), `album_captures`,
  `album_exclusions`, `trips`, trip membership, capture tags, species corrections; widen the
  `sync_tombstones.kind` check; stable cross-install refs (uuid ids shared on push, or a natural key
  where ids differ). Out: saved spots (V-14 creates its table with tracking built in), API routes.
- **Files:** `packages/data-pipeline/migrations/<next>_sync_library_tracking.sql` (after approval),
  `docs/docs/contributing/state-and-sync.md` (table list).
- **Depends on:** none. **Approval gate:** the maintainer approves the SQL before the file is written.
- **Contracts:** same trigger shape as 150 and 152; membership rows tombstone as
  `kind = 'album_capture'`, `ref = '<album ref>:<capture ref>'`.
- **Steps:** list every user table and decide sync or local-only (write the list into state-and-sync);
  draft SQL; present it for approval; write it; run `check:migrations`.
- **Tests and acceptance:** integration tests on `lifer_test`: an edit stamps `updated_at`; a push
  bookkeeping update does not; a delete writes one tombstone; a delete under `lifer.sync_apply` does
  not.
- **UX checks:** none.
- **Risks:** statement-level triggers on large album deletes; keep them set-based.
- **Parallel with:** P-01, P-03, D-01.

### S-02 Change feed and push for albums, trips and tags

**Status:** built (2026-11-04): species corrections in feed and push; protocol 1 desktop still works against new server (tested)

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check the conflict rule is identical to captures.
- **Goal:** `/sync/changes` and `/sync/push` carry the new entities with the same newest-edit-wins rule.
- **Scope:** in: changes feed pages per entity by `(updated_at, id)` under the open-transaction hold;
  push applies an entity only if the server row is unchanged since `remote_updated_at`, else returns
  `conflict` with the server copy; tombstones for each kind; TypeBox schemas for every body and reply
  (audit N11, N31). Out: desktop apply (S-03).
- **Files:** `apps/api/src/sync/changes.ts`, `push.ts`, `pushServer.ts`, `routes.ts`, a shared column
  list (audit N32).
- **Depends on:** S-01.
- **Contracts:** sync protocol version 2 in the `/health` reply (`syncProtocol: 2`); a v1 desktop
  against a v2 server keeps working for captures and marks.
- **Steps:** one column-list constant per entity; batch writes with `unnest`; reuse `parseRemoteJson`.
- **Tests and acceptance:** integration tests: album created on each side, renamed on both (newest
  wins), deleted on one, membership added offline; nothing echoes.
- **UX checks:** none.
- **Risks:** album membership ordering; sync position as a value, not a list rewrite.
- **Parallel with:** S-04.

### S-03 Desktop mirror apply and push of edits to mirrored rows

**Status:** built (2026-11-04): corrections applied and pushed; two-database journey test passes

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** a linked desktop pulls and pushes the new entities, and edits made to mirrored rows reach the
  server.
- **Scope:** in: `mirror.ts` applies albums, trips, membership, tags, corrections; mirrored rows edited
  locally become due for push; species marks gain the version check; the pull never overwrites an
  unpushed local edit (audit N07); server trash applies to local-origin rows (N06). Out: UI.
- **Files:** `apps/api/src/sync/mirror.ts`, `push.ts`, `apps/desktop/src-tauri/src/sync.rs` (poll
  timeout and restart fixes, audit N29).
- **Depends on:** S-02.
- **Tests and acceptance:** two-desktop journey E (laptop and desktop on one server) as an integration
  test with two databases; a failed upload is logged and fails the job (N10).
- **UX checks:** F5 (state shows at once).
- **Risks:** two `lifer_test` databases in CI; create a second schema-scoped database in setup.
- **Parallel with:** S-04.

### S-04 Sync protocol, device keys and server identity

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a security read of key handling.
- **Goal:** the foundation a second client (another desktop now, a phone later) needs: a versioned
  protocol, named per-device sync keys, and a trusted server identity.
- **Scope:** in: Settings > Server on a server lists "Linked devices" (each a `sync` key row in
  `api_keys` with a device name, last used, Revoke); a per-link secret the server proves (fixes audit
  N12) so the instance id alone never earns a key; journey H (a reinstalled server asks before starting
  over); document protocol v2. Out: the desktop's local API listening on the network, QR pairing, any
  phone code.
- **Files:** `apps/api/src/auth/apiKeyRoutes.ts` (`DESKTOP_LINK_SCOPES`, decide on `photos.write`, N33),
  `apps/api/src/sync/serverLink.ts`, `apps/desktop/src-tauri/src/server_link.rs`,
  `apps/web/src/pages/settings/` (server pane), `docs/docs/contributing/state-and-sync.md`.
- **Depends on:** S-02.
- **Contracts:** `GET /health` returns `{ instanceId, syncProtocol }`; link proof is an HMAC of a
  server nonce with the link secret; no new table (keys stay in `api_keys`).
- **Tests and acceptance:** a server answering with the right instance id but no secret gets no key;
  revoking a device ends its access; reinstalled server shows the confirm.
- **UX checks:** W3, W8, D2, L3; HIG review of the devices list with 0, 1 and 30 devices.
- **Risks:** existing links need the secret on first contact; do it silently at next sign-in.
- **Parallel with:** S-03.

### S-05 Sync hardening and tests

**Status:** built (2026-11-04): journeys E and G tested, journey D manual script written in desktop-server-sync.md

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** close the sync test debt (audit N13) and remove the old read-only offline cache.
- **Scope:** in: integration tests for push of a server-trashed capture, a local edit during pull, a
  failed upload, a two-URL link, cursor hold under a long transaction; remove `offline_cache.rs` and
  make the mirror the only away-from-home path (state the fallback once, N14). Out: features.
- **Files:** `apps/api/src/sync/*.integration.test.ts`, `apps/desktop/src-tauri/src/offline_cache.rs`
  (remove), `server_watch.rs`, `docs/docs/contributing/state-and-sync.md`.
- **Depends on:** S-03, S-04.
- **Tests and acceptance:** all listed tests pass; journeys A to I in `desktop-server-sync.md` each have
  a test or a manual script.
- **UX checks:** S9 (offline explains itself).
- **Risks:** unlinked apps that relied on the offline cache; they never had a server, so none lose data.
- **Parallel with:** P-04.

### S-06 Sync status in Settings and docs

**Status:** built (2026-11-04): sync guide and 0 and 120,000 waiting screenshots; screenshots predate the digit-grouping fix

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** the user can see what synced, what is waiting and why something didn't.
- **Scope:** in: Settings > Server rows for albums and trips beside photos; a "Waiting to sync" count with
  a plain reason; user docs. Out: new sync behaviour.
- **Files:** `apps/web/src/pages/settings/` (server pane), `apps/web/src/locales/en.json`,
  `docs/docs/guides/` (sync page).
- **Depends on:** S-03.
- **Tests and acceptance:** web unit tests for each state; screenshots with 0 and 120,000 waiting.
- **UX checks:** L3, F4, F6, W5, S1.
- **Risks:** none notable.
- **Parallel with:** S-05.

### Track P: platform and performance

### P-01 Platform conventions module

**Status:** built (2026-11-04); thisComputer deliberately not added, copy already says "this computer"; no screenshots

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus screenshots on Windows and Linux.
- **Goal:** one module picks every platform word, shortcut label and dialog button order.
- **Scope:** in: `platform.ts` grows `revealLabel` (Finder, Explorer, file manager), `modKey` (⌘, Ctrl),
  `shortcutLabel(chord)`, `buttonOrder` (Windows puts the primary first), `thisComputer`; replace current
  hard-coded uses; `check:copy` allowlist for platform keys. Out: native-feel shell work (P-07, P-08).
- **Files:** `apps/web/src/lib/platform.ts`, `apps/web/src/components/` (Modal footer, menus),
  `apps/web/src/locales/en.json`, `apps/desktop/src-tauri/src/menu.rs` (labels).
- **Depends on:** Q-03.
- **Contracts:** components never test `isMac` for wording; they call the module.
- **Tests and acceptance:** unit tests per OS; `check:copy` shows no platform words outside allowed keys.
- **UX checks:** W4, X4, X3.
- **Risks:** server web app has no OS truth; use the browser's platform hint with a neutral fallback.
- **Parallel with:** S-01, P-03, D-01.

### P-03 Free-space checks

**Status:** built (2026-11-04): room checks in reorganize and the Rust seed download, free space shown next to pack sizes (FreeSpaceNote), real full-disk test plus CI job; no screenshots

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a full-disk test on each OS.
- **Goal:** no download or copy starts without room, and a full disk mid-way never leaves junk.
- **Scope:** in: a core `freeSpace(path)` (Node `fs.statfs`); a shared `ensureRoom(path, bytes)` used by
  model, map, region pack, catalog seed, library move, export and reorganize; on ENOSPC mid-way stop,
  delete the partial file, show "Needs 3.4 GB, 1.2 GB free"; free space shown next to every download
  size. Out: quotas.
- **Files:** `packages/core/src/lib/resumableDownload.ts`, `packages/core/src/lib/freeSpace.ts` (new),
  `apps/api/src/offlinePacks/`, `apps/api/src/settings/storageMove.ts`, `apps/api/src/albums/export.ts`,
  `apps/desktop/src-tauri/src/model_cache.rs`, `pg_upgrade.rs` (reuse), the shared download row component.
- **Depends on:** none.
- **Contracts:** API errors carry `{ code: "disk_full", needed, free, path }`; `userMessage` (Q-04)
  renders them.
- **Steps:** add helper; call before each job with a 10% margin; catch ENOSPC in stream writers.
- **Tests and acceptance:** unit tests with a mocked statfs; integration test filling a small tmpfs or
  loop volume on Linux CI; the dialog states sizes in plain words.
- **UX checks:** S1, F4, A4, W8.
- **Risks:** network drives report odd free space; treat unknown as "go ahead and watch for ENOSPC".
- **Parallel with:** S-01, P-01, D-01.

### P-04 Region removal in the background

**Status:** partial (2026-11-04): written list in platform-checklists.md; five dialogs still wait on long work (Empty Trash, species split, Adjust date and time, Place over 5,000, Album export), not yet made background jobs

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check a failed job restores the region whole.
- **Goal:** UX backlog 33: removing regions closes the dialog at once and never blocks.
- **Scope:** in: `/offline-packs/offload-batch` starts a job and returns at once; packs marked removing
  up front; removing countries leave the Collection picker and search at once with `restoreFallback`;
  rows show "Removing..."; toast when done; on failure the country comes back with a clear message;
  batched deletes (audit N17); sweep for other dialogs that wait on long work and list them. Out: the
  dialog copy (U-02).
- **Files:** `apps/api/src/offlinePacks/remove.ts`, its routes, `apps/web/src/components/DownloadedPacksList.tsx`,
  `apps/web/src/pages/offlinePacks/ProvinceManager.tsx`, the pack index store, `apps/api/src/lib/job.ts`.
- **Depends on:** P-03 (shared job progress pattern), Q-09 (the check).
- **Contracts:** pack state gains `removing`. If pack state is a checked column, this needs a migration
  (ask first); if it lives in the pack index or install settings, none.
- **Tests and acceptance:** Q-09 long-action spec passes for removal; integration test for failure mid-
  way leaving the pack whole.
- **UX checks:** F1, F2, F3, F5, P6, N6.
- **Risks:** a removal and a download of the same region racing; queue them per region.
- **Parallel with:** S-05, U packages.

### P-05 Native window chrome and window memory

**Status:** partial: sidebar tint added (--color-sidebar token, contrast tested); no X1, X2, X5 screenshots

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus screenshots focused, unfocused, full screen, sidebar
  hidden, light and dark on macOS, and the Windows and Linux title bars.
- **Goal:** UX backlog 13 and the world-class leftovers: native traffic lights, window state restored,
  no white flash before the first page.
- **Scope:** in: keep the overlay title bar; a slightly darker sidebar tint so macOS's own grey buttons
  stay visible; remove the custom disc backdrop (`window_controls.rs` and its focus and theme syncing);
  restore window size and position on relaunch; window background matches the theme before the first
  page loads. Out: Windows and Linux native-feel work (P-07, P-08).
- **Files:** `apps/desktop/src-tauri/src/window_controls.rs` (remove), `lib.rs`, `commands.rs`,
  `apps/web/src/components/AppSidebar.tsx`, `TitleBarDragRegion.tsx`, `apps/web/src/theme.css`,
  `tauri.conf.json`.
- **Depends on:** none.
- **Tests and acceptance:** Rust tests for the window state store; X1, X2, X5 screenshots; relaunch
  restores a moved, resized window on each OS, clamped to a visible screen.
- **UX checks:** X1, X2, X5, T1, T2.
- **Risks:** the sidebar tint must pass contrast in both themes.
- **Parallel with:** U packages.

### P-06 NAS paths, acceleration and bundled tools per OS

**Status:** partial (2026-11-04): network.rs parsers tested on all OS, target_os audit recorded, recognition smoke test as 3-OS CI job; real Windows and Linux hardware checks outstanding

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 21 shell items: storage, recognition and tools behave the same on all three OSes.
- **Scope:** in: NAS mapping for drive letters, UNC paths and `/media` or `/run/media`; recognition
  acceleration per OS (CoreML, DirectML, CUDA or CPU) with a plain status in Settings; bundled tools
  (exiftool, ffmpeg, RAW decoder) present and versioned on each OS; audit every `target_os` branch for a
  missing sibling. Out: installers.
- **Files:** `apps/desktop/src-tauri/src/` (`network.rs`, `remove_data.rs`, `commands.rs`,
  `server_paths.rs`), `apps/api/src/storageVolumes/`, the inference runtime selection, `prepare-resources`.
- **Depends on:** P-02.
- **Tests and acceptance:** Rust tests for path mapping per OS; CI smoke runs a recognition on each OS;
  manual test of a UNC library on Windows.
- **UX checks:** S9, W4.
- **Risks:** GPU drivers on CI; test acceleration selection logic, run inference on CPU in CI.
- **Parallel with:** P-07, P-08.

### P-07 Windows native feel and installer

**Status:** partial (2026-11-04): high-contrast outline, Snap Layouts and taskbar progress already present, Windows checklist written; native notifications not built (needs a new dependency); SignPath secrets needed

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus screenshots on Windows 11 at 100% and 150% scale and in
  high contrast.
- **Goal:** Lifer feels like a Windows app.
- **Scope:** in: Snap Layouts on the maximise button, taskbar progress for background jobs, native
  notifications for finished jobs (off-able), per-monitor scaling, high contrast, right-click menus
  everywhere the macOS build has them, a signed installer with in-place updates, window controls with a
  contrasting backing. Out: Microsoft Store.
- **Files:** `apps/desktop/src-tauri/` (`tauri.conf.json`, bundle config, `lib.rs`), web context menus,
  `.github/workflows/release.yml`.
- **Depends on:** P-01, P-02.
- **Tests and acceptance:** manual checklist on a real Windows machine; CI builds and signs the installer.
- **UX checks:** X3, X4, X6, Y2.
- **Risks:** code-signing certificate cost and timing; see open question 16.
- **Parallel with:** P-06, P-08.

### P-08 Linux native feel and Flathub

**Status:** partial (2026-11-04): Flatpak manifest fixed, flatpak CI job, store-managed updates hidden in Flatpak; needs first CI run and real GNOME/KDE/Wayland checks, Flathub submission pending

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus screenshots on GNOME and KDE, Wayland, at 125% scale.
- **Goal:** Lifer feels like a Linux app.
- **Scope:** in: the desktop's own window decorations where the system wants them, XDG portals for the
  file chooser and dark mode, Wayland and fractional scaling, freedesktop notifications and desktop
  file, a Flathub manifest, AppImage and deb from the release workflow. Out: Snap.
- **Files:** `apps/desktop/src-tauri/` config, `packaging/flatpak/` (new), `.github/workflows/release.yml`.
- **Depends on:** P-01, P-02.
- **Tests and acceptance:** manual checklist on GNOME and KDE; Flatpak builds in CI.
- **UX checks:** X3, X4, X6, T1.
- **Risks:** WebKitGTK rendering differences; keep the Q-12 screenshots for Linux in each review.
- **Parallel with:** P-06, P-07.

### P-09 Performance: photo open and grids

**Status:** not started

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus Q-10 numbers before and after on each OS.
- **Goal:** UX backlog 20, part 1: photo open shows the loaded thumbnail at once and swaps in the full
  image, neighbours preload, grids stay smooth at every size on the extreme seed.
- **Scope:** in: Lightbox shows the tile's image instantly, decodes the full one off the main thread,
  preloads two neighbours each way; grid virtualisation and image sizing checked at the smallest size on
  a 2560 px window; sort, group and Select all on 5,000 species within budget. Out: page switch speed
  (P-10).
- **Files:** `apps/web/src/components/Lightbox.tsx`, `PhotoTile.tsx`, `MasonryGrid.tsx`,
  `GroupedSpeciesGrid.tsx`, API list routes as measured.
- **Depends on:** Q-10.
- **Tests and acceptance:** Q-10 photo open under 150 ms with no blank frame on all three OSes; grid
  scroll has no long task over 200 ms.
- **UX checks:** P1 to P4, L7, L9.
- **Risks:** memory with preloading at large sizes; cap by bytes.
- **Parallel with:** P-06 to P-08.

### P-10 Performance: page switches, startup and regression gate

**Status:** not started

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 20, part 2: every main page within budget, fast cold start, and a CI gate.
- **Scope:** in: measure first, then fix the worst three pages (Collection switch is known); keep pages
  alive or preloaded for instant back; cold start timing per OS; Q-10 moves from warn to fail at
  budget; indexes where queries are slow (any index needs a migration and approval). Out: rewrites.
- **Files:** as measured; `apps/web/src/App.tsx` (keep-alive), API query files, `e2e/perf-baseline.json`.
- **Depends on:** P-09.
- **Tests and acceptance:** every main page under 100 ms perceived on the extreme seed; Q-10 fails CI
  above budget; cold start figures recorded per OS.
- **UX checks:** P1, P5, P6, P7.
- **Risks:** keep-alive memory with 60,000 photos; keep only the last two pages alive.
- **Parallel with:** T packages.

### Track U: UX backlog polish (M2)

### U-01 Gallery selection bar and toolbar

**Status:** built (2026-11-04): ellipsis removed, shared SelectionBar; e2e for sticky bar and clear-all not run

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 1 (#38).
- **Scope:** in: drop trailing … from selection buttons; the bar is sticky while selecting; "Save as
  smart album" moves into the ⋯ menu; Select and ⋯ swap so ⋯ is far right; "Clear all filters" (shown
  only when a filter is set). Out: pinned filters (F-03).
- **Files:** `apps/web/src/pages/gallery/GalleryHeader.tsx`, `GallerySelection.tsx`,
  `apps/web/src/components/SelectModeToggle.tsx`, `Menu.tsx`, `useGalleryFilters.ts` (`clearFilters`),
  `en.json`.
- **Depends on:** Q-01 to Q-04.
- **Contracts:** the selection bar is the shared one the Collection reuses (U-10).
- **Tests and acceptance:** web tests for the menu order; e2e: select mode, scroll, bar stays; clear
  removes every filter and the URL params.
- **UX checks:** M7, M8, W7, L4, L5, A1; extremes: 60,000 selected, all filters set, smallest window.
- **Risks:** sticky bar under the translucent title bar; check X2.
- **Parallel with:** U-02 to U-09.

### U-02 Text hierarchy and reassuring confirmations

**Status:** partial (2026-11-04): hierarchy.spec written (9 pages plus smart-album dialog and Stats empty text), not run; Stats Year over year has an h2 inside an h3 card

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus the L6 check output.
- **Goal:** UX backlog 3 and 32 (#40, #72).
- **Scope:** in: New smart album title above its sub-heading in size; Stats "Year over year" empty text
  no larger than its title; app-wide audit of dialogs and sections with an automated L6 check (heading
  size at least body size); the remove-regions dialog leads with "Your own photos aren't affected" at
  body size; the same pattern on other destructive confirmations. Out: new type scale (V-02).
- **Files:** `SaveSmartAlbumModal.tsx`, `apps/web/src/pages/stats/`, the remove-regions dialog in
  `DownloadedPacksList.tsx`, `e2e/tests/hierarchy.spec.ts` (new), `en.json`.
- **Depends on:** Q-05.
- **Tests and acceptance:** the L6 spec passes on every dialog and section; screenshots of each fixed
  spot.
- **UX checks:** L5, L6, W5, D2.
- **Risks:** none notable.
- **Parallel with:** U-01, U-03 to U-09.

### U-03 Rating range picker

**Status:** partial: no e2e for the 3 to 5 stars filter

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 4 (#41): a star-range control instead of dropdowns; "1+ stars" goes.
- **Scope:** in: a shared `StarRangePicker` (drag or click a range, keyboard arrows, clear), used in the
  photo filters menu and smart album rules; filter value `{ min, max }`. Out: rating photos.
- **Files:** `apps/web/src/components/StarRangePicker.tsx` (new), `PhotoFiltersMenu.tsx`,
  `pages/gallery/galleryHelpers.ts`, `smartAlbumRules.ts`, `en.json` (`ratingAtLeast`, `starsAtLeast`).
- **Depends on:** none (rules stay v1: `min` maps to the old "at least").
- **Contracts:** API filter `rating=3-5`; old `minRating` still accepted.
- **Tests and acceptance:** component tests for mouse and keyboard; e2e filter 3 to 5 stars.
- **UX checks:** C1, M4, Y1, Y2, T6 (stars mean rating only).
- **Risks:** touch use on the server web app; 44 px targets.
- **Parallel with:** U-01, U-02, U-04 to U-09.

### U-04 "Photographed in year" wording

**Status:** done

- **Model:** Haiku 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 8 (#45).
- **Scope:** in: the `en.json` value at the "Found in year" key and any other "Found in" year copy; docs
  mentions. Out: key renames.
- **Files:** `apps/web/src/locales/en.json`, `docs/docs/` if mentioned.
- **Depends on:** none.
- **Tests and acceptance:** `check:i18n`, `check:copy`; screenshot of the filter.
- **UX checks:** W11.
- **Risks:** none.
- **Parallel with:** everything in M2.

### U-05 Shared View menu and card size for albums and trips

**Status:** partial (2026-11-04): view-menus.spec written, not run; Albums and Trips lists share one card-size storage key (decision pending)

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus the C4 comparison across pages.
- **Goal:** UX backlog 10 (#47) and rule C4: one View menu component with declared sections, and a size
  control on album and trip cards.
- **Scope:** in: `ViewMenu` takes `sections` (size, sort, labels, group); Collection, Gallery, album,
  trip, Albums list and Trips list use it; album and trip card sizes persist per page. Out: Filters menu
  unification (later, if time allows within the same component pattern).
- **Files:** `apps/web/src/components/ViewMenu.tsx` (new, from `PhotoGridControls.tsx`),
  `useGalleryDisplayPrefs.ts`, `useCollectionDisplayPrefs.ts`, `AlbumPhotoGrid.tsx`, `trip/TripPhotoGrid.tsx`,
  `CollectionsPage.tsx`.
- **Depends on:** U-06 (slider).
- **Contracts:** `declare const VIEW_SECTIONS` per page; an E2E opens every View menu and compares.
- **Tests and acceptance:** C4 e2e; sizes persist across relaunch (N3).
- **UX checks:** C3, C4, N3, L7; extremes: 1,000 albums at the smallest size.
- **Risks:** touching four pages other sessions may edit; targeted edits only.
- **Parallel with:** U-01 to U-04, U-07 to U-09.

### U-06 Shared Slider and dark mode control check

**Status:** built (2026-11-04): slider contrast test added; no dark-mode screenshots

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 11 (#48): sliders use the accent green, and every control is checked in dark mode.
- **Scope:** in: a shared `Slider` replacing raw `type="range"` (track and thumb from tokens, focus ring);
  a dark-mode pass over Switch, Checkbox, SegmentedControl, Select, date picker. Out: new colours.
- **Files:** `apps/web/src/components/Slider.tsx` (new), `PhotoGridControls.tsx`, `theme.css`.
- **Depends on:** Q-02.
- **Tests and acceptance:** `contrast.test.ts` covers the new token pairs; dark screenshots of every
  control.
- **UX checks:** T1, T2, Y1, C1.
- **Risks:** WebKitGTK and WebView2 range styling differences.
- **Parallel with:** U-01 to U-04.

### U-07 Cmd-1 to Cmd-9 and the Go menu

**Status:** built (2026-11-04): chords come from keymap.ts, page1-5; browser palette hides chords by design (browser tab keys); e2e not run

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 16 (#54).
- **Scope:** in: Cmd or Ctrl 1 to 9 jump to sidebar pages in sidebar order (today 1 to 5 exist), shown in
  the Go menu and in the server web app's palette; Home takes its place when V-10 lands; plugin pages
  never take a number (L-03). Out: custom bindings.
- **Files:** `apps/desktop/src-tauri/src/menu.rs`, `apps/web/src/App.tsx`, `CommandPalette.tsx`,
  `apps/web/src/lib/platform.ts`.
- **Depends on:** P-01.
- **Contracts:** one ordered page list shared by the sidebar, menu and shortcuts.
- **Tests and acceptance:** e2e presses each chord; menu labels per OS.
- **UX checks:** X7, W4.
- **Risks:** browser tab shortcuts in the server web app; only bind inside the desktop app and show
  them in the palette on the web.
- **Parallel with:** U-01 to U-06.

### U-08 Rich tooltips

**Status:** partial: shared Tooltip opens on focus, main title= uses replaced; about 45 title= remain on non-interactive text and inside menus by design

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 34: name, shortcut and one plain line on hover after a short delay and on focus.
- **Scope:** in: one shared `Tooltip` (built from `InfoTip`'s positioning); Button and IconButton take a
  `tooltip` prop; replace bare `title` attributes (Q-02 baseline entries). Out: help content.
- **Files:** `apps/web/src/components/Tooltip.tsx` (new), `InfoTip.tsx`, `Button.tsx`, `IconButton.tsx`,
  toolbar components.
- **Depends on:** Q-02, P-01 (shortcut labels).
- **Tests and acceptance:** component tests (delay, focus, Escape); M1 containment holds.
- **UX checks:** M9, M1, Y2, W6.
- **Risks:** tooltip spam; one at a time, none while a menu is open.
- **Parallel with:** U-01 to U-07.

### U-09 Collection group heading hover

**Status:** done

- **Model:** Haiku 5.5. **Review:** Opus 5.5.
- **Goal:** #69: an open group's name shows the same hover as a collapsed one, with a clearer chevron.
- **Scope:** in: underline on hover for both states; chevron from the house icon set. Out: grouping.
- **Files:** `apps/web/src/components/GroupedSpeciesGrid.tsx`.
- **Depends on:** none.
- **Tests and acceptance:** Q-09 affordance spec passes for headings.
- **UX checks:** M5, T6.
- **Risks:** none.
- **Parallel with:** everything in M2.

### U-10 Collection multi-select and bulk actions

**Status:** partial (2026-11-04): collection-select.spec written, not run

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** #70 and UX backlog 31.
- **Scope:** in: the Gallery's select mode and selection bar reused on Collection; Shift-click ranges,
  select a whole group, Select all and Deselect all; bulk add to targets, mark as seen, archive; Undo
  toast. Out: bulk species edits beyond these.
- **Files:** `apps/web/src/pages/CollectionPage.tsx`, `GroupedSpeciesGrid.tsx`,
  `pages/gallery/GallerySelection.tsx` (extract to shared), `apps/api/src/collection/routes.ts` (a bulk
  route taking species ids and an action).
- **Depends on:** U-01.
- **Contracts:** `POST /api/collection/bulk { speciesIds, action }`, one transaction, one undo.
- **Tests and acceptance:** integration test for the bulk route; e2e select 3 groups, mark seen, undo.
- **UX checks:** M4, M8, D4, F3, U1; extremes: Select all on 5,000 species.
- **Risks:** grouped virtualised grid and range selection across groups.
- **Parallel with:** U-02 to U-09.

### U-11 Find similar navigation and "Keep all"

**Status:** partial: no e2e for Keep all, Not similar and undo

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus approval record for the migration.
- **Goal:** UX backlog 7 (#44).
- **Scope:** in: remove "Find similar photos" from the ⋯ menu inside that view; a visible back to the
  group list; "Keep all" (and "Not similar") dismisses a group for good. Out: similarity model changes.
- **Files:** `apps/web/src/pages/SimilarPhotosPage.tsx`, `packages/core/src/species/nearDuplicate.ts`,
  its API route, a proposed migration `<next>_similar_dismissals.sql`
  (`similar_dismissals(user_id, capture_a, capture_b)`, ordered pair, cascades), `en.json`.
- **Depends on:** U-05 (View menu if the page has one). **Approval gate:** the migration.
- **Contracts:** dismissed pairs never regroup; a new photo can still join with a third.
- **Tests and acceptance:** integration test that dismissed groups stay gone; e2e back link and Keep all
  with Undo.
- **UX checks:** N2, F3, M7, A3; extremes: 2,000 groups.
- **Risks:** pair table growth; only pairs within dismissed groups.
- **Parallel with:** U-10, U-12.

### U-12 Contextual feature hints

**Status:** partial: tips read keys from keymap, first-map hint added, Tour removed, S tip fixed; review-queue hint waits for V-06

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** #26: short hints where a feature first matters, not long tours.
- **Scope:** in: a list of at most 12 hints (one line, one action, dismiss) on the existing tips system,
  shown once per account when the user first reaches the place (first selection, first smart album,
  first trip, first similar group, first map, first review queue); Settings switch to turn all off;
  remove or shrink `Tour.tsx` long tours. Out: video or modal tours.
- **Files:** `apps/web/src/lib/tips.ts`, `components/Tip.tsx`, `components/Tour.tsx`, `en.json`.
- **Depends on:** none (uses `users.tips_seen`, migration 147).
- **Contracts:** `useHint(id, when)`; never more than one hint visible.
- **Tests and acceptance:** unit tests for once-only and the switch; screenshots of each hint.
- **UX checks:** F6, W5, W6, A1.
- **Risks:** hints for features built later; register each with its feature package.
- **Parallel with:** U-01 to U-11.

### U-13 One keymap, Lightroom keys and the shortcut sheet

**Status:** built (2026-11-04): reserved-key list, clash tests, menu.rs vs keymap test, Shift+0 to 5, ~30 files moved to matches(); e2e keyboard.spec written but not run (harness 401 on login page)

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus a keyboard-only walkthrough on macOS and Windows.
- **Goal:** every shortcut follows `docs/plans/keyboard-shortcuts.md` (Lightroom first), lives in one
  registry, and is shown to the user.
- **Scope:** in: `lib/keymap.ts` as the single source of truth (action id, default key per platform,
  label, where it applies, reserved keys); move every binding into it (`useKeyboardShortcuts`, Lightbox,
  CompareView, import review, Tour, command palette, the desktop menu accelerators); fix the conflicts
  listed in that file (F, C, S, Cmd+I, 0 in Lightbox, zoom chords, video arrows, import review Down,
  digits by `event.code`); add the missing shared keys (Enter or E, G, Space peek, C, I, Z, Shift+0
  to 5, ?); a shortcut sheet on `?` and in the palette; tooltips and menu items read the label from
  the registry. Out: custom bindings, new actions (they register when built).
- **Files:** `apps/web/src/lib/keymap.ts` (new), `hooks/useKeyboardShortcuts.ts`, `components/Lightbox.tsx`,
  `CompareView.tsx`, `importReview/useImportReview.ts`, `Tour.tsx`, `CommandPaletteProvider.tsx`,
  `hooks/useCommandPalette.ts`, `pages/GalleryPage.tsx`, `components/ShortcutSheet.tsx` (new),
  `apps/desktop/src-tauri/src/menu.rs` (accelerators from a list generated from the keymap or checked
  against it), `en.json`.
- **Depends on:** P-01 (`shortcutLabel`, `modKey`). Wires into U-08's Tooltip and U-07's page list,
  whichever lands second does the wiring.
- **Contracts:** `keymap.ts` exports the action list and `matches(actionId, event)`; no component
  compares `e.key` itself; the reserved list is part of the module.
- **Tests and acceptance:** unit test that no two actions share a key in the same scope and no action
  uses a reserved key; a test that `menu.rs` accelerators equal the keymap; e2e presses each table
  row; stars work with an AZERTY layout.
- **UX checks:** M9, X3, X4, X7, W4.
- **Risks:** removing S from select mode changes a habit; note it in the changelog.
- **Parallel with:** U-01 to U-06, U-09 to U-12.

### U-14 Neutral surround in photo viewers

**Status:** built (2026-11-04): contrast test for white text on the surround added

- **Model:** Sonnet 5.5 builds it; Sonnet 5.5 reviews with screenshots in light and dark.
- **Goal:** colour-critical viewing follows ISO 3664 / ISO 12646 (maintainer decision 2026-10-23): a neutral grey surround around photos, no tint.
- **Scope:** in: new `--color-surround` tokens (light and dark) in `theme.css`; Lightbox and CompareView use them instead of the beige or warm dark. Lifer's light theme stays beige elsewhere. Controls over the surround stay readable. Out: any other page.
- **Files:** `apps/web/src/theme.css`, `components/Lightbox.tsx`, `components/CompareView.tsx`.
- **Tests and acceptance:** contrast of white overlay text on the surround meets AA; HIG screenshot review in both themes.
- **UX checks:** F1, F3, W8.

### Track F: filters, smart albums, API and MCP (M3)

### F-01 Multi-value filters: core and API

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check v1 rules load unchanged.
- **Goal:** UX backlog 5 (#42): OR within a filter, AND across filters, everywhere.
- **Scope:** in: one filter model in `packages/shared` (each filter a list of values), the API list
  routes accept repeated params (`region=bc&region=ab`), smart album rules v2 with a reader that accepts
  v1, SQL built with `= ANY($n)`; indexes checked. Out: UI (F-02).
- **Files:** `packages/shared/src/` (filter types), `apps/web/src/lib/photoListFilters.ts`,
  `apps/api/src/albums/smartRules.ts`, `apps/api/src/gallery/routes.ts`, `photoSearch.ts`,
  `apps/api/src/collection/collectionQuery`.
- **Depends on:** Q-11 (golden queries guard search).
- **Contracts:** `PhotoFilters` v2 type; `rules.version` 2 written, 1 read and upgraded in memory.
- **Tests and acceptance:** integration tests per filter for OR and AND; a v1 album returns the same
  photos as before.
- **UX checks:** none (no UI).
- **Risks:** `photoSearch.ts` is large (audit N16); targeted edits, no split here.
- **Parallel with:** F-07.

### F-02 Multi-value filters: UI

**Status:** partial: no e2e for "BC or Alberta, 3 to 5 stars" or the URL round trip

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** pick several values per filter in Gallery, smart album builder, album and trip pages.
- **Scope:** in: multi-select lists in the shared filters menu (checkbox rows with search for long lists
  such as regions), chips that summarise ("BC + Alberta"), the same in the smart album builder. Out:
  pinning (F-03).
- **Files:** `PhotoFiltersMenu.tsx`, `useGalleryFilters.ts`, `smartAlbumRules.ts`, `SaveSmartAlbumModal.tsx`.
- **Depends on:** F-01.
- **Tests and acceptance:** e2e "BC or Alberta, 3 to 5 stars"; URL round trip.
- **UX checks:** C3, A2, M2, S7; extremes: 400 regions selected, chip text overflow.
- **Risks:** chip overflow; collapse to "BC + 3 more".
- **Parallel with:** F-04, F-07.

### F-03 Pinned filters

**Status:** partial: no e2e (pin, rename, relaunch)

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 17 (#55): one-click filter chips in the Gallery toolbar.
- **Scope:** in: pin the current filter set with a name; chips apply it in one click; edit, reorder,
  unpin; "Save as smart album" from a pin; stored per account in user settings (synced). Out: pins on
  other pages.
- **Files:** `GalleryHeader.tsx`, `useGalleryFilters.ts`, `apps/web/src/components/PinnedFilters.tsx`
  (new), the settings mechanism (`useServerSetting`).
- **Depends on:** F-02, U-01.
- **Contracts:** pins stored as `PhotoFilters` v2; no migration.
- **Tests and acceptance:** e2e pin, apply, rename, relaunch, still there.
- **UX checks:** L4, L5, A1, F3; extremes: 30 pins, 80-character names.
- **Risks:** toolbar crowding; overflow into a "More" chip.
- **Parallel with:** F-04, F-05.

### F-04 Smart album suggestion accuracy and restore

**Status:** partial: no restore e2e

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus before and after precision on the seeded library.
- **Goal:** UX backlog 6 (#43).
- **Scope:** in: "Groups of animals" uses the subject count (migration 158) with a confidence floor so
  single animals stay out; a precision check per suggestion type on a labelled fixture; "Show dismissed"
  restores any dismissed suggestion; the builder shows the live count and a preview strip at the top.
  Out: new suggestion types.
- **Files:** `apps/api/src/albums/suggestions.ts`, `apps/web/src/pages/album/AlbumSuggestions.tsx`,
  `SuggestionCard.tsx`, `SaveSmartAlbumModal.tsx`.
- **Depends on:** F-01.
- **Contracts:** dismissed list stays in install settings (`album_suggestions_dismissed:<userId>`);
  `GET /albums/suggestions?dismissed=true`.
- **Tests and acceptance:** precision at least 0.9 per type on the fixture; restore e2e.
- **UX checks:** F3, U1, P1, S6.
- **Risks:** subject counts are model output; show suggestions, never auto-create.
- **Parallel with:** F-02, F-03, F-07.

### F-05 Integration API parity

**Status:** built (2026-11-04): /api/v1/ alias, sensitive coordinates now region-only for API keys (leak fixed on six routes, tested); open decisions on EXIF GPS in originals and regionId

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a scope and leak review.
- **Goal:** UX backlog 9 (#46): integrations get every filter, sort and search, plus smart albums,
  suggestions, similar photos and the map, documented.
- **Scope:** in: public versions of the gallery list (full filter v2 set, sorts, text search), smart
  album CRUD with rules, suggestions, similar groups, map clusters; scopes on each route; OpenAPI and
  `docs/docs/api/overview.md`; response schemas. Out: plugin scopes (L-06), MCP (F-06).
- **Files:** `apps/api/src/integrations/routes.ts`, `openapi.ts`, `apps/api/src/auth/apiKeyRoutes.ts`,
  `apps/api/src/apiRoutes.ts`, `docs/docs/api/overview.md`, `check:api-types`.
- **Depends on:** F-01, F-04.
- **Contracts:** routes under `/api/v1/`; catalog-derived fields only under scopes that already allow
  them; sensitive species locations obscured exactly as in shares.
- **Tests and acceptance:** integration tests per route and scope; `apiRoutes.test.ts` requires a 2xx
  schema on every scoped route; sensitive coordinates never exact.
- **UX checks:** W3, W8 on the API keys page labels.
- **Risks:** route sprawl; reuse the internal handlers, don't fork them.
- **Parallel with:** F-03.

### F-06 MCP server

**Status:** partial: Claude Desktop walkthrough (search, add to album, undo) not recorded

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a security review of write tools.
- **Goal:** UX backlog 12 (#50): assistants can search, ask and make changes through Lifer's API.
- **Scope:** in: `packages/mcp` (new), a stdio MCP server using the official SDK, talking to the local
  desktop API or a server with a scoped API key (read-only keys possible); tools for search, species,
  albums, smart albums, trips, stats and the life list; write tools grouped so each assistant change is
  one undo step; destructive tools ask first (MCP confirmation and a dry-run summary); Settings >
  Integrations shows copy-paste setup snippets for common assistants. Out: a hosted or remote MCP
  endpoint.
- **Files:** `packages/mcp/` (new), `apps/web/src/pages/settings/IntegrationsSettings.tsx`,
  `docs/docs/api/mcp.md` (new), root `package.json` workspaces, lockfile via npm 11.
- **Depends on:** F-05; the desktop gate accepting scoped keys (L-07 pattern, extended to MCP scopes);
  open question 6 for undo.
- **Contracts:** tools map one-to-one to public routes; no private endpoints.
- **Tests and acceptance:** tool tests against a test API; Claude Desktop connects, searches, adds 10
  photos to an album, undoes it.
- **UX checks:** W3, W6, L3 for the settings snippet panel.
- **Risks:** a write tool fanning out to thousands of changes; cap per call and confirm.
- **Parallel with:** I packages.

### F-07 Sensitive species by region

**Status:** built (2026-11-04): share-output tests per case; region label logging already present

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check no location becomes more exact than before.
- **Goal:** UX backlog 2 (#39): a species is sensitive only where eBird lists it as sensitive.
- **Scope:** in: the sensitive list keyed by eBird area; a photo is treated as sensitive when its region or
  coordinates fall in a listed area (point in polygon, or region ancestry when there are no coordinates);
  unknown location keeps the cautious rule; Sensitive species page shows each species' areas; log
  never-matching region labels (audit F44). Out: the user's own extra sensitive list.
- **Files:** `packages/core/src/species/sensitiveSpecies.ts` and its tests, `apps/api/src/shares/routes.ts`,
  `apps/api/src/albums/export.ts`, `apps/web/src/pages/SensitiveSpeciesPage.tsx`.
- **Depends on:** none.
- **Contracts:** `isSensitiveAt(speciesId, { regionId, lat, lon })`; every share, export, portfolio,
  online map tile and iNaturalist upload path calls it.
- **Tests and acceptance:** table tests: Common Goldeneye in the UK sensitive, in Canada not; unknown
  location sensitive; share output for each.
- **UX checks:** W8, S5 on the Sensitive species page.
- **Risks:** relaxing privacy by mistake; default to sensitive on any doubt.
- **Parallel with:** F-01 to F-04.

### F-08 Region search for constituent countries and aliases

**Status:** partial: no regionSearch.test.ts covering each alias (only Holland tested); no e2e for "Holland"

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** #65 app side: "Scotland" finds "Scotland, part of the United Kingdom"; a sovereign lists its
  realms; aliases (Britain, Holland, USA, Burma, Czech Republic, Türkiye) work; placeholders use the
  example city and populous province.
- **Scope:** in: `regionSearch.ts` matches names and aliases with the shared matching rules; result rows
  show "part of"; RegionBrowser lists constituent areas under their sovereign; placeholders from the new
  fields. Out: the data (D-03, D-04).
- **Files:** `apps/web/src/lib/regionSearch.ts`, `apps/web/src/components/RegionBrowser.tsx`,
  `PlaceNameInput.tsx`, region API routes.
- **Depends on:** D-03, D-04 (data and columns, after their migration is approved and applied).
- **Tests and acceptance:** unit tests for each alias; e2e search "Holland".
- **UX checks:** Q2, Q4, W10, N4.
- **Risks:** the published catalog must carry the new fields before release; until then fall back to
  names only.
- **Parallel with:** M4 packages.

### Track V: visual language and library-first (M4)

Order inside this track: V-01 (language) and its sign-off, then V-02 and V-03 (tokens and map style),
then V-08 (screen mockups) and its sign-off, and only then the screens (V-04, V-06, V-10, and N-01,
N-04 later). Backend packages (V-05, V-07, V-09, V-11, V-14, V-15) can start before sign-off.

The review queue here is not the rejected "IDs to double-check" idea: it only lists identifications Lifer
suggested and the user hasn't confirmed. It never questions a species the user chose.

### V-01 Visual language proposal

**Status:** done (sign-off lines in docs/design/visual-language/summary.md still blank above the 2026-10-25 decision)

- **Model:** Opus 5.5. **Review:** Opus 5.5, then the maintainer signs off (HUMAN rule T5).
- **Goal:** #75: define Lifer's own look before new screens: sage, cream and charcoal, flat illustration,
  never a copy of another app.
- **Scope:** in: two or three options side by side as static HTML mockups: a display and text typeface
  pair (open licence, bundled, no web font fetch), one colour per taxa group in both themes (contrast
  checked), an illustration style for taxa group tiles (three sample groups), chart styling, map styling
  notes, the type scale mapped to existing named text styles. Out: implementation.
- **Files:** `docs/design/visual-language/` (new: HTML mockups and a one-page summary).
- **Depends on:** none.
- **Contracts:** the chosen option becomes the token list for V-02.
- **Tests and acceptance:** the maintainer picks an option, with notes recorded in the summary.
- **UX checks:** T2, T5, T6, Y3 (contrast of every taxa colour on both surfaces).
- **Risks:** taste calls; offer options, never decide.
- **Parallel with:** V-05, V-07, V-11, V-14, D track.

### V-02 Visual language tokens

**Status:** partial: placeholders exist, per-group illustrations are the maintainer's; Stats chart colours need the API to send each photo's group

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus `contrast.test.ts` and screenshots of every page.
- **Goal:** the signed-off language lands as design tokens and assets, used by existing pages.
- **Scope:** in: taxa group colour
  tokens (option B; system fonts stay, see the V-01 decision) and a `taxaColour(group)` helper, chart tokens, illustration SVGs for each broad group; existing
  Stats charts and group tiles adopt them. Out: new screens.
- **Files:** `apps/web/src/theme.css`, `apps/web/src/index.css`, `apps/web/src/lib/broadGroups.ts`,
  `apps/web/src/assets/taxa/` (new), `apps/web/src/pages/stats/StatsCharts.tsx`, `docs/docs/credits.md`.
- **Depends on:** V-01 sign-off, Q-02.
- **Tests and acceptance:** contrast tests for every new pair; `check:design-tokens` passes with no new
  escapes; Q-12 screenshots before and after.
- **UX checks:** C5, T1, T2, T6, Y3, L6.
- **Risks:** font size bump shifting layouts; run Q-06 to Q-09 after.
- **Parallel with:** V-03, V-05.

### V-03 Quiet basemap and shaded relief

**Status:** done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus size measurements.
- **Goal:** a calm, desaturated map style (cream and grey, charcoal in dark) for every map, and a
  measured decision on shaded relief.
- **Scope:** in: a custom style for the offline `world-z8.pmtiles` used by PhotoMap, RegionMap, PacksMap
  and SpeciesHotspotMap; clusters coloured by taxa group; shaded relief plus MapLibre 3D terrain
  (tilt to see it) from open elevation data (Copernicus GLO-30, credited) at world zooms, bundled offline;
  sizes measured. Out: detailed extracts (V-11).
- **Files:** `apps/web/src/lib/pmtiles.ts`, `apps/web/src/lib/mapStyle.ts` (new), map components,
  `apps/api/src/settings/assets.ts` (if relief ships).
- **Depends on:** V-02.
- **Tests and acceptance:** the map keeps one instance and doesn't blink (existing behaviour test);
  screenshots in both themes; relief size reported.
- **UX checks:** T1, P2, T3.
- **Risks:** relief size; ship only if under the agreed budget (open question 8).
- **Parallel with:** V-05, V-07.

### V-04 Library-first onboarding

**Status:** partial (2026-11-04): only the I-04 Lightroom entry added; folder-first order, GPS region suggestions, AnalysisStrip, 2,000-file e2e and unplugged-drive state not done

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus first-run e2e on all three OSes.
- **Goal:** #73: first run asks "Where are your wildlife photos?" and Lifer does the rest in the
  background.
- **Scope:** in: pick folders or drives (native picker), or a Lightroom Classic catalogue (I-03); nothing
  copied unless asked; a progress strip (photos analysed, with animals, species found, share confirmed)
  that never blocks; Collection and Home fill live; the region step uses what the photos say where GPS
  exists (suggested, confirmed by the user); Back on every step. Out: Apple Photos.
- **Files:** `apps/web/src/pages/OnboardingPage.tsx`, `BulkImportPage.tsx`, a shared `AnalysisStrip`
  component, `apps/api/src/library/` (in-place registration), `e2e/tests/first-run.spec.ts`.
- **Depends on:** V-08 sign-off, V-05, I-03 for the catalogue option (ships without it if I-03 is late).
- **Contracts:** the analysis job is the same one later imports and watched folders use.
- **Tests and acceptance:** first-run e2e with a 2,000-file fixture; the app is usable during analysis
  (Q-09 pattern).
- **UX checks:** N5, F2, F4, D1, D3, D7, W5, S6; extremes: 0 photos found, 200,000 photos, a drive
  unplugged mid-way.
- **Risks:** this rewrites a page other sessions touch; coordinate before starting.
- **Parallel with:** V-06, V-10.

### V-05 Suggested identifications and auto-filing

**Status:** built (2026-11-04): import files confident matches as suggested, per-group thresholds, collection suggested flag and count, tested; no full-reimport test with the model filing a photo

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check confirmed and user-chosen identifications are
  never changed.
- **Goal:** library-first step 3: confident identifications inside the region checklist are filed as
  "suggested" and count on the life list with that marker until confirmed.
- **Scope:** in: a suggested state on photo identifications (proposed migration: a
  `confirmed_at` or `source` column on the photo-species link, checked against the schema at the time),
  a confidence threshold per group, the encounter grouping that later feeds the queue (time and place
  clusters, reusing the iNaturalist grouping shape), counts of suggested vs confirmed in collection
  state. Out: the queue UI (V-06).
- **Files:** `apps/api/src/captures/suggest.ts`, `apps/api/src/lib/collectionState.ts`,
  `apps/api/src/inaturalist/grouping.ts` (reuse), `packages/core/src/species/suggest.ts`, migration
  `<next>_suggested_identifications.sql`.
- **Depends on:** none. **Approval gate:** the migration.
- **Contracts:** `identification.state` is `suggested` or `confirmed`; anything the user picked by hand
  is `confirmed`; API returns `suggestedCount` beside counts.
- **Tests and acceptance:** integration tests: a confident match outside the checklist stays unfiled; a
  user choice is never overwritten; life list counts include suggested with a flag.
- **UX checks:** U1 (counts agree).
- **Risks:** threshold tuning per taxa group; start conservative and measure on confirmed photos.
- **Parallel with:** V-01 to V-03, V-07.

### V-06 Review identifications queue

**Status:** partial (2026-11-04): /review page built from the unsigned mockup (confirm, 1 to 5, S for Not sure, background re-file); no e2e, never screenshotted with suggested photos, 500 photos per confirm press cap

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus keyboard-only walkthrough.
- **Goal:** one queue for what Lifer couldn't settle, grouped by species and encounter.
- **Scope:** in: groups ordered by importance (possible lifers, then low confidence, then the rest); a
  large photo, top suggestions and "Not sure"; confirm a whole encounter in one action; fully keyboard
  driven; "312 of 1,940 confirmed"; leave and resume. Out: second-guessing confirmed photos.
- **Files:** `apps/web/src/pages/ReviewPage.tsx` (new), `apps/web/src/components/importReview/` (reuse),
  route in `App.tsx`, API list and confirm routes.
- **Depends on:** V-05, V-08 sign-off.
- **Tests and acceptance:** e2e confirming 40 frames with one key; resume after relaunch.
- **UX checks:** M4, F1, F3, P1, S6, U1; extremes: 20,000 waiting, one species with 3,000 frames.
- **Risks:** decoding speed on large frames; reuse P-09 preloading.
- **Parallel with:** V-04, V-10.

### V-07 Watched folders

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** library-first step 5: new photos in chosen folders are picked up automatically.
- **Scope:** in: per-folder watch using `watchLibraryFolder` with a polling fallback for network drives,
  debounce until files stop changing, the same analysis job, pause while a library move or reorganize
  runs; a switch per folder. Out: watching on the server web app (servers watch their own library root).
- **Files:** `packages/core/src/lib/libraryFolder.ts`, `apps/api/src/library/`, the settings storage pane.
- **Depends on:** V-05.
- **Tests and acceptance:** integration test with a temp folder; a half-copied file is not imported early;
  an unplugged drive pauses quietly.
- **UX checks:** F2, S9, F6.
- **Risks:** file watcher limits on Linux (inotify); fall back to polling and say so in logs only.
- **Parallel with:** V-01 to V-06.

### V-08 Screen mockups for sign-off

**Status:** built (2026-11-04): mockups in docs/design/screens/ (home, onboarding, review, year-in-review, portfolio); awaiting maintainer sign-off

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, then the maintainer signs off each screen.
- **Goal:** high-fidelity mockups of Home, onboarding, the review queue, Year in Review and the portfolio
  in the signed-off language, before any is built.
- **Scope:** in: static HTML mockups in light and dark, at 1280 and 2560 px and phone width, with real
  numbers from the extreme and sparse seeds (0 photos, 1 photo, 200,000 photos, long names). Out: code.
- **Files:** `docs/design/screens/` (new).
- **Depends on:** V-02.
- **Tests and acceptance:** the maintainer signs off or asks for changes per screen; decisions recorded.
- **UX checks:** every VISUAL and HUMAN rule applies; L1, L5, T5.
- **Risks:** mockups drift from tokens; build them from the real `theme.css`.
- **Parallel with:** V-05, V-07, V-09.

### V-09 Home data API

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus timings on the extreme seed.
- **Goal:** #74 backend: one fast endpoint for the home view, answering from local data instantly.
- **Scope:** in: headline counts (photos, species, places, trips, share confirmed), places with clusters,
  taxa group counts against catalogue totals, a conservation tally from IUCN status, photos by month
  stacked by group, gear by body and lens, targets for the current or next trip, cover photos picked by
  quality scores; cached and invalidated on change. Out: UI.
- **Files:** `apps/api/src/home/` (new), `apps/api/src/stats/overview.ts`, `insights.ts` (reuse).
- **Depends on:** V-05 (share confirmed).
- **Contracts:** `GET /api/home` under 50 ms warm on the extreme seed; numbers equal Stats for the same
  concept (U1).
- **Tests and acceptance:** integration tests for each figure on seeded data; timing test.
- **UX checks:** U1.
- **Risks:** catalogue totals per group depend on installed regions; state what is counted.
- **Parallel with:** V-04, V-06.

### V-10 Home view

**Status:** changed (2026-11-07): maintainer removed Home from navigation and deleted the page; Review has its own sidebar item with a count badge, Year in Review and Tree of life are links on Stats

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** #74: the signed-off home view, as the first sidebar page.
- **Scope:** in: the map as canvas with floating cards that pass contrast, taxa group tiles, conservation
  tally, timeline linked both ways with the map (brushing dates filters the map, a place highlights its
  dates), gear, targets; hover a place for a small photo grid; every tile opens the filtered Gallery or
  Collection. Out: editing from Home.
- **Files:** `apps/web/src/pages/HomePage.tsx` (new), `apps/web/src/pages/home/` (new), `App.tsx`,
  `AppSidebar.tsx`, menu order (U-07).
- **Depends on:** V-08 sign-off, V-09, V-03.
- **Tests and acceptance:** opens under budget (Q-10); e2e each tile navigates and back returns (Q-06).
- **UX checks:** P1, P2, L1, L5, S6, A1, T1, U1; extremes: 0 photos (first-week mode), 1 photo, 200,000.
- **Risks:** map plus charts cost; render charts after first paint.
- **Parallel with:** V-04, V-06, V-11.

### V-11 Detailed offline map extracts

**Status:** partial (2026-11-04): maps refresh stage, list/download/cancel/remove API with free-space check, map drawn from zoom 9, Settings row; nothing published; no screenshots, no terrain, big countries not split

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus licence attribution check.
- **Goal:** #77 part 1: an optional detailed map per country, built once and served like region packs.
- **Scope:** in: a `maps` stage in `refresh` that cuts per-country street and trail extracts with
  Protomaps tools (resumable, incremental per country), size shown before download with free space
  (P-03), the app uses a detailed extract where present and the world map elsewhere, OSM attribution on
  every map; each extract carries high-detail terrain for 3D close-ups. Out: online tiles (V-12).
- **Files:** `packages/data-pipeline/src/scripts/refresh.ts` (stage), `packages/data-pipeline/src/pipeline/maps.ts`
  (new), `apps/api/src/offlinePacks/`, `apps/web/src/lib/pmtiles.ts`, `apps/desktop/src-tauri/src/api.rs`
  (tile serving).
- **Depends on:** P-03, V-03. **Publish gate:** the maintainer's go-ahead.
- **Contracts:** extract per country code; manifest lists size and checksum like packs.
- **Tests and acceptance:** pipeline test on a small country; app shows street level in that country only.
- **UX checks:** F2, F4, A4, W8.
- **Risks:** extract sizes for large countries; split by province where over the budget.
- **Parallel with:** V-04 to V-10.

### V-12 Optional online detail tiles

**Status:** done (scope changed by maintainer 2026-11-04, see map-detail-and-satellite.md)

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus a privacy review (no tile request ever for a sensitive
  photo).
- **Goal:** #77 part 2: optional online detail anywhere, off by default.
- **Scope:** in: setting "Load detailed map tiles from the internet when zooming in" with plain words on
  what is sent and to whom; tiles fetched as needed and cached; never used while placing or viewing
  sensitive-species photos (F-07); the provider is one whose terms allow app use. Out: choosing the
  provider (open question 7).
- **Files:** `apps/web/src/lib/mapStyle.ts`, settings pane, `apps/desktop/src-tauri/src/security.rs`
  (allow the tile host only when on), API CSP.
- **Depends on:** V-11, F-07.
- **Tests and acceptance:** with the setting off, a network capture shows no tile requests; with it on,
  none while a sensitive photo is shown.
- **UX checks:** W5, W6, S9.
- **Risks:** provider key in a public repo; see open question 7.
- **Parallel with:** V-13 to V-15.

### V-13 Placing photos on the map

**Status:** partial (2026-11-04): drag/undo e2e written, not run; offline place search per region pack (MAP-07, MAP-08) not built

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** library-first "Placing photos": drag one photo or a selection onto the map; search a place
  offline; reuse a saved spot.
- **Scope:** in: drop target on PhotoMap and the coordinates dialog; offline place search from region
  data and populated places; saved spot picker (V-14); writes to files as today; triggers V-15. Out:
  GPX or phone tracks (rejected).
- **Files:** `apps/web/src/components/CoordinatesModal.tsx`, `PhotoMap.tsx`, `PlaceNameInput.tsx`,
  capture location routes.
- **Depends on:** V-14, V-11 (detail where present).
- **Tests and acceptance:** e2e drag 20 photos onto a pond; Undo.
- **UX checks:** M6, D7, F3, W10.
- **Risks:** drag on touch screens for the server web app; offer "Set location" as well.
- **Parallel with:** V-12, V-15.

### V-14 Saved spots

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus sync tracking present on the new table.
- **Goal:** #64 and UX backlog 26: named places with coordinates, region and a default iNaturalist
  geoprivacy.
- **Scope:** in: proposed migration for `saved_spots` (with `updated_at`, `pushed_at`, tombstone trigger
  from S-01's pattern); create from a photo or the map; apply to a selection, trip or import in one go,
  written to files; suggest nearby spots for photos within a radius (user confirms); iNaturalist uploads
  take the spot's geoprivacy; manage on the existing Places page. Out: sharing spots.
- **Files:** migration `<next>_saved_spots.sql`, `apps/api/src/places/` (new or existing places routes),
  `apps/web/src/pages/ManagePlacesPage.tsx`, `CoordinatesModal.tsx`, sync entity registration.
- **Depends on:** S-01 (pattern), S-02 (feed). **Approval gate:** the migration.
- **Contracts:** `SavedSpot { id, name, lat, lon, regionId, geoprivacy }`; geoprivacy `open`,
  `obscured`, `private`.
- **Tests and acceptance:** integration tests for apply to 5,000 photos as one background job and one
  undo; sync round trip.
- **UX checks:** D5, D7, F2, F3, W11; extremes: 500 spots, 120-character names.
- **Risks:** written-to-files apply on a slow NAS; background job with progress.
- **Parallel with:** V-01 to V-11.

### V-15 Re-check species after a location is set

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check confirmed photos are never changed.
- **Goal:** #78: a new location re-runs suggestions against that region's checklist for unconfirmed
  photos, and the user sees what changed.
- **Scope:** in: on coordinate or spot change, queue a re-suggest job for affected unconfirmed photos;
  a toast "Suggestions changed for 12 photos" linking to the review queue; no change to confirmed or
  user-chosen species. Out: re-running confirmed photos.
- **Files:** `apps/api/src/captures/suggest.ts`, location routes, `apps/api/src/lib/job.ts`.
- **Depends on:** V-05, V-13.
- **Tests and acceptance:** integration test: a gull photo placed in BC changes suggestion order;
  a confirmed photo is untouched.
- **UX checks:** F1, F6, D5.
- **Risks:** burst of jobs on a big apply; one job per apply.
- **Parallel with:** V-12, V-16.

### V-16 Tree-of-life explorer and quality covers

**Status:** partial (2026-11-04): /api/collection/tree with CSV and /explore built; best-photo default covers; no Collection View menu entry, covers use rating not sharpness

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** library-first "Other ideas": walk class, order, family and genus to species with counts and
  the best photo at each level, with CSV export; cover images picked by quality everywhere.
- **Scope:** in: an explorer view reached from Home's group tiles and the Collection View menu; covers by
  sharpness and subject scores instead of date (album, trip, group, species defaults); one trash across
  all sources (check it is already one; fix if not). Out: new taxonomy data.
- **Files:** `apps/web/src/pages/home/TaxaExplorer.tsx` (new), `apps/api/src/collection/`,
  `apps/api/src/collection/defaultCardCrop.ts` (cover logic).
- **Depends on:** V-10.
- **Tests and acceptance:** counts equal Collection counts (U1); CSV opens in a spreadsheet.
- **UX checks:** N1, U1, S7, P1.
- **Risks:** families missing for hand-added species; group them under "Other".
- **Parallel with:** V-12 to V-15.

### V-17 Photo versions: grouping edits and exports into one capture

**Status:** built (2026-11-04): migration 185 (originals.role, document_id, capture_versions), rules 1 and 2 link alone, rule 3 suggests only, split restores everything, 9/9 tests pass; rule 4 (image similarity) and folder-name hint not built; no screenshots

**Status:** extended (2026-11-12): migration 193 (version_folder evidence, capture_version_labels, users.version_folder_names); version-folder rule (Prints, B&W, Edits... beside or under the original's folder, same name: links with the same press, else suggests; never on the folder alone); folder names editable in Settings; "Look for versions in a folder" re-groups one folder as a background job; -BW, _bw and size suffixes; 15 API tests pass on a scratch DB; rule 4 (image similarity) still not built

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check nothing is merged, moved or deleted without a
  recorded reason and an undo.
- **Goal:** photographers who keep a folder per subject (a "Moose" folder holding edits, several export
  sizes and saved DNG edits, with no reliance on a Lightroom catalogue) import a historic library and get
  one capture per photographed moment, not one per file. Today's RAW and Adjusted pairing (exact stem plus
  capture time within a second, `trips/rawLink.ts`, `uploads/rawMatching.ts`) only handles one RAW and one
  JPEG, so `_M8A6162-2.jpg` and `_M8A6162-6.jpg` import as separate photos and inflate every count.
- **Scope:** in: file roles on a capture's originals (`original`, `edit`, `export`; the existing
  `kind` stays), and a grouping step that links derived files to their capture with evidence, strongest
  first: (1) the Lightroom or Photoshop `OriginalDocumentID` (fall back to `DerivedFromDocumentID`) shared
  with the capture's file; (2) same `DateTimeOriginal` plus sub-second plus body serial, with a stem that
  differs only by a known suffix (`-2`, `-Edit`, `-Enhanced-NR`, `-Pano`, a size tag such as `_10x27`);
  (3) same capture time and serial alone, offered as a suggestion; (4) image similarity, offered as a
  suggestion only. Only (1) and (2) link on their own; (3) and (4) wait for a person (V-18). Edits and
  exports of different dimensions (crops, panoramas, print sizes) are expected, so size is never a
  signal. A group's display file is the finished export the user prefers, else the newest edit, else the
  original; the capture counts once everywhere (life list, species counts, Home). The parent folder name
  of an unlinked import (`Moose/`) feeds species suggestion as a strong hint that CLIP confirms or
  contradicts, never as a silent assignment. Imports from such a folder link in place by default and keep
  his folder structure. Out: reading Lightroom catalogues (I-03), UI (V-18), editing or developing files.
- **Files:** `apps/api/src/uploads/versionGrouping.ts` (new), `rawMatching.ts`, `trips/rawLink.ts` (share
  the stem and suffix rules), `library/reimport.ts`, `uploads/exif.ts` (read the document IDs),
  `captures/suggest.ts` (folder hint), `docs/docs/contributing/imports-and-metadata.md`, migration
  `<next>_original_roles.sql` (a `role` column on `originals`, checked against the schema at the time).
- **Depends on:** none. **Approval gate:** the migration.
- **Contracts:** `originals.role` is `original`, `edit` or `export`; every grouping decision records its
  evidence (`document_id`, `time_serial_suffix`, `suggested`) so it can be explained and undone; a split
  returns a file to its own capture.
- **Tests and acceptance:** integration tests on small generated fixtures that carry the same metadata as
  real files (three JPEGs sharing a document ID, capture time and serial with different dimensions and
  `-2` and `-6` suffixes; a fourth with a different ID stays apart; a RAW plus DNG edit plus three
  exports; a folder where stems collide across subfolders). Counts: three linked files give one capture
  on the life list. Undo of a link and of a split. Re-running the import changes nothing (idempotent).
- **UX checks:** U1 (counts agree), W3 (a long import does not block).
- **Risks:** wrong merges are worse than missed ones, so only the two evidence-backed rules act alone;
  files with stripped metadata stay separate until a person links them; very large folders need the
  grouping pass to stay incremental.
- **Parallel with:** V-05, V-07, V-14.

### V-18 Versions in the viewer and the group review

**Status:** partial (2026-11-04): versions panel, link/split/use-as-photo, suggestion review on Import with Undo built; actions registered with no keys yet; no e2e or screenshots; awaiting sign-off

**Status:** extended (2026-11-12): stack badge ("3 versions") on every photo grid and in the viewer; viewer switcher with labels from names and folders, inline rename, Use as photo, Option/Alt+Left and Right; zoom kept across same-size versions; Gallery View "Show every version as its own photo" (allVersions=1, selection off, version menu); notice after grouping on Import and Gallery; folder hint on Import; first-time tip; Settings > Species and import > Photo versions; guide docs/docs/guides/photo-versions.md; 7 web tests; no e2e and no screenshots from the real app; awaiting sign-off

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus screenshots in light and dark and a keyboard-only
  walkthrough.
- **Goal:** show and control what V-17 grouped, with the user in charge of anything uncertain.
- **Scope:** in: a "Versions" strip in the photo viewer listing the original, edits and exports with their
  size, format and file name, "Use this as the photo", "Open in" and "Show in Finder or Explorer" per
  version (the shared photo menu), a plain "grouped with 2 other files" line on the photo, and **Split
  out** and **Link to** actions (undoable, no confirmation dialog). A review step after an import lists
  suggested groups (V-17 rules 3 and 4) as side-by-side thumbnails with one keystroke to link all
  confident ones; it appears in the import summary, never as a blocking dialog. Out: automatic linking
  beyond V-17's rules.
- **Files:** `apps/web/src/components/PhotoVersions.tsx` (new), the photo viewer, the shared photo menu,
  `apps/web/src/pages/` import summary, `apps/api/src/captures/` routes for split and link.
- **Depends on:** V-17, V-06 (reuse the queue pattern). **Mockups:** needs V-08 sign-off first.
- **Tests and acceptance:** e2e: link, split and undo a group; keyboard-only review of 20 suggested
  groups; a capture with 30 versions and very long file names still lays out (design for extremes).
- **UX checks:** M7, A1, X3, U1; polish bar per the maintainer.
- **Risks:** a group of many exports can bury the finished photo; the display file is always pinned first.
- **Parallel with:** V-10, V-12.

### Track I: integrations (M5)

The plugin host and integration API (L-01 to L-14, `plugin-host-and-integration-api.md`) runs in this
milestone beside the I packages. I-05 depends on L-06, L-07 and L-10; F-06 reuses L-07's desktop gate
rule for its own scopes.

### I-01 iNaturalist sign-in trust model

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a threat-model read.
- **Goal:** UX backlog 28 (#66).
- **Scope:** in: the desktop signs in directly on loopback, never through the relay; a desktop linked to
  a server passes the token to the server over the sync link; browser-only servers use the relay with a
  first-time warning per address, then remembered trust; callbacks bound to the session (state tied to a
  session nonce, single use); the threat model in `docs/docs/security-model.md`; both redirect URIs listed
  for the app registration. Out: activating uploads before iNaturalist approves the app.
- **Files:** `apps/api/src/inaturalist/routes.ts`, `relayState.ts`, `tokenStore.ts`,
  `packages/core/src/config.ts`, `docs/docs/security-model.md`, the iNaturalist settings page.
- **Depends on:** S-04 (link secret, for the token hand-off).
- **Tests and acceptance:** integration tests: a replayed callback fails; a callback for another session
  fails; desktop never hits the relay; trusted address remembered.
- **UX checks:** W3, W5, D2 (the warning appears once per address).
- **Risks:** iNaturalist approval timing; ship the flow dark and switch on when approved.
- **Parallel with:** I-02 to I-09.

### I-02 Open in external editors

**Status:** partial (2026-11-04): manual test script per OS written; not run on real machines

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus screenshots on all three OSes.
- **Goal:** UX backlog 15 (#53): open a photo, the viewer's photo or a selection in an installed editor,
  preferring the RAW.
- **Scope:** in: detect installed editors per OS (Lightroom Classic, Photoshop, Capture One, DxO,
  darktable, RawTherapee, Affinity, GIMP, the system default) from known install locations; "Open in"
  submenu in the photo menu, viewer and selection bar; RAW first, else the original; remember the last
  editor. Out: round-trip editing, reading edits back (XMP already covers marks).
- **Files:** `apps/desktop/src-tauri/src/editors.rs` (new), `commands.rs`, `permissions/app-commands.toml`,
  `apps/web/src/lib/openExternal.ts`, `RevealOriginalMenuItem.tsx` (pattern), the shared photo menu.
- **Depends on:** P-01.
- **Contracts:** command `editors_list() -> { id, name }[]`, `open_in(editorId, paths[])`.
- **Tests and acceptance:** Rust tests for detection with fake install trees; manual test per OS.
- **UX checks:** M7, A1 (hidden with no editors found), W4, X3; polish bar per the maintainer.
- **Risks:** mirrored server photos have no local original; hide the item there.
- **Parallel with:** I-01, I-03 to I-09.

### I-03 Lightroom Classic catalogue reader

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus confirm the catalogue file is never written.
- **Goal:** #56 backend: read a `.lrcat` without changing it.
- **Scope:** in: open read-only (copy to a temp file first if Lightroom holds a lock); read ratings, flags,
  colour labels, keywords, captions, GPS, collections and smart collections; map smart collection rules
  to smart album rules where they map, report the rest; match catalogue photos to Lifer photos by path
  and fingerprint; produce a change set. Out: applying (I-04), writing to the catalogue.
- **Files:** `apps/api/src/integrations/lightroom/` (new), `apps/api/src/species/matchByKeywords.ts`
  (reuse for species keywords).
- **Depends on:** F-01 (rules v2). Open question 3 decides the SQLite library.
- **Contracts:** `readCatalog(path) -> ChangeSet { photos: [...], albums: [...], unmapped: [...] }`.
- **Tests and acceptance:** fixture catalogues from Lightroom Classic 12 and 13; a 100,000-photo
  catalogue reads within a minute and in the background.
- **UX checks:** none (no UI).
- **Risks:** undocumented schema changes between versions; test against several.
- **Parallel with:** I-06, I-08.

### I-04 Lightroom Classic import preview and apply

**Status:** partial (2026-11-04): e2e written against desktop API, not run; Lightroom onboarding entry added by V-04 lane

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** #56 UI: preview what will change, then apply in the background.
- **Scope:** in: Import menu and onboarding entry "Lightroom Classic catalogue"; a preview grouped by kind
  (ratings, flags, labels, keywords, captions, locations, albums, smart albums) with counts and samples,
  per-group switches; apply as one background job with one undo; photos not yet in Lifer offered for
  in-place import. Out: two-way sync.
- **Files:** `apps/web/src/pages/import/LightroomImport.tsx` (new), Import menu, `OnboardingPage.tsx`
  hook, API routes for preview and apply.
- **Depends on:** I-03.
- **Tests and acceptance:** e2e with a fixture catalogue; undo restores.
- **UX checks:** F2, F3, D5, W8, S7; extremes: 100,000 changes, 3,000 collections.
- **Risks:** conflicting ratings already set in Lifer; preview shows them and Lifer's value wins unless
  the user switches it.
- **Parallel with:** I-05, I-07, I-09.

### I-05 Free Lightroom Classic plugin

**Status:** partial (2026-11-04): manual test script for the Lightroom plugin written; not run on macOS or Windows

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus a check that it only talks to the user's own Lifer.
- **Goal:** #76: a small Lua plugin that brings Lifer's species into Lightroom and sends photos to Lifer.
- **Scope:** in: confirmed species as keywords (common, scientific and hierarchy, layout chosen by the
  user), ratings, "lifer", "target" and "still need a better photo" as keywords; "Send selection to
  Lifer" for identification or import; run on demand or after Lightroom imports; pairs with a code like
  any integration; talks only to the local desktop API or the user's server; zipped in releases. Out:
  any Adobe store listing.
- **Files:** `integrations/lightroom-classic/lifer.lrplugin/` (new, Lua), `docs/docs/guides/lightroom.md`
  (new), `.github/workflows/release.yml` (zip asset).
- **Depends on:** L-06, L-07, L-08, L-10 (scopes, gate, pairing, folder imports), I-03 (shared keyword
  layout).
- **Contracts:** uses only public routes and scopes; keyword layout shared with Lifer's XMP writer.
- **Tests and acceptance:** Lua unit tests where possible; manual test script on Lightroom Classic on
  macOS and Windows.
- **UX checks:** W3, W6 (Lightroom dialogs follow Lifer's wording).
- **Risks:** Lightroom SDK licence terms for distribution; see data and licence notes.
- **Parallel with:** I-04, I-06 to I-09.

### I-06 eBird checklists matched to photos

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 19 (#57) backend.
- **Scope:** in: import the user's "My eBird Data" CSV (eBird has no API for a user's own checklists);
  proposed migration for `ebird_checklists` and a photo-to-checklist link; match photos by time (with the
  camera clock offset) and distance; each match is a suggestion the user confirms per trip; trips list
  their checklists; each photo links to its checklist on eBird; "gather this checklist's photos" exports
  them to a folder for eBird's own upload. Out: sighting maps, recent sightings, hotspot feeds (eBird does
  these; link out).
- **Files:** `apps/api/src/integrations/ebird/` (new), migration `<next>_ebird_checklists.sql`,
  `apps/api/src/trips/`.
- **Depends on:** none. **Approval gate:** the migration.
- **Contracts:** `ebird_checklists(user_id, sub_id, started_at, duration, lat, lon, location, species[])`;
  link table `(capture_id, sub_id, confirmed)`.
- **Tests and acceptance:** fixture CSV; matching tests across time zones; species on the checklist
  boost suggestions for matched photos.
- **UX checks:** none here (I-07).
- **Risks:** CSV format changes; validate headers and say plainly what is wrong.
- **Parallel with:** I-03, I-08.

### I-07 eBird checklists UI

**Status:** partial (2026-11-04): 4,000-checklist test passes (import 148 ms, match 67 ms); trip checklist list stops at 500 with no paging and is slow until ANALYZE; e2e not run

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** the eBird import, matches and links in the app.
- **Scope:** in: Settings > Integrations "Import eBird data" with a file picker; trip page "Checklists"
  section with suggested matches to confirm; photo info links "Open checklist on eBird"; export photos for
  a checklist. Out: anything eBird's site does better.
- **Files:** `apps/web/src/pages/settings/IntegrationsSettings.tsx`, `TripDetailPage.tsx`, photo info panel.
- **Depends on:** I-06.
- **Tests and acceptance:** e2e import, confirm a match, open link (helper, Q-04).
- **UX checks:** D5, F2, X3, S6; extremes: 4,000 checklists.
- **Risks:** none notable.
- **Parallel with:** I-04, I-05, I-09.

### I-08 Immich sync backend (server only)

**Status:** partial (2026-11-04): migration 186, by-reference import, Immich settings UI, tests pass; no videos or RAW, albums only, no scheduled sync, no review screen, needs one real-server smoke test, no screenshots

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check Lifer never deletes or edits anything in Immich
  except the tags the user turned on.
- **Goal:** #25: a Lifer server can use an Immich library as a photo source.
- **Scope:** in: link an Immich server with its API key (stored like other secrets); choose albums or
  people-free folders to bring in; import by reference (decided 2026-10-25: originals stay in Immich and are read through
  its API in place, derivatives kept in Lifer) with dedup by checksum; incremental by Immich's updated time; optional write-back
  of confirmed species as Immich tags (off by default); proposed migration for the Immich asset link.
  Out: desktop mode, Immich face data, deleting anything in Immich.
- **Files:** `apps/api/src/integrations/immich/` (new), migration `<next>_immich_link.sql`.
- **Depends on:** P-03 (space for derivatives). **Approval gate:** the migration. Open question 5.
- **Contracts:** `immich_assets(capture_id, immich_asset_id, immich_updated_at)`.
- **Tests and acceptance:** integration tests against a recorded Immich API fixture; rerun imports
  nothing new.
- **UX checks:** none here (I-09).
- **Risks:** Immich API changes between versions; pin a minimum version and check at link time.
- **Parallel with:** I-03, I-06.

### I-09 Immich settings and status

**Status:** built (2026-11-04) with I-08: tag writes opt-in, only tag routes written (tested), 404 in desktop mode; no screenshots

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** link, choose sources and see sync status, server only.
- **Scope:** in: Settings > Integrations "Immich" (server URL, API key, test connection, albums to bring
  in, write-back switch with plain words), status row with last sync and counts. Out: desktop.
- **Files:** `IntegrationsSettings.tsx`, `en.json`.
- **Depends on:** I-08.
- **Tests and acceptance:** web tests for states; hidden in desktop mode.
- **UX checks:** L3, W3, A1, S1, F4.
- **Risks:** none notable.
- **Parallel with:** I-04, I-05, I-07.

### Track N: new features (M6)

### N-01 Year in Review and seasonal nudges

**Status:** partial (2026-11-04): year-in-review API and page built, sensitive places dropped; no share as image or page, no 0/1/40,000 e2e, no nudge toggle UI

- **Model:** Sonnet 5.5. **Review:** Opus 5.5, plus numbers agree with Stats.
- **Goal:** UX backlog 22 (#60).
- **Scope:** in: a Year in Review page (from the signed-off mockup): new species, best photos by quality,
  trips, firsts, busiest months by group, gear, places, year-over-year; shareable as an image or a static
  page with sensitive locations obscured; seasonal nudges on Home ("Last spring you photographed 14
  warblers in May"), off-able. Out: social posting.
- **Files:** `apps/web/src/pages/YearInReviewPage.tsx` (new), `apps/api/src/stats/yearInReview.ts` (new),
  Home card.
- **Depends on:** V-08 sign-off, V-09, F-07.
- **Tests and acceptance:** integration tests for figures; e2e for a year with 0, 1 and 40,000 photos.
- **UX checks:** U1, S5, W9, W11, F6, T5.
- **Risks:** nudges feeling like gamification; keep them factual, no streaks or badges.
- **Parallel with:** N-02 to N-06.

### N-02 Sound recordings: backend

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 23 (#61): recordings attached like videos, no recognition, and they count as
  heard.
- **Scope:** in: proposed migration widening capture and original kinds to `audio`; import of WAV, FLAC,
  MP3, M4A with duration and a waveform image as derivative; species assigned by hand or keyword; a
  species with only audio captures shows as heard (derived, open question 2). Out: sound ID.
- **Files:** migration `<next>_audio_captures.sql`, `apps/api/src/uploads/`, `packages/shared/src/folderLayout.ts`,
  `apps/api/src/lib/collectionState.ts`.
- **Depends on:** none. **Approval gate:** the migration.
- **Tests and acceptance:** integration tests for import, folder layout, life list heard state.
- **UX checks:** none here (N-03).
- **Risks:** bundled tool for audio metadata and waveform per OS (ffmpeg already bundled).
- **Parallel with:** N-04, N-06.

### N-03 Sound recordings: UI

**Status:** partial (2026-11-04): e2e written (sound-recordings.spec), not run; app has no screen to import a recording (API only)

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** recordings play, show and count everywhere photos do, with the right words.
- **Scope:** in: tile with waveform and duration; player in the viewer; "Heard" badge; filters include
  media type; copy names the object (W8, W9). Out: editing audio.
- **Files:** `PhotoTile.tsx`, `Lightbox.tsx`, `PhotoFiltersMenu.tsx`, `en.json`.
- **Depends on:** N-02.
- **Tests and acceptance:** e2e import a recording, play, filter.
- **UX checks:** W8, W9, C3, Y2.
- **Risks:** none notable.
- **Parallel with:** N-05, N-06.

### N-04 Portfolio and public life list: backend

**Status:** done

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a privacy and security review.
- **Goal:** UX backlog 24 (#62): a curated site and a public life list, as a static export (desktop and
  server) and a share link (server).
- **Scope:** in: a static site generator writing HTML, images and a life list page to a chosen folder; a
  server share kind for the portfolio and life list reusing share links (proposed migration only if the
  shares table needs a new kind); exact locations never published; sensitive species obscured per F-07;
  no tracking or third-party requests in the generated pages. Out: hosting for the user.
- **Files:** `apps/api/src/portfolio/` (new), `apps/api/src/shares/routes.ts`, `apps/api/src/albums/export.ts`
  (reuse).
- **Depends on:** F-07, V-08 sign-off (layout).
- **Tests and acceptance:** generated site passes a scan for coordinates and external URLs; share link
  revocation works.
- **UX checks:** none here (N-05).
- **Risks:** EXIF GPS left in exported images; strip it always.
- **Parallel with:** N-02, N-06.

### N-05 Portfolio and public life list: UI

**Status:** partial (2026-11-04): PortfolioPage unit test passes (5/5); e2e written, not run, no site screenshots

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** choose what goes in, preview, export or share.
- **Scope:** in: a builder (pick albums, species best photos, life list sections), preview at phone and
  desktop widths, export folder picker, share link on servers, the published pages themselves in Lifer's
  visual language. Out: themes beyond light and dark.
- **Files:** `apps/web/src/pages/PortfolioPage.tsx` (new), the static templates.
- **Depends on:** N-04.
- **Tests and acceptance:** e2e export and open the result; screenshots of the generated site.
- **UX checks:** D7, L1, W8, T1, S7; extremes: 2,000 species life list.
- **Risks:** none notable.
- **Parallel with:** N-03, N-06.

### N-06 Save a video frame as a photo

**Status:** partial (2026-11-04): e2e written (video-frame.spec), not run

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** UX backlog 25 (#63): an exact frame at full resolution, no adjustments.
- **Scope:** in: frame step in the viewer, "Save frame as photo" extracts with the bundled ffmpeg at full
  resolution, a new capture with the video's date (plus frame offset), location and species, linked in
  its metadata to the source video. Out: edits, crops, filters.
- **Files:** `Lightbox.tsx`, `apps/api/src/captures/` (frame route), `apps/api/src/uploads/`.
- **Depends on:** none.
- **Tests and acceptance:** integration test that the frame's pixel size equals the video's; e2e save.
- **UX checks:** F1, F3, W8.
- **Risks:** variable frame rate seeking; seek by timestamp and show the exact frame time.
- **Parallel with:** N-01 to N-05.

### N-07 Search upgrade: long compositional searches

**Status:** partial (2026-11-04): frames job measured at about 590 ms per photo on CPU (loaded machine); search-tokens e2e written, not run, no token screenshots

- **Model:** Opus 5.5. **Review:** Opus 5.5 (engine, models, data).
- **Goal:** answer searches like "predators stalking at blue hour with a tree in the background, making
  eye contact with the camera, uses the golden ratio, and is backlit" well, all on the user's machine. Each
  part is answered by the signal that can answer it; exact parts filter, best-effort parts rank and are
  shown as "probably".
- **Scope:** in:
  1. **Light, two signals.** (a) The sun: elevation from GPS and capture time, classified by elevation,
     never clock time, so high latitudes work (blue hour at 2 am counts). New classes beside golden hour,
     sunrise and sunset: blue hour (sun 4 to 6 degrees below the horizon), twilight (0 to 6 below) and
     night (more than 6 below, as today). The sun is trusted only with GPS, a time and a known time zone;
     `captures_all.taken_at_zoned` is recorded at import (false when the file had no zone), set true by the
     bulk date fix (the user set the time), null for photos imported before this package (treated as
     today). (b) The picture: cheap per-photo light stats (brightness, warm or cool cast, highlight and
     shadow shares, colourfulness) plus CLIP prompts against the existing whole-photo vector. Trusted sun
     that fits: exact. No sun or untrusted: the picture decides, shown as "probably". Clear disagreement
     (trusted sun well below the horizon but a plainly daylit, colourful photo) prefers the picture and
     flags the photo's time as possibly wrong (`timeMaybeWrong`), for the bulk date fix to suggest later.
     Dark photos in daylight (indoor, flash, deep shade, low key) never flag.
  2. **Group words:** "predators", "waterbirds", "wading birds", "herbivores" join the existing raptors,
     shorebirds, songbirds and carnivores, mapped to orders and families, conservatively and documented in
     `searchTaxonSynonyms.ts`.
  3. **Composition from the subject box.** The detector's best animal box (fractions of the upright
     photo) and the photo's aspect are stored per capture. Shared, deterministic maths reads them: subject
     size (tiny under 1.5%, small under 10%, medium, frame filling from 35% of the frame), rule of thirds
     (box centre within 0.07 of a thirds intersection), golden ratio (within 0.04 of a phi-grid
     intersection, lines at 0.382 and 0.618), centred, orientation, and the side with the most open space.
     Lead room needs the subject's facing, which nothing in Lifer knows, so it is out. Placement words
     need a sure box; a photo the detector could not find an animal in never matches them. Words: "rule of
     thirds", "golden ratio", "centred", "small in frame", "lots of space", "frame filling", "vertical",
     "horizontal".
  4. **Background vector.** The CLIP image encoder run on the photo with the subject box (padded) greyed
     out, stored per capture when the subject leaves at least 40% of the frame. "Tree in the background",
     "water behind", "against the sky" score against it; photos without one score the whole photo. Ranks,
     never filters, so always "probably".
  5. **Query splitting.** The parser returns the query's parts (group, light, composition, background,
     style and behaviour, place, date) with what each was read as and whether it is exact. Exact parts
     filter; fuzzy ones rank. Single words and every existing search behave as before (existing tests
     unchanged).
  6. **UI.** With two or more parts, the Gallery shows them as removable tokens (the house `ScopeChip`),
     best-effort ones labelled "probably". Removing a token removes its words from the query.
  7. **API.** Gallery items carry `frame` (box, composition, light reading, `timeMaybeWrong`); a device key
     gets `timeMaybeWrong` null for sensitive species. The phone gets `/companion/v1/model/frames` (paged
     like the photo vectors, background vector optional). Documented in the integrations docs.

  One background job, `search-frames-backfill`: only captures whose current photo has no frame row, or
  that need a background vector the CLIP model can now give. Resumable (each photo is stored as it is
  done), at background priority, stops when inference is stuck, chained after the animal-count backfill at
  startup, after a model download and after a library reimport. New imports get theirs in the commit-time
  vector job. Out: lead room, facing, golden spiral, horizon detection, re-reading EXIF of photos imported
  before this package.

- **Files:** `packages/shared/src/{sun,searchTerms,searchTaxonSynonyms,photoSearch,searchRank,photoFrame}.ts`,
  `packages/core/src/species/inferenceWorker.ts`, `apps/api/src/species/{frames,embeddingBackfill}.ts`,
  `apps/api/src/gallery/`, `apps/api/src/companion/searchModel.ts`, `apps/api/src/uploads/`,
  `apps/web/src/pages/gallery/`, migration 175.
- **Depends on:** none.
- **Tests and acceptance:** unit tests for sun classes (blue hour at the equator, mid and high latitudes,
  the southern hemisphere), light trust (no GPS, wrong camera clock, high-latitude summer night, an indoor
  flash shot), composition maths, parser splitting (the example query and variants), ranking (exact parts
  filter, fuzzy ones rank); integration tests on `lifer_test` for the job and the search route; web
  tests for the tokens; screenshots light and dark. Measure the job's time per photo.
- **UX checks:** C5, L1, T1, W8; extremes: a 30-word query, 12 tokens, very long place names.
- **Risks:** the detector knows ten animal kinds (insects and most reptiles get no box); thirds and phi
  grids sit 0.049 apart, so a photo between them can match both, which is correct.
- **Parallel with:** everything outside `apps/api/src/opendata` and `apps/mobile`.

### Track D: catalog pipeline and republish (starts in M1, publishes in M8)

Order follows `next-catalog-republish.md`. All stages are part of the one `refresh` command, resumable and
incremental. Nothing runs against the Docker `lifer` database without the maintainer's say-so, and
nothing is published without the maintainer's go-ahead. The escapes and exotics run is already applied
(backup `data/backups/lifer-db-before-refresh-2026-10-21T06-46-29-370Z.dump`).

### D-01 Pipeline safety before any republish

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** the republish can't ship stale data or lose the master database (audit N03, N04, N05, N18,
  N19, N20, N49).
- **Scope:** in: `pg_dump -Fc` snapshot at refresh start (streamed, waits for `close`, skipped on
  `--resume`); the gate checks every published stage has a `done` row newer than its inputs, or publish
  refuses unless `--accept-stale=` names them; build and verify the seed before uploading packs; print
  host and database at start and refuse `--publish` without an explicit `DATABASE_URL`; venv check in
  `doctor` and preflight; move the API's Natural Earth province fetch off the repo path (data in the seed
  or `DATA_DIR` through `lib/http.ts`); guards and retries for release-asset fetches; run-unique seed
  export schema. Out: data changes.
- **Files:** `packages/data-pipeline/src/scripts/refresh.ts`, `src/pipeline/gate.ts`, `scripts/backup.ts`,
  `src/pipeline/doctorChecks.ts`, `src/pipeline/catalogSeedExport.ts`, `packages/core/src/rawCache.ts`,
  `packages/core/src/regions/regionBoundary.ts`, `apps/api/src/regions/routes.ts`.
- **Depends on:** none.
- **Tests and acceptance:** unit tests for gate freshness and publish refusal; backup test with a large
  table; `--stages=packs,gate,publish` after a stale tiers stage refuses.
- **UX checks:** none.
- **Risks:** snapshot size and time; compress and keep the last three.
- **Parallel with:** S-01, P-01, P-03.

### D-02 Seasonality cleanup

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a before and after diff of suggestion order on fixtures.
- **Goal:** republish item 1 (#21): drop `region_species.seasonality` and derive months from
  `weekly_frequency`.
- **Scope:** in: one derive function in core; the suggestion seasonal boost, species page
  (`SeasonalityBar.tsx`) and pack building use it; pack readers stop needing the column; then the
  proposed migration drops it. Out: new seasonality data.
- **Files:** `packages/core/src/species/suggest.ts`, `packages/data-pipeline/src/build/build-region-pack.ts`,
  `apps/web/src/components/SeasonalityBar.tsx`, migration `<next>_drop_region_seasonality.sql`.
- **Depends on:** D-01. **Approval gate:** the migration, written only after no code reads the column.
- **Tests and acceptance:** unit tests for derived months (southern hemisphere, sparse weeks); suggestions
  unchanged where the old column agreed.
- **UX checks:** S5 (sparse data says so).
- **Risks:** installed packs carry the old column; readers ignore it.
- **Parallel with:** D-03 to D-05.

### D-03 Example cities, populous provinces and the regions index

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** republish items 2 to 5 (#21).
- **Scope:** in: a `places` stage from Natural Earth populated places: example city per region (capital,
  else largest place, else the country capital; territories use their own capital); most populous
  province per country; the `regions(parent_id, home_country_id)` index; API fields for the web
  placeholders. Proposed migration shared with D-04: `regions.example_city`,
  `regions.populous_child_id`, `regions.aliases`, and the index. Out: web placeholders (F-08).
- **Files:** `packages/data-pipeline/src/scripts/refresh.ts` (stage), `src/pipeline/places.ts` (new),
  region API responses, migration `<next>_region_places_and_aliases.sql`.
- **Depends on:** D-01. **Approval gate:** the migration.
- **Tests and acceptance:** spot checks (BC gives Vancouver or Victoria by the rule, Scotland gives
  Edinburgh); every country has a value or an explicit none.
- **UX checks:** none (F-08 shows them).
- **Risks:** vernacular group regions need a rule too: use the group's largest member's city.
- **Parallel with:** D-02, D-04, D-05.

### D-04 Countries within countries and aliases

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus check vernacular groupings are kept.
- **Goal:** republish item 5b (#65 data).
- **Scope:** in: one model for constituent countries, realms, SARs, territories, overseas regions and
  crown dependencies (reachable alone and under the sovereign, one naming rule, consistent downloads);
  fix duplicate rows (Aruba, Puerto Rico); alias lists (Britain, Holland, USA, Burma, Czech Republic,
  Türkiye and others) into `regions.aliases`. Out: app search (F-08).
- **Files:** `packages/data-pipeline/src/build/vernacular-regions-data.ts`, region stages,
  `packages/data-pipeline/data/reference/region-aliases.json` (new).
- **Depends on:** D-03 (shared migration).
- **Tests and acceptance:** no duplicate region names per parent; every alias resolves to one region.
- **UX checks:** none.
- **Risks:** pack downloads for territories that were rows under two parents; map old pack ids.
- **Parallel with:** D-02, D-05.

### D-05 Stale GBIF keys and missed escapees

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a before and after report per region.
- **Goal:** republish items 5c and 5d.
- **Scope:** in: re-resolve about 1.8% stale GBIF keys during name-drift matching (Catalogue of Life
  synonyms); a cross-region check for species with known captive origins and a handful of records
  outside native and established range, removed or flagged for review (the BC list in the checklist is
  the test set). Out: tier changes (D-08 reruns tiers).
- **Files:** catalog and regions stages in `packages/data-pipeline/src/`, `data/reference/` lists.
- **Depends on:** D-01.
- **Tests and acceptance:** the named BC escapees gone or flagged; "Pipra europaea" in the UK resolved.
- **UX checks:** U2 (badges correct or hidden).
- **Risks:** removing real vagrants; flag for review rather than delete when unsure.
- **Parallel with:** D-02 to D-04.

### D-06 Openly licensed gallery vectors with per-vector licence tags

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus the measurement table and the licence whitelist.
- **Goal:** republish item 5g.
- **Scope:** in: proposed migration adding `license`, `photographer`, `source_url` to the gallery embedding
  rows; a `open-vectors` mode of the vectors stage preferring CC0 and CC BY photos (iNaturalist research
  grade, Wikimedia Commons), quality filtered (minimum size, subject detected), up to 6 per species,
  keeping existing vectors only where a species has fewer than 3 open ones; incremental on species whose
  photos changed; measure top-1 and top-5 on confirmed GPS captures per group, current vs new; ship only
  if matching holds (open question 15). Out: the opendata endpoint (L-12).
- **Files:** `packages/data-pipeline/src/` vectors stage, `packages/core/src/species/licensePolicy.ts`,
  `galleryEmbeddingsFormat.ts`, migration `<next>_gallery_vector_licences.sql`,
  `docs/docs/contributing/decisions/` (a decision record).
- **Depends on:** D-01, P-03. **Approval gate:** the migration; the run itself on the maintainer's go-ahead.
- **Tests and acceptance:** measurement table per group in the decision record; every vector has a
  licence; gallery embeddings stay in the distribution.
- **UX checks:** none.
- **Risks:** long compute; resumable checkpoints, never rerun finished species.
- **Status 2026-10-26:** collection running: `npm run open-vectors -w data-pipeline` writes PRVE files
  and provenance to `packages/data-pipeline/data/open-vectors/` from iNaturalist Open Data (files only).
  Importing into the catalog waits for the republish go-ahead (D-08); GBIF gap fill comes later.
- **Parallel with:** D-07.

### D-07 Recovered GBIF records and eBird-only cross-check

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus a before and after species count per region.
- **Goal:** republish items 5e and 5f.
- **Scope:** in: match GBIF records on province or state name as well as land boundary, include
  nearshore waters for seabirds, keep `occurrenceStatus = present`; cross-check each region's eBird-only
  species against open lists (clean GBIF, open government lists, Wikipedia regional lists) and drop or
  mark unconfirmed those with no support and very few records; map taxonomy mismatches (Vega Gull,
  Black-backed Swamphen). The method is written up here in the pipeline docs. Out: tiers.
- **Files:** occurrences and regions stages, `SCRIPTS.md`, `data/reference/` lists.
- **Depends on:** D-05. **Decided 2026-10-25:** open regional checklists approved; the 165 GB GBIF
  re-download is approved and runs only inside the D-08 republish.
- **Tests and acceptance:** the named examples (Florida Scrub-Jay in Ontario, Ferruginous Hawk in the UK)
  dropped or unconfirmed; real vagrants recovered in a sample region.
- **UX checks:** U2.
- **Risks:** over-pruning; report every removal for the maintainer to skim.
- **Parallel with:** D-06.

### D-08 Republish

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus the gate output; the maintainer gives the go-ahead.
- **Goal:** republish items 6 to 9: one complete republish carrying everything.
- **Scope:** in: after the description rewrites land (maintainer-led), rerun the tiers stage
  (incremental where inputs changed), rebuild provinces for countries whose eBird codes were corrected,
  rebuild packs, maps (V-11) and the seed, run the gate, then stop and ask before publishing. Out: any
  other data change.
- **Files:** none new; the `refresh` command with parameters.
- **Depends on:** D-02 to D-07, V-11, description rewrites.
- **Contracts:** one command line, recorded in `SCRIPTS.md`, for example
  `npm run refresh -- --stages=tiers,packs,maps,gate --incremental` then a separate `--publish`.
- **Tests and acceptance:** gate passes; spot checks of anchor species tiers; the app on a fresh install
  fetches and verifies the new seed.
- **UX checks:** U2.
- **Risks:** compute time; never rerun finished countries.
- **Parallel with:** M9 packages.

### Track T: testing depth (#67, M9)

Extreme fixtures (Q-05), error injection on the API (Q-08) and performance budgets (Q-10) are built in M0.

### T-01 Dangling-reference audit

**Status:** done (2026-11-04): four new inventory rows, cover-in-trash and missing-trip-folder tests pass, check:remembered-state added to check:all

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** everything Lifer remembers is tested deleted, renamed, moved, unplugged or missing.
- **Scope:** in: an inventory of remembered references (last region, pinned filters, smart album rules
  naming a region or tag, album covers, trip folders, saved spots, watched folders, editor choice, plugin
  manifests, server links); a test per reference and state; fixes for anything that blanks or errors.
- **Files:** `docs/docs/contributing/remembered-state.md` (new inventory), tests beside each owner.
- **Depends on:** most M3 to M6 packages.
- **Tests and acceptance:** every inventory row has a passing test.
- **UX checks:** N6, S4, S9.
- **Risks:** inventory gaps; grep for every settings key and stored id.
- **Parallel with:** T-02 to T-04.

### T-02 Life-cycle journeys

**Status:** partial (2026-11-04): four journey specs written, not run; identify-undo is a known failure (Correct ID has no Undo); link-a-server journey not written

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** e2e journeys that do, undo and come back.
- **Scope:** in: import, identify, confirm, undo; make a smart album, pin a filter, delete the tag it uses;
  link a server, edit offline, reconnect; download a region, remove it, download again; trash and restore.
- **Files:** `e2e/tests/journeys/` (new).
- **Depends on:** the features each journey covers.
- **Tests and acceptance:** green on three systems.
- **UX checks:** F3, N1, N6.
- **Risks:** run time; split by journey.
- **Parallel with:** T-01, T-03, T-04.

### T-03 Monkey testing with invariants

**Status:** partial (2026-11-04): seeded monkey spec written, first run 97 clean steps then two false alarms fixed, fixed version not re-run; 150 steps per seed, plan wants 2,000 per CI run

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** random clicks, keys and navigation on the extreme seed never break invariants.
- **Scope:** in: a seeded random walker in Playwright; invariants checked after each step (sidebar
  present, no raw error text, counts agree, no horizontal overflow, no console errors); replay by seed.
- **Files:** `e2e/tests/monkey.spec.ts` (new).
- **Depends on:** Q-05, Q-08.
- **Tests and acceptance:** 2,000 steps per CI run with no failure; failures print the seed.
- **UX checks:** S1 to S3, S7, U1.
- **Risks:** destructive actions; run on a throwaway copy of the seed.
- **Parallel with:** T-01, T-02, T-04.

### T-04 Failing files and persona passes

**Status:** partial (2026-11-04): bad-files spec and on-the-fly fixtures written, not run; persona runbook written; no truncated RAW case

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** testing depth items 3 and 6 for files: unreadable, truncated, locked and vanishing files, and
  a repeatable persona pass before each release.
- **Scope:** in: fixtures for corrupt JPEG, truncated RAW, locked file on Windows, file removed mid-import;
  a written persona runbook (new user, Lightroom user, server owner, birder with 200,000 photos) for
  exploratory agent passes, with screenshots and findings filed as packages.
- **Files:** `e2e/fixtures/bad-files/` (new), `docs/docs/contributing/release-personas.md` (new).
- **Depends on:** V-04.
- **Tests and acceptance:** each bad file gives a plain message and the import continues.
- **UX checks:** S1, F2, F4.
- **Risks:** none notable.
- **Parallel with:** T-01 to T-03.

### Track R: release (M9)

### R-01 Archive health verification

**Status:** partial (2026-11-04): archive-health e2e written for four table rows, not run; manual checks per OS and a server still outstanding

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** confirm the built archive health check (migration 160) works on all three OSes and a server.
- **Scope:** in: manual and scripted checks: corrupt a file without changing its time, delete one, unplug
  a drive, rotate a file's time; the Settings row and list behave as `archive-health.md` says; Reveal
  wording per OS (P-01). Out: changes beyond fixes found.
- **Files:** `apps/api/src/originals/health.ts` tests, `ArchiveHealthPage.tsx`.
- **Depends on:** P-01.
- **Tests and acceptance:** each table row in `archive-health.md` reproduced on each OS.
- **UX checks:** W4, S9, F3.
- **Risks:** none notable.
- **Parallel with:** R-02 to R-05.

### R-02 New-user testing kit

**Status:** partial (2026-11-04): new-user-testing guide written; the five sessions themselves are the maintainer's

- **Model:** Haiku 5.5. **Review:** Opus 5.5.
- **Goal:** world-class phase 6: five first-time users, five tasks, recorded with permission.
- **Scope:** in: a task sheet, consent note, observer checklist and a findings template; the maintainer
  runs the sessions. Out: running them.
- **Files:** `docs/docs/contributing/new-user-testing.md` (new).
- **Depends on:** M4.
- **Tests and acceptance:** the maintainer can run a session from the doc alone.
- **UX checks:** none.
- **Risks:** none.
- **Parallel with:** R-01, R-03 to R-05.

### R-03 Docs and changelog

**Status:** partial (2026-11-04): filters-and-pins guide, 1.0 changelog lines under Unreleased; guides for review queue, Year in Review and Immich not written, Immich privacy lines not added

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** user docs for every 1.0 feature and a 1.0 changelog.
- **Scope:** in: guides for library-first setup, review queue, home, filters and pins, saved spots, maps,
  Lightroom import and plugin, eBird, Immich, MCP, Year in Review, portfolio, sound; privacy page lines for
  online tiles, Immich and iNaturalist; CHANGELOG 1.0.0 entry. No legacy-version notes.
- **Files:** `docs/docs/`, `CHANGELOG.md`.
- **Depends on:** all features.
- **Tests and acceptance:** docs build; `check:em-dashes`, `check:copy` pass.
- **UX checks:** W1, W3, W6.
- **Risks:** none.
- **Parallel with:** R-01, R-02, R-04, R-05.

### R-04 Release-blocking tech debt

**Status:** done (no recorded breadth check of capabilities/default.json)

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** fix the audit items that matter for a 1.0 install.
- **Scope:** in: seed checksum required and the legacy seed URL dropped (N28); logged catches on recovery
  writes (N15); import cycles (N27); the i18n literal-string allowlist burned down to non-user-facing
  files and the rule made an error (N26); capability breadth check (N47). Out: large refactors (N16, N38).
- **Files:** `apps/api/scripts/fetch-catalog-seed.js`, `apps/api/src/albums/routes.ts`,
  `apps/api/src/library/reimport.ts`, `apps/api/src/trips/import.ts`, `apps/web/eslint.config.mjs`,
  `apps/desktop/src-tauri/capabilities/default.json`.
- **Depends on:** none.
- **Tests and acceptance:** build fails without a checksum; lint rule is an error and passes.
- **UX checks:** none.
- **Risks:** i18n burn-down touches many files; targeted edits, coordinate with live sessions.
- **Parallel with:** R-01 to R-03, R-05.

### R-05 Mechanical cleanup

**Status:** done (2026-11-04): hand-typed calls typed except two generic helpers, legacy Docker tag removed

- **Model:** Haiku 5.5. **Review:** Opus 5.5.
- **Goal:** low-risk audit items (N37, N39, N43, N44).
- **Scope:** in: delete the unreferenced function and drop the needless exports listed in N37, one `asTagRecord()`
  helper, reasons on `exhaustive-deps` suppressions, typed route calls, legacy-version wording removed.
- **Files:** as listed in `TECH_DEBT_AUDIT.md`.
- **Depends on:** none.
- **Tests and acceptance:** `tsc`, tests and lint pass.
- **UX checks:** none.
- **Risks:** none.
- **Parallel with:** R-01 to R-04.

### R-06 Release candidate and signing

**Status:** partial (2026-11-04): Developer ID signing and notarisation wired to secrets, entitlements, release checklist; version not bumped to 1.0.0; maintainer must supply Apple secrets

- **Model:** Opus 5.5. **Review:** Opus 5.5, plus the maintainer's sign-off on each platform.
- **Goal:** a signed, notarised 1.0.0 on macOS, Windows and Linux, plus the Docker image.
- **Scope:** in: macOS Developer ID signing and notarisation, Windows signing (P-07), Linux packages
  (P-08); in-place updates on each; version 1.0.0; release checklist per platform (X6: clean quit, no
  stray processes, opens without warnings); Docker image runs zero-config. Out: TrueNAS catalogue
  submission (about a month after a stable 1.0.0, by the maintainer).
- **Files:** `.github/workflows/release.yml`, `docs/docs/contributing/releasing.md`, `docs/docs/code-signing.md`.
- **Depends on:** everything.
- **Tests and acceptance:** fresh install and update on each OS; Docker fresh start with no env.
- **UX checks:** X6, P7.
- **Risks:** signing accounts and certificates; see open question 16.
- **Parallel with:** none (last).

## Migrations

Each is a separate proposal. The worker drafts the SQL, stops, and the maintainer approves that file
before it is written. Numbers are taken from the next free one at approval time (161 is next today) and
agreed with any other live session. Every new user-owned table carries sync tracking from S-01's pattern.

| # | Package | Proposed file | What it does | When |
|---|---|---|---|---|
| 1 | S-01 | `sync_library_tracking` | `updated_at`, `pushed_at`, `remote_updated_at`, touch and tombstone triggers on albums, album membership and exclusions, trips, trip membership, tags, species corrections; widen `sync_tombstones.kind` | M1 |
| 2 | D-03, D-04 | `region_places_and_aliases` | `regions.example_city`, `regions.populous_child_id`, `regions.aliases`, index `regions(parent_id, home_country_id)` | M1 to M8 |
| 3 | U-11 | `similar_dismissals` | Pairs the user said are not similar, or kept | M2 |
| 4 | V-05 | `suggested_identifications` | Suggested vs confirmed state on photo identifications | M4 |
| 5 | V-14 | `saved_spots` | Saved spots with geoprivacy, with sync tracking | M4 |
| 6 | I-06 | `ebird_checklists` | Imported checklists and photo links | M5 |
| 7 | I-08 | `immich_link` | Immich asset ids per capture | M5 |
| 8 | D-06 | `gallery_vector_licences` | Licence, photographer, source URL per gallery vector | M8 (code in M5) |
| 9 | N-02 | `audio_captures` | `audio` kind on captures and originals | M6 |
| 10 | D-02 | `drop_region_seasonality` | Drops `region_species.seasonality` once nothing reads it | M8 |
| 11 | N-07 | `175_search_frames` | `capture_frames` (subject box, aspect, light stats per photo), `capture_background_embeddings`, `captures_all.taken_at_zoned` | M6 |

Conditional, only if the package finds it necessary (each still needs approval):

| Package | Why it might be needed |
|---|---|
| P-04 | Pack state `removing`, if pack state is a checked column |
| F-06 | A change-batch log for one-step undo of assistant changes (open question 6) |
| N-04 | A new share kind for the portfolio and life list, if the shares table restricts kinds |
| P-10 | Indexes the performance measurements call for |

Already built and not repeated: instance id (148), mirror origin (149), push tracking (150), tombstones
(152), smart albums (156), subject count (158), archive health (160), tips (147).

## Data and licence notes

- **iNaturalist** photos and data used by Lifer include CC BY-NC material. That is fine for Lifer as free,
  non-commercial software; keep photographer credits and licences shown, and keep `licensePolicy.ts` as
  the single gate.
- **Open vectors (D-06):** the licence filter is a whitelist (CC0, CC BY). Every vector carries licence,
  photographer and source URL. Gallery embeddings stay in the distribution whatever the outcome.
- **eBird:** checklists come from the user's own "My eBird Data" export; region codes and taxonomy follow
  eBird's terms with attribution. Lifer adds no in-app sighting feeds.
- **GBIF:** records keep their own licences (CC0, CC BY, CC BY-NC); credits in `docs/docs/credits.md`.
- **IUCN** status for the conservation tally: fine for free, non-commercial use, with attribution.
- **Natural Earth** (populated places, boundaries): public domain.
- **Map extracts (V-11):** OpenStreetMap data under ODbL; attribution on every map and in credits.
  Protomaps tools and basemap schema are open; check the chosen basemap style's licence.
- **Relief (V-03):** SRTM is public domain; Copernicus DEM needs its attribution line. Prefer SRTM if the
  quality is close.
- **Online tiles (V-12):** only a provider whose terms allow app use; OpenStreetMap's own tile servers do
  not. Sending the viewed area is stated plainly in the setting.
- **Fonts and illustrations (V-02):** fonts under the OFL, bundled in the app, never fetched at runtime;
  taxa illustrations are original work under the repo licence.
- **Lightroom plugin (I-05):** the plugin code is Lifer's own; check Adobe's Lightroom SDK terms for
  distributing a plugin built against it, and keep any SDK sample code out.
- **MCP (F-06):** the official MCP SDK is MIT licensed; check its dependency licences on add.
- **Privacy:** no telemetry, analytics or counters anywhere. `api_keys.last_used_at` stays the only usage
  record. Sensitive species locations are obscured in every outbound path (shares, exports, portfolio,
  online tiles, iNaturalist, API, MCP), all through `isSensitiveAt` (F-07).
- **Master data:** the Docker `lifer` database is the catalog master; snapshots before every refresh
  (D-01). The desktop app's embedded Postgres is a different database.

## Testing strategy

| Layer | What | Where | Gate |
|---|---|---|---|
| Lints | raw controls, design tokens, copy, em dashes, i18n, ESLint rules, migrations, API types | `scripts/check-*.mjs`, `eslint.config.mjs` | Every PR; baselines only shrink |
| Unit | pure logic in core, shared, web hooks and components, Rust modules | Vitest, `cargo test` | Every PR |
| Integration | API routes and jobs on `lifer_test`; sync with two databases; pipeline stages on fixtures | `*.integration.test.ts` | Every PR (API, core, pipeline) |
| E2E behaviour | Q-06 to Q-11 sweeps, journeys (T-02), first run, imports | Playwright on macOS, Windows, Linux | PR smoke subset; full on main |
| Performance | budgets from Q-10 on the extreme seed | Playwright with traces | Warn until P-10, then fail |
| Visual | Q-12 screenshots for review; existing pixel snapshots | `e2e/visual` | Attached to every UI package |
| Monkey | T-03 random walks with invariants | Playwright | Nightly and pre-release |
| Data | gate freshness and shape, before and after reports, anchor species | pipeline gate | Before any publish |
| Manual | per-OS checklists (P-05, P-07, P-08, R-01, R-06), persona passes, five new users | docs runbooks | Each milestone exit |

Rules for tests: never touch the Docker `lifer` database; seeds are deterministic; flaky tests are fixed
or quarantined with an owner package, never retried silently; every bug fixed in 1.0 gets a test at the
lowest layer that catches it.

## Open questions

1. **Default theme.** Decided: follow the system from first launch (rule T1); the old Light-by-default
   rule is retired.
2. **Sound recordings and "heard".** A new life list state, or derived from audio-only captures?
   Recommendation: derived, no new state; shown as "Heard" and counted on the life list with that label.
3. **Reading Lightroom catalogues.** Node's built-in `node:sqlite` (bundled Node 22.23, no new native
   dependency, still marked experimental) or `better-sqlite3`? Recommendation: `node:sqlite`, read-only,
   on a temp copy.
4. **eBird source.** eBird has no API for a user's own checklists. Recommendation: import the "My eBird
   Data" CSV and link each checklist by its id.
5. **Immich direction (decided 2026-10-25, see below).** Recommendation: Immich as a read-only source on servers, with optional species
   tags written back (off by default); never delete or edit anything else in Immich.
6. **MCP undo.** Group assistant changes with the existing per-action undo, or add a small change-batch
   log (a migration)? Recommendation: the change-batch log, so "undo the assistant's last change" always
   works.
7. **Online tile provider.** Which provider, and how is any key handled in a public repo with zero
   config? Recommendation: offline extracts first; pick a provider whose terms allow app use and that
   works without a per-user key, decided after reading the terms.
8. **Map size budgets.** Recommendation: relief only if it adds under 100 MB to the world map; country
   extracts off by default, size shown, split by province above 2 GB.
9. **Suggested identifications on the life list.** Recommendation: they count, marked "suggested", and
   Stats, Home and Year in Review show "including N suggested".
10. **Portfolio scope.** Recommendation: static export on desktop and server, share link on server only,
    exact locations never published.
11. **Pinned filters scope.** Recommendation: per account, synced, Gallery only for 1.0.
12. **Sync entity list.** Recommendation: albums, album membership and exclusions, trips, trip
    membership, tags, species corrections and saved spots; iNaturalist links stay on the server.
13. **Does 1.0 wait for the republish?** Recommendation: yes. Data quality is part of 1.0, so the release
    candidate ships with the republished catalog; pipeline packages land early so the wait is the
    description rewrites only.
14. **Home as the first page.** Recommendation: Home becomes Cmd-1 and the launch page, Collection
    Cmd-2; users can pick the launch page in Settings.
15. **Open vector tolerance.** Recommendation: ship D-06 only if top-5 drops by no more than one point in
    any taxa group, and top-1 does not drop overall.
16. **Signing.** macOS notarisation needs an Apple Developer account and Windows needs a code-signing
    certificate (or Azure Trusted Signing). Recommendation: buy both before M7 so P-07 and R-06 aren't
    blocked.
17. **Watched folders default.** Recommendation: folders picked at first run are watched by default, with
    the switch per folder.
18. **Lightroom plugin home.** Recommendation: in this repo under `integrations/lightroom-classic/`, AGPL,
    zipped as a release asset.

## Maintainer answers (2026-10-22)

- **Q2 (sound recordings):** no "heard" state in 1.0. Revisit only if users ask for it.
- **Q3:** yes, read Lightroom catalogues read-only with `node:sqlite`.
- **Q4:** yes, a small change log so MCP edits can be undone.
- **Q5:** pick the online tile provider after reading the providers' terms.
- **Q6:** yes, 1.0 waits for the catalogue republish.
- **Q7:** yes, buy Apple and Windows signing before M7.
- **Q1 (default theme):** Light (Lifer's beige) by default. Not offered during setup. Light, Dark and
  "Match system" live in Settings. The dark theme is warm (deep warm charcoal, cream text, sage
  accents), never generic black.

## Maintainer answers (2026-10-25)

- **Playwright:** approved as a dev-only dependency. This unblocks Q-06 to Q-11 and the T-* packages.
- **Immich (I-08, question 5):** decided. Reference originals in place by default, since Immich is already
  the user's archive and copying would double the space. Copying originals stays out unless a per-library
  copy choice is already in the I-08 scope (it is not, so none is added). The rest of question 5 stands.
- **D-07:** open regional checklists approved as cross-check sources. The 165 GB GBIF re-download is
  approved, to run only as part of the next catalogue republish (D-08), never on its own.
- **Page titles:** approved on all main pages (Albums, Trips, Stats, Gallery, Collection). See "Page
  titles" in `extreme-fixture-findings-2026-10-23.md` for what the pages already do.
