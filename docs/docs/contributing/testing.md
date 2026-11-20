---
title: Testing
description: How Lifer's unit, integration and end-to-end tests are organized, and how to run them.
---

# Testing

Lifer uses [Vitest](https://vitest.dev/) in every workspace that has tests: `packages/core`, `apps/api`, `apps/web` and `packages/data-pipeline`. The desktop app's Rust code has its own tests (see [Desktop app (Rust)](#desktop-rust)).

## Unit tests

```bash
npm test             # every workspace
npm test -w api      # just one workspace
npx vitest run src/lib/safeFs.test.ts   # one file, from inside the workspace
```

Unit tests are files named `*.test.ts`, next to the code they test. They don't need a database or network, and should run in seconds.

## Integration tests

Tests that need a real Postgres are named `*.integration.test.ts`. They're skipped unless `TEST_DATABASE_URL` points at a database.

:::danger Use a scratch database
Integration tests write to the database, and some clear tables. Never point `TEST_DATABASE_URL` at a database you use.
:::

With the [development Postgres](./development.md#run-it-locally) running, create a scratch database once and migrate it:

```bash
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml exec postgres createdb -U lifer lifer_test
DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npm run migrate
```

Then run them:

```bash
TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npm run test:integration
```

When `TEST_DATABASE_URL` is set, the API's tests run one file at a time, so they don't trip over each other in the shared database.

CI runs the integration tests against a fresh Postgres on every pull request.

## End-to-end tests

The browser tests in `e2e/` drive the real app in Chromium with [Playwright](https://playwright.dev/): creating the account on a new server, onboarding, the main pages, importing a photo, a setting, and signing in and out. They run against the production build (the API serving the built web app), the way Lifer ships.

```bash
npx playwright install chromium   # once
npm run test:e2e                  # builds the web app and API, then runs the tests
npx playwright show-report        # the HTML report of the last run
```

You need Docker. Each run starts a throwaway Postgres container (`lifer-e2e-postgres` on port 55450) and removes it at the end. To use a database of your own instead, set `E2E_DATABASE_URL`. The tests wipe it, so its name must contain `e2e`.

A run is offline. The database gets a small fixture catalog (`e2e/support/fixtureCatalog.ts`) instead of the downloaded one, and a local mirror (`e2e/support/mirror.ts`) serves the region packs onboarding downloads. Any other request the server makes to the internet is refused and logged in `test-results/e2e-server.log`, along with the server's own log.

The tests share one server and one database, so they run one at a time, in order. `first-run.spec.ts` creates the account and saves the signed-in session, which the other specs reuse. Every test fails on an uncaught page error, a `console.error` or an error toast (`e2e/support/test.ts`).

CI runs them on every pull request. When they fail there, the run's Artifacts include the HTML report, with a trace of the retried test.

## Visual tour and behavioural checks {#visual}

The specs above use a handful of species, so bugs that need a big library (a map framing the wrong place, cards loading late while scrolling thousands of species, two cards sharing one photo) slip past them. The visual suite in `e2e/visual/` runs the same production build against a realistic library, in Chromium and in WebKit (the engine of the desktop app's macOS web view).

```bash
npx playwright install chromium webkit   # once
npm run e2e:visual          # builds, then runs the tour and the behavioural checks
npm run e2e:visual:update   # the same, but saves new screenshots as the baselines
```

A run takes about 4 minutes after the build. It needs Docker, like the other e2e tests.

### The fixture library

`e2e/support/realisticCatalog.ts` builds it from a seeded random generator, so every run gets the same library:

- World > North America (Canada with British Columbia, Alberta and Ontario; Belize and Costa Rica, which the pickers show under Central America) and Africa (Kenya), each with a rough outline in the right place, so each map frames somewhere different.
- About 3,250 made-up birds, mammals and reptiles, each with its own reference picture (a colour and a row of bars that encodes its number), spread over the countries' checklists with mixed rarity tiers.
- Two imported trips (about 500 photos in six aspect ratios), card crops, hidden photos, seen and target marks, species hidden from a checklist, and an album.

The packs, pictures and photos are generated once and cached in `node_modules/.cache/lifer-e2e/`, keyed by the fixture's source, so a change to the fixture rebuilds them. The database is new on every run: `e2e/visual/seed.setup.ts` makes the account, downloads the packs and imports the trips through the API, which takes under a minute.

### The tour

`tour.visual.spec.ts` compares each screen with a checked-in screenshot in `e2e/visual/__screenshots__/`, one folder per browser and platform:

- Collection for World, North America, Canada, British Columbia and Costa Rica, at window widths 1280 and 2560, with the smallest and the default card size.
- A species page header, the Gallery and a Gallery search by name, Regions, Albums, Settings and Import.

Each step waits for the network to go quiet, images in view to load and the region map to settle. Text that changes between runs (temporary folder paths, "today" and "ago") is masked. Every step also fails on a console error, an uncaught page error, an error toast or a failed request.

Some steps are marked `fixme` while a known bug makes their screenshot differ from run to run; the comment on the `test.fixme` line names the behavioural check that covers the bug. Remove the `fixme` once that check passes.

### The behavioural checks

`behaviour.spec.ts` asserts the behaviour directly, without screenshots:

- Moving North America > Canada > North America keeps the same map canvas mounted, never leaves a frame without the map, and ends with the camera framing the new region.
- North America's outline includes Belize and Costa Rica as well as Canada.
- Fast-scrolling World at the smallest card size in a 2560px window never leaves a card without its picture for more than two frames, or a band of the grid empty.
- A card's dot menu opened near the bottom of the window keeps the same position over 10 frames and fits in the window.
- No two species cards in Costa Rica show the same picture.
- A continent lists its species in field-guide order, like its countries.
- Card names at the smallest size fit in two lines.

The region map exposes `data-testid="region-map"`, `data-outline-polygons`, `data-outline-bounds` and, once the camera settles, `data-view-bounds` for these checks.

### Reading a diff and approving baselines

When a screenshot differs, the HTML report (`npx playwright show-report playwright-report/visual`) shows the expected, the actual and a diff image with the changed pixels in red, with a slider to compare them. The same three files are in `test-results/visual/`.

- If the change is a bug, fix it; the step passes again once the screen looks like the baseline.
- If the change is intended (a new design, a reworded label), run `npm run e2e:visual:update`, look at the new images in `git diff`, and commit them with the change that caused them.

Baselines are per browser and platform, and are made on macOS. Fonts and rendering differ on Linux, so CI runs only the behavioural checks (the `e2e-behaviour` job, with `E2E_BEHAVIOUR_ONLY=1`); run the tour locally before a pull request that changes how a screen looks.

### When to add a step

Add a tour step for a new screen, or a new state of one that people see often. Add a behavioural check when a bug was about behaviour over time rather than how a still frame looks (something blinking, jumping, loading late or remounting): sample it with `requestAnimationFrame` in the page and assert on the numbers. If the fixture can't show the case, extend the fixture rather than the test.

## Desktop app (Rust) {#desktop-rust}

The desktop shell's tests sit next to its code in `apps/desktop/src-tauri/src`, in `#[cfg(test)]` modules. Run them from `apps/desktop/src-tauri`:

```bash
cargo test --lib
```

They need no database or network. Tests marked `#[ignore]` need a real Postgres and are run by scripts that set one up and remove it afterwards:

- `tests/pg-upgrade-test.sh <old-pg-dir> <new-pg-dir>`: the embedded database's upgrade to a new PostgreSQL major. See [Desktop app](./desktop-app.md#pg-upgrade).

CI runs `cargo test --lib` on every pull request. The upgrade test runs before every release and on pull requests that touch the upgrade or the bundled PostgreSQL.

## Coverage

```bash
npm run test:coverage            # core, API and pipeline, then a summary table
npm run test:coverage -w api     # just one workspace
```

Each workspace writes its report with `@vitest/coverage-v8` to its own `coverage/` folder: open `coverage/index.html` for the line-by-line view. Set `TEST_DATABASE_URL` (see [Integration tests](#integration-tests)) to include the integration tests, as CI does; without it they're skipped and their code counts as uncovered.

CI runs this in the test job, prints the table in the run's summary and keeps the HTML reports as the `coverage` artifact. No minimum is enforced yet.

Coverage says which lines ran, not whether a test would notice them breaking. That's what mutation testing is for.

## Mutation testing

Mutation testing checks the tests themselves. [StrykerJS](https://stryker-mutator.io/) makes many small changes to the code, one at a time (a `<` becomes `<=`, a condition becomes `true`, a string becomes empty, a line disappears), and runs the tests that cover that line against each one. Each change is a _mutant_. A test that fails **kills** it. A mutant that every test passes with has **survived**: the code could break that way and nothing would notice. The **mutation score** is the share of mutants killed.

It runs on a chosen list of modules where a weak test would hurt most: path and permission checks, license decisions, storage moves, migrations, species merges, uploads. Each workspace lists them in `stryker.config.mjs` (unit-tested modules) and `stryker.integration.config.mjs` (modules only a real database can test). Both build on `stryker.shared.mjs` at the root.

```bash
# Unit-tested modules only; no database needed. Takes a few minutes.
npm run test:mutation -- --unit

# Everything, including the integration-backed modules, against a scratch database.
TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npm run test:mutation

# One workspace: core, api or data-pipeline.
npm run test:mutation -- core
```

:::danger Use a scratch database here too
The integration-backed runs use `TEST_DATABASE_URL` exactly like the integration tests, one mutant at a time, and clear rows as they go.
:::

At the end it prints the score per file. The full report for each run is in `reports/mutation/` (for example `reports/mutation/core.html`): open it, pick a file, and every surviving mutant is marked on its line with the change Stryker made. A GitHub workflow (`mutation.yml`) runs it weekly and whenever it's started by hand, with the reports as the `mutation-report` artifact.

### Reading a survivor

For each surviving mutant, ask what it tells you:

- **A missing test.** Nothing checks that behavior. Write the test that fails with the mutant and passes without it. Most survivors in error handling are this: the failure path never runs.
- **A weak test.** A test runs the line but its assertion can't see the difference. Tighten the assertion. Common ones:
  - `toEqual` treats `{ migration: undefined }` and `{}` as the same; use `toStrictEqual` when the key matters.
  - `await expect(p).rejects.toThrow("message")` also passes when `p` rejects with `null`. Check the error itself: catch it, assert it's an `Error`, then check its message.
  - A mock that answers whatever the query is. Test the query against a real database instead.
  - A regex loose enough to match two different messages.
- **A real bug.** The mutant behaves better than the code. Fix the code, with a test that fails before the fix.
- **An equivalent mutant.** The change can't alter anything a caller could observe, for example an empty `catch` that returns `undefined` where it returned `false`, when the caller only checks for a falsy value. No test can kill these.

Write the test the way you'd write any other: through the module's public functions, about behavior a user or caller depends on. A test that exists only to kill a mutant, asserting a log message word for word or the exact SQL text, is worse than a surviving mutant.

### Marking an equivalent mutant

Only a truly equivalent mutant may be marked, with a comment on the line before it that names the mutator and says why:

```ts
// Stryker disable next-line ArrayDeclaration: equivalent, every index is filled before it returns
const results = new Array<R>(items.length);
```

The comment has to be the line directly above the statement it applies to. Stryker doesn't see it above an `else` or a `} catch {`, so a mutant there stays in the report. It switches off every mutant of that kind on that line, so don't use it on a line where another mutant of the same kind is a real one. Never mark a mutant to raise the score because writing the test is hard; leave it surviving, and the report keeps it visible.

## Writing tests

- Put the test next to the code: `uploads/routes.ts` and `uploads/routes.test.ts`.
- Fix a bug with a test that fails without the fix.
- Test behavior through a module's public functions rather than its internals, so refactors don't break tests for no reason.
- Keep unit tests independent of the network and the clock. Pass in what varies, or mock it with Vitest.
- An integration test shouldn't depend on rows another test left behind. Create what it needs, and clean up after it.
