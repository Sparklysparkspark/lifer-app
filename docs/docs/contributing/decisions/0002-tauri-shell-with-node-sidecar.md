---
id: 0002-tauri-shell-with-node-sidecar
title: "ADR 0002: Tauri shell with a Node API sidecar"
description: The desktop app is a Tauri 2 window that runs the unchanged Node API as a separate process.
---

# ADR 0002: A Tauri shell running the Node API as a sidecar

**Status:** Accepted, 2026-08-27 (`930d43e`, "Finalize Electron-to-Tauri desktop migration").

## Context

The desktop app first shipped on Electron (`7e713f3`, 2026-08-22), which ran the API by reusing its own binary as Node (`ELECTRON_RUN_AS_NODE`). The API is a plain Fastify server configured by environment variables ([ADR 0003](./0003-one-api-for-desktop-and-server.md)).

## Decision

Use a Tauri 2 window (`apps/desktop/src-tauri`) as the shell, and run the API as a separate process on a bundled, checksum-verified Node runtime (`apps/desktop/src-tauri/src/api.rs`, `apps/desktop/scripts/fetch-node-sidecar.js`). The Rust side does only what the API can't: the window and menus, the embedded database ([ADR 0001](./0001-postgresql-everywhere.md)), starting, watching and restarting the API, server mode, and local inference when connected to a server.

The rationale is in the commit that added Tauri (`1a4335d`, 2026-08-23): a release bundle "builds successfully at 297MB (vs Electron's 397MB) with dramatically lower idle RAM since WebKit is already OS-resident rather than a bundled Chromium", and it was "Validated end-to-end against the real, unmodified apps/api and apps/web". The sidecar header at the time noted the API "needs ZERO changes for this migration ... only how it's launched changes".

## Alternatives considered

- **Electron:** shipped first, then replaced, for bundle size and memory (above). The migration ran both side by side (`apps/desktop-tauri`) before removing Electron.
- **A Rust backend:** not recorded as considered for the API. It would mean a second implementation of every route. (Species matching on the Rust side is a separate question; see [ADR 0008](./0008-in-process-onnx-inference.md).)

## Consequences

Positive:

- One API codebase for desktop and server, unchanged by the shell.
- A smaller app and lower idle memory than Electron, using the OS web view.
- The Rust side stays small and focused on OS integration.

Negative:

- **Three runtimes to ship:** Rust, a vendored Node per platform and architecture, and the system web view. Native Node modules (sharp, argon2, onnxruntime) must be fetched for the target, which needs `retarget-natives.js` and a bundle check (`check-bundled-natives.js`) for cross-builds ([Desktop app](../desktop-app.md)).
- **Different web engines per platform** (WebKit on macOS and Linux, WebView2 on Windows), so the web app is tested against more than Chromium.
- **Process supervision:** the shell must detect a stale API from an earlier launch (the per-launch id in `api.rs` and `local_credential.rs`, which `/health` echoes), restart a crashed one a limited number of times, and stop it when the app quits (`apps/api/src/lib/parentWatchdog.ts`).
- **Tauri's permission model** needs care: app commands are denied unless granted, and access for a connected server's pages is granted at runtime (`grant_remote_capabilities` in `lib.rs`). See [Security model](../../security-model.md#when-the-desktop-app-is-connected-to-a-server).
- Tauri's resource bundler drops symlinks, so workspace packages are copied into the bundle (`prepare-resources.js`).
