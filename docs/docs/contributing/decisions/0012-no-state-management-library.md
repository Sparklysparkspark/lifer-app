---
id: 0012-no-state-management-library
title: "ADR 0012: No state-management library"
description: The web app uses React state, context and a small fetch wrapper instead of a state-management or data-fetching library.
---

# ADR 0012: No state-management or data-fetching library in the web app

**Status:** Accepted, 2026-08-22 (the web app's first commit, `ad1cc1a`). No such library has ever been in `apps/web/package.json`.

## Context

The web app (React 19, react-router) talks to one API on the same origin. Most pages load data for one view, and a few long jobs (imports, pack downloads, catalog updates) are polled.

## Decision

Use React's own state and context, a small `fetch` wrapper (`apps/web/src/api/client.ts`, which also adds the `x-lifer-client` header every write needs), and custom hooks built on it (`useSettings`, `useJobPoll` and others in `apps/web/src/hooks/`). No Redux, Zustand, React Query, SWR or similar.

Pages mostly fetch server data and display it, with little client state shared between pages, so small hooks over a `fetch` wrapper are enough. A library would add a dependency and its concepts without much to manage. ([CONTRIBUTING.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/CONTRIBUTING.md) also asks for discussion before any new dependency.)

## Alternatives considered

None recorded.

## Consequences

Positive:

- Fewer dependencies and a smaller bundle; data flow is plain React that any contributor can read.

Negative:

- **Caching and invalidation are hand-written** wherever they're needed: `useSettings` keeps "One cached GET /settings for the whole app" and has to guard against a request in flight across a sign-out repopulating it; collection data, the region map and the command palette keep their own caches.
- No shared conventions for loading states, retries or deduplicating requests, so each hook solves them separately.
- Context providers have accumulated (auth, toasts, confirmations, theme, command palette) and would be the first thing to revisit if shared state grows.
- **The identified next step is TanStack Query.** It isn't a rejected option: it becomes worth adopting if caching, request deduplication or background refetching across pages turns into a source of bugs.
