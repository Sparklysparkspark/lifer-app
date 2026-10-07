---
title: Code standards
description: The conventions reviewers look for in a Lifer pull request.
---

# Code standards

These are the conventions Lifer's code already follows. Matching them makes review quick. When in doubt, look at how nearby code does it.

## Before you start

- **Open an issue or a [discussion](https://github.com/Sparklysparkspark/lifer-app/discussions) before a large change**, so we can agree on the approach before you spend time on it. Small fixes can go straight to a pull request.
- **One pull request does one thing.** A bug fix, a feature, or a refactor, not all three. Smaller pull requests get reviewed sooner.
- Read [CONTRIBUTING.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/CONTRIBUTING.md), including its policy on AI tools: they're allowed, you say in the pull request how you used them, and you must understand, review and test every line you submit.

## TypeScript

- All TypeScript runs in strict mode. Avoid `any`; if a type really is unknown, use `unknown` and narrow it.
- Types the API and the web app both use go in `packages/shared` (`@lifer/shared`), not in a copy on each side.
- The API runs through `tsx` in development, and its production build (esbuild) strips types without checking them, so `npm run typecheck` is what catches type errors. Run it before you push.

## Formatting and linting

ESLint and Prettier are the source of truth for style. Don't argue with them in review, and don't hand-format.

```bash
npm run format   # rewrite files with Prettier
npm run lint     # ESLint
```

CI runs `npm run format:check` and `npm run lint` and fails on any difference.

## Where code goes

**API (`apps/api/src`):** one folder per feature (`albums`, `photos`, `species`, `trips` and so on), each with a `routes.ts` that registers its Fastify routes, plus the modules it needs. Helpers used by several features go in `src/lib/`. Maintainer scripts go in `src/scripts/`, never in a route.

**Web app (`apps/web/src`):** pages in `pages/`, shared components in `components/`, React hooks in `hooks/`, plain functions in `lib/`. Talk to the API through `api/client.ts`.

**Database changes:** a new migration file. See [Database migrations](./database-migrations.md).

See [Architecture](./architecture.md) for the bigger picture.

## Logging

Server code logs through the pino logger in `packages/core/src/lib/log.ts`, not `console`. Inside a route handler, use `request.log`, which carries the request id. Everywhere else, import `log`. Maintainer scripts in `src/scripts/` may use `console`.

Never log secrets, passwords, API keys or share tokens. The logger already hides share tokens in request URLs.

## Comments

Comments explain **why**, not what. The code already says what it does; a comment is for the reason behind it, the case it guards against, or the thing that would surprise the next reader. Delete comments that only repeat the code.

## User-facing text

- Plain and friendly. Write the way the [docs](../intro.md) read: short sentences, second person ("your photos"), no jargon where an everyday word works.
- Error messages say what happened and what to do next.
- **No em dashes anywhere**: in code, comments, UI text, docs or commit messages. Use a comma, colon, parentheses or a new sentence. `npm run check:em-dashes` fails on any.
- The interface is English only for now, but the translation groundwork is in place. Put new interface text in `apps/web/src/locales/en.json` and use `t()`, as [Translating Lifer](./translating.md) describes. Translations into other languages aren't being accepted yet; open a discussion if you'd like to work on them.

## Tests

Tests sit next to the code they test: `thing.ts` gets `thing.test.ts`, or `thing.integration.test.ts` if it needs a real database. Fix a bug with a test that would have caught it. See [Testing](./testing.md).

## Pull requests

- Titles use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:` or `perf:`, then a short summary. For example, `fix: keep the import queue when the server restarts`.
- Add a line under `[Unreleased]` in [CHANGELOG.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/CHANGELOG.md) for anything a user would notice, written for users.
- Update the docs in the same pull request when behavior changes.
- Make sure the [checks](./development.md#checks) pass.
