# Contributing to Lifer

Thanks for helping. Lifer is a small project with one maintainer, so a little coordination up
front saves everyone time. This page covers how contributions work. The
[contributor docs](https://sparklysparkspark.github.io/lifer-app/contributing/development) cover
setup, architecture and how things are built.

By taking part you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/Sparklysparkspark/lifer-app/issues/new/choose).
  Include your version, install type and logs.
- **Suggest a feature or ask a question** in
  [Discussions](https://github.com/Sparklysparkspark/lifer-app/discussions). Issues are for
  confirmed bugs and agreed work.
- **Improve the docs.** Every docs page has an "Edit this page" link.
- **Fix something.** Issues labeled
  [`good first issue`](https://github.com/Sparklysparkspark/lifer-app/labels/good%20first%20issue)
  are a good place to start.
- **Report a security problem** privately, as described in [SECURITY.md](./SECURITY.md). Never in
  a public issue.

## Before you start coding

- **Small fixes** (typos, an obvious bug, a docs correction): open a pull request directly.
- **Anything bigger** (a new feature, a schema change, a new dependency, a change to how data is
  stored or imported): open an issue or discussion first and wait for a go-ahead. A PR that
  arrives without one may be closed, however good it is, if it doesn't fit where Lifer is going.
- Comment on an issue before you work on it, so two people don't do the same work.

## Development setup

The short version, with Node 22 (see `.nvmrc`) and Docker:

```bash
npm install
docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml up -d postgres
npm run migrate
npm run dev -w api   # http://localhost:4000, loads the species catalog on first start
npm run dev -w web   # http://localhost:5173
```

The [development setup guide](https://sparklysparkspark.github.io/lifer-app/contributing/development)
has the details, the desktop app and the data pipeline. Read the
[architecture overview](https://sparklysparkspark.github.io/lifer-app/contributing/architecture)
before larger changes.

## Pull requests

- **One PR does one thing.** A bug fix and an unrelated refactor are two PRs.
- **Title it with [Conventional Commits](https://www.conventionalcommits.org/)**, since the title
  becomes the squashed commit message: `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`,
  `test: ...`, `ci: ...`, `build: ...`, `perf: ...` or `chore: ...`. For example,
  `fix: keep RAW pairing when a file has no extension`.
- **Fill in the PR template**, including how you tested and the AI disclosure.
- **Add a line under `[Unreleased]` in [CHANGELOG.md](./CHANGELOG.md)** for anything a user would
  notice, written for users, not developers.
- **Keep CI green.** It runs the same checks as below, plus a Docker build and the desktop app's
  Rust checks.
- PRs are squash-merged after the maintainer's review. Expect review comments: they're about the
  code, never about you. The [review process](https://sparklysparkspark.github.io/lifer-app/contributing/review-process)
  explains how review works and how to give and answer feedback; anyone is welcome to review.

## Checks to run before pushing

```bash
npm run lint           # ESLint
npm run format         # Prettier (format:check is what CI runs)
npm run typecheck      # TypeScript, every workspace
npm test               # unit tests, every workspace
npm run test:integration   # needs TEST_DATABASE_URL, see the testing guide
```

`npm run check:em-dashes` and `npm run check:migrations` run in CI too. The
[testing guide](https://sparklysparkspark.github.io/lifer-app/contributing/testing) explains
integration tests and the scratch database they need.

## Code standards

The [code standards page](https://sparklysparkspark.github.io/lifer-app/contributing/code-standards)
has the details. The essentials:

- TypeScript in strict mode. ESLint and Prettier decide style, so there's nothing to argue about.
- Server code logs through `packages/core/src/lib/log.ts`, not `console`.
- Comments explain *why*, not what the next line does.
- New behavior comes with tests, next to the code as `*.test.ts` or `*.integration.test.ts`.
- Database changes are new migrations, never edits to old ones. See
  [database migrations](https://sparklysparkspark.github.io/lifer-app/contributing/database-migrations).
- User-facing text is plain and friendly. No em dashes anywhere (CI checks): use a comma, colon,
  period or parentheses.
- The UI is English-only for now. The translation groundwork (i18next, `apps/web/src/locales/en.json`) is in place but only part of the web app uses it; new interface text should go into `en.json`. Translations into other languages aren't being accepted yet (see [Translating Lifer](https://sparklysparkspark.github.io/lifer-app/contributing/translating)).

## Use of AI tools

AI coding tools are welcome; Lifer itself is built with their help. The
[AI usage policy](https://sparklysparkspark.github.io/lifer-app/contributing/ai-policy) sets out
how, stage by stage. The short version:

- **You are the author.** You must be able to explain what your change does, why it's done this
  way, how it fails and what it touches, without the tool. "The AI wrote it" is never an answer.
- **Break your tests on purpose** to prove they catch something, and **run Lifer with your change**
  before opening a PR.
- **Write the PR description and review comments yourself,** and say in the PR how you used AI.
- **Never give an AI tool secrets, other people's data, or sensitive species locations.**

## License

Lifer is licensed under the [GNU AGPL v3](./LICENSE). By submitting a contribution you agree that
it's licensed under the same terms. Third-party code, models and data must have a compatible
license and be added to [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
