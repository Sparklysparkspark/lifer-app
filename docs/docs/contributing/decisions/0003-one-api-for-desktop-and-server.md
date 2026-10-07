---
id: 0003-one-api-for-desktop-and-server
title: "ADR 0003: One API and web app for desktop and server"
description: The desktop app and the server run the same API and web app; only configuration differs.
---

# ADR 0003: One API and web app for desktop and server

**Status:** Accepted, 2026-08-22 (present in the first API commit, `9c2ca46`).

## Context

Lifer serves two kinds of user: someone who wants an app on their computer, and someone who runs a home server reached from several devices. Maintaining two applications would double the work for a project with one maintainer.

## Decision

Build one API (`apps/api`) and one web app (`apps/web`) and run them in both places. The desktop app starts the API with `SINGLE_USER_MODE=1`, which signs in as one automatic local user every request that carries the desktop app's per-launch credential (`apps/api/src/auth/session.ts`, `localCredential.ts`) and binds to `127.0.0.1` only (`apps/api/src/index.ts`). A server runs the same code with a real account, sessions and API keys. The few differences are switches on that flag: desktop-only routes such as migration to a server (`desktopOnly` in `apps/api/src/settings/requireDesktopMode.ts`), the path allowlist ([Security model](../../security-model.md#file-access)), response compression, and trusting proxies.

The first commit's config gave the reason for no login on the desktop: a single person on their own laptop with the server bound to localhost, where "a login screen there is pure friction with no real security benefit", while "Sessions/first-run setup stay fully intact for the self-hosted server/NAS deployment". The API refuses to start in this mode unless the desktop app launched it (`desktopModeStartupError` in `packages/core/src/config.ts`): "This stops SINGLE_USER_MODE=1 being set on a server by mistake."

## Alternatives considered

None recorded. This was the design from the first commit.

## Consequences

Positive:

- Every feature, fix and test applies to both deployments.
- The desktop app can point its window at a server, and a desktop library can be uploaded to one, because both speak the same API.

Negative:

- **The desktop API has no authentication.** Anything on the computer that can reach `127.0.0.1:4310` acts as the user. Host header and cross-site checks limit browsers, not local programs. See [Security model](../../security-model.md#desktop-app).
- Mode differences are scattered `SINGLE_USER_MODE` checks rather than one boundary, so a new feature has to consider both modes (`17e955c`, "Bring self-hosted mode up to par with desktop", fixed several that hadn't).
- Server features that make no sense on the desktop (share links, API keys, accounts) and desktop features that make no sense on a server (revealing files in Finder, migration) both ship in the same web app and are hidden by mode.
- The server design is shaped by the desktop: for example one account per server, and multi-user tables that aren't exercised.
