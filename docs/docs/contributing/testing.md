---
title: Testing
description: How Lifer's unit, integration and end-to-end tests are organized, and how to run them.
---

# Testing

Lifer uses [Vitest](https://vitest.dev/) in every workspace that has tests: `packages/core`, `apps/api`, `apps/web` and `packages/data-pipeline`.

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

## Coverage

```bash
npm run test:coverage            # core, API and pipeline, then a summary table
npm run test:coverage -w api     # just one workspace
```

Each workspace writes its report with `@vitest/coverage-v8` to its own `coverage/` folder: open `coverage/index.html` for the line-by-line view. Set `TEST_DATABASE_URL` (see [Integration tests](#integration-tests)) to include the integration tests, as CI does; without it they're skipped and their code counts as uncovered.

CI runs this in the test job, prints the table in the run's summary and keeps the HTML reports as the `coverage` artifact. No minimum is enforced yet.

Coverage says which lines ran, not whether a test would notice them breaking. That's what mutation testing is for.

## Mutation testing

Mutation testing checks the tests themselves. [StrykerJS](https://stryker-mutator.io/) makes many small changes to the code, one at a time (a `<` becomes `<=`, a condition becomes `true`, a string becomes empty, a line disappears), and runs the tests that cover that line against each one. Each change is a *mutant*. A test that fails **kills** it. A mutant that every test passes with has **survived**: the code could break that way and nothing would notice. The **mutation score** is the share of mutants killed.

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
