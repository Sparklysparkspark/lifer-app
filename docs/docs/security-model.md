---
title: Security model
description: What Lifer protects, against whom, in each way you can run it, and what it leaves to you. Covers sign-in, the desktop app's local API, file access, uploads, outbound requests, stored secrets and release integrity.
---

# Security model

This page describes what Lifer defends against and what it doesn't, for each way you can run it. It's written for people deciding whether to run Lifer, and for reviewers. Every statement here is checked against the code, and file paths are given so you can check them too. To report a problem, follow [SECURITY.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/SECURITY.md); please don't open a public issue.

Lifer is a personal application: one person's photo library, on their own computer or server. A Lifer server has exactly one account (`apps/api/src/auth/routes.ts`, `/auth/register` refuses once any user exists). There are no roles, no admin and member split, and no multi-tenant isolation to get wrong, but also no defence against the account holder.

## At a glance

| | Desktop app | Home server on a LAN | Internet, behind a reverse proxy |
|---|---|---|---|
| Who can reach the API | Programs on the same computer | Devices on your network | Anyone |
| Sign-in | None to type: the app's own window holds a per-launch secret | Email and password, session cookie | Email and password over HTTPS |
| Main risk | Software running as your own user | Other devices on the network, plain HTTP | Password guessing, unknown bugs |
| What you should do | Treat your OS account as the boundary | Create the account at once; consider HTTPS | HTTPS proxy, `TRUST_PROXY`, strong password, update promptly |

## Desktop app

The desktop app runs the same API as a server, as a child process of the app, with `SINGLE_USER_MODE=1` (`apps/desktop/src-tauri/src/api.rs`). In that mode:

- **No password, but a credential.** The API signs in the local user (`local@lifer.app`) only for requests that carry the desktop app's per-launch secret, `LIFER_LAUNCH_TOKEN`, or the cookie the app's window gets for it (`hasLocalCredential` in `apps/api/src/auth/localCredential.ts`, used by `getSessionUser` in `session.ts`). See [The launch token](#launch-token).
- **Everything but the public routes needs it.** A gate in front of every `/api` route answers `401` without the credential, except the [public routes](#public-routes) (`apps/api/src/auth/desktopGate.ts`, `PUBLIC_API_ROUTES` in `publicRoutes.ts`). The sign-in hooks check it again, so a route registered without a hook is still covered by the gate, and the reverse.
- **It listens on `127.0.0.1:4310` only** (`apps/api/src/index.ts`, `app.listen`), so it isn't reachable from the network.
- **Host headers must be loopback.** A request whose `Host` isn't `127.0.0.1:4310`, `localhost:4310` or `[::1]:4310` gets `403 Forbidden host` (`apps/api/src/auth/hostCheck.ts`, checked by `desktopGate.ts`). This stops DNS rebinding: a web page on a domain that resolves to 127.0.0.1 still sends its own domain as the Host.
- **Relayed requests are refused.** Any `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `Forwarded` header gets a 403 (`hasForwardedHeaders` in `packages/core/src/lib/requestGuard.ts`), since nothing legitimate proxies to the desktop API.
- **Browser pages on other sites can't change anything.** See [Cross-site requests](#csrf); the same guard runs in every mode.
- **It refuses to run this way on a server.** The API exits at startup if `SINGLE_USER_MODE=1` is set without `LIFER_LAUNCH_TOKEN` (`desktopModeStartupError` in `packages/core/src/config.ts`), so the no-login mode can't be switched on by mistake in a container.

### The launch token {#launch-token}

The desktop app makes two random values at each launch (`apps/desktop/src-tauri/src/local_credential.rs`) and passes both to the API in its environment:

- `LIFER_LAUNCH_TOKEN`, 32 bytes from the OS random number generator, is the **credential**. It never leaves the app and the API process. The app's window gets it through a Tauri command, `local_api_credential`, which answers only a page loaded from the local API's own origin (`http://127.0.0.1:4310`); a connected server's pages, which can call the app's commands too, get nothing (`apps/desktop/src-tauri/src/lib.rs`). The window then sends it once, in an `x-lifer-launch-token` header, to `POST /api/auth/desktop-session` (`apps/web/src/lib/localApiSession.ts`) and drops it.
- That request sets the `lifer_desktop` cookie: an HMAC of the secret, not the secret itself, `HttpOnly` so page scripts can't read it, `SameSite=Strict` so a page on another site doesn't make the browser send it, and with no expiry, so it's kept in the web view's memory rather than written to disk and is gone when the app quits. A cookie rather than a header on each request, because photos load through `<img>` and `<video>` elements, which can't add headers. A new launch has a new secret, so an old cookie is worthless.
- `LIFER_LAUNCH_ID`, 16 random bytes, is **not secret**. `GET /health` returns it as `launchId`, so the app can tell its own API process apart from a stale one left on port 4310 (`LocalApi::Ours` in `api.rs`). `/health` never returns the token (`apps/api/src/lib/health.ts`).

Opening the local library at `http://127.0.0.1:4310` in a regular browser shows the sign-in page, which can't sign in: only the app's window has the credential. For development without the desktop shell, `LIFER_ALLOW_UNTOKENED_DESKTOP=1` runs desktop mode with no credential at all; it's never set by the app.

### Other software on the same computer

Other programs on the computer can still connect to `127.0.0.1:4310`, but without the secret they get `401` from every route except the public ones, which don't sign anyone in. That covers other OS accounts logged in on the same computer, and web pages in any browser: a page on another site can't read the app's cookie or make the browser send it (`SameSite=Strict`), and one reaching the API through its own domain (DNS rebinding) also fails the Host check above.

Software running as **your own OS account** isn't kept out. It could read the secret from the API process's environment, or read your photos and the database files directly, which needs no API at all. Lifer's position is that your OS account is the trust boundary.

### Folders on desktop

Routes that take a folder path accept any path the API process can read, on any drive (`assertAllowedPath` in `packages/core/src/lib/allowedPaths.ts` allows everything in desktop mode). Choosing any folder, on any drive, is a feature: libraries and trips live on external drives, network shares and, on Linux, wherever the user mounts them (`/mnt`, `/media`, `/srv`, a NAS path), so a list of allowed roots would refuse legitimate folders. Only the app's own window can reach these routes, and the API runs with the user's own permissions, so it can't reach anything the user couldn't.

### The embedded database

The desktop app's Postgres (`apps/desktop/src-tauri/src/embedded_db.rs`) listens on localhost on a port the OS picks at each start. It has a random per-install password, stored in `app-data/postgres-password` with mode 0600 on macOS and Linux. Anyone who can read your app data folder can read the database files directly anyway.

### When the desktop app is connected to a server

The app shows the server's pages in its window. Those pages get a fixed set of the app's native features (`REMOTE_PERMISSIONS` in `apps/desktop/src-tauri/src/lib.rs`): window controls, native file dialogs and saving a file through Save As, opening `http`, `https` and `mailto` links, the updater, and the app's own commands. This is granted only to origins saved in the app's config. Commands that reconfigure the app check that the request comes from the bundled pages, the local API or a configured server (`is_trusted_sender`). Connecting the app to a server means trusting that server with those features; connect only to servers you run.

## Home server on a LAN

The Docker image runs as a non-root user (`USER 568:568` in `Dockerfile`, overridable with `PUID` and `PGID`). It listens on `0.0.0.0` on `PORT` (4000). Postgres isn't published to the host or the network: only the Lifer container reaches it, on the Compose network (`docker-compose.yml`).

- **The first visitor creates the account.** There's no setup code: whoever reaches the setup form first gets the only account (`/auth/register`, serialised with an advisory lock). Create it right after the first start, before anyone else can reach the server.
- **Plain HTTP is supported.** Sign-in works over `http://`, because many home servers have no certificate. The session cookie is `Secure` only when the request came over HTTPS (`cookieSecureFor` in `session.ts`). Over plain HTTP on a shared network, the password and session cookie cross the network unencrypted. Lifer doesn't send HSTS (`strictTransportSecurity: false` in `index.ts`), so that a home server on plain HTTP keeps working; a proxy can add it.
- **No proxy is trusted unless you name it.** `TRUST_PROXY` is unset by default, so Lifer uses each connection's real address and ignores `X-Forwarded-For` (`parseTrustProxy` in `packages/core/src/config.ts`). A device on the network can't pick its own address to get around the per-address part of the [login rate limit](#rate-limiting). Behind a reverse proxy, set `TRUST_PROXY` to the proxy's address ([Reverse proxy and HTTPS](./install/reverse-proxy.md#trust-proxy)); until then every visitor looks like the proxy and shares one per-address limit, and the server logs a warning the first time a forwarded request arrives (`apps/api/src/lib/trustProxyHint.ts`). The session cookie's `Secure` flag doesn't depend on it.
- **Library folders.** On a server, every route that takes a filesystem path is limited to the library folder and the folders listed in `LIFER_LIBRARY_ROOTS` (see [File access](#file-access)).

## Internet-exposed, behind a reverse proxy

Put Lifer behind an HTTPS reverse proxy ([Reverse proxy and HTTPS](./install/reverse-proxy.md)). SECURITY.md treats a server exposed without one as out of scope. Behind HTTPS, the session cookie is `Secure`, `HttpOnly` and `SameSite=Lax`.

### Public routes {#public-routes}

What's exposed to anyone who can reach the server, without signing in:

- `GET /api/auth/setup-status`, `POST /api/auth/register` (refused once the account exists), `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`;
- `POST /api/auth/desktop-session`, which answers `404` on a server;
- share links: `GET /api/share/:token`, `POST /api/share/:token/unlock`, and the shared photos' display and thumbnail images;
- `GET /api/openapi.json`, the API description;
- `GET /api/inaturalist/callback`, the end of the iNaturalist sign-in, which only acts on a `state` value the signed-in user started;
- `/health`, `/version`, the web app's static files and the offline map tiles under `/maps/`.

Every other `/api` route requires a session or an API key with the right scope. That's enforced by a test: `apiRoutes.test.ts` lists every registered `/api` route with its sign-in hook and fails if one has none and isn't on the allowlist in `apps/api/src/auth/publicRoutes.ts`, where each public route has its reason.

Lifer has had no third-party security audit. It's a one-maintainer project, so the realistic exposure for an internet-facing server is an undiscovered bug. Keep it updated: security fixes go into the latest release only.

## Authentication

### Passwords

- **Hashing:** Argon2id through `@node-rs/argon2` with its defaults: 19 MiB of memory (m=19456), 2 iterations, parallelism 1 (`apps/api/src/auth/password.ts`). These match OWASP's minimum recommendation for Argon2id.
- **Minimum length:** 8 characters, checked at setup and password change. There's no maximum, and no check against breached-password lists.
- **Unknown emails:** login runs a full hash verification against a dummy hash, so a wrong email and a wrong password take the same time (`DUMMY_PASSWORD_HASH`).
- **Recovery:** there's no email reset. A forgotten password is reset with `lifer-admin reset-password` in a shell inside the container, which also signs out every device (`apps/api/src/admin/liferAdmin.ts`). Changing the password or email in Settings signs out every other session (`rotateSessions`).

### Sessions

- A session token is 32 random bytes. The database stores only its SHA-256 (`sessions.id`, `hashToken` in `session.ts`), so a copy of the database can't be replayed as a login.
- The cookie `lifer_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when the request came over HTTPS. Sessions last 30 days (`SESSION_TTL_MS` in `packages/core/src/config.ts`) and aren't extended by use.

### API keys

- Keys are `lifer_` followed by 32 random bytes. The database stores only their SHA-256 (`apps/api/src/auth/apiKeys.ts`). The key is shown once, when it's created.
- Each key has a list of scopes, chosen when it's created; an unknown scope is refused rather than dropped (`apps/api/src/auth/apiKeyRoutes.ts`). The scopes are `gallery.read`, `species.read`, `stats.read`, `trips.read`, `album.read`, `album.write`, `share.read`, `share.write`, `photos.read`, `photos.write`, `collection.read` and `collection.write`.
- A key reaches only routes that call `requireScope` with one of its scopes. Routes that use `requireAuth` (settings, account, storage, most maintenance) accept a session cookie only, never a key.
- API keys are a server feature. The desktop app doesn't offer them, and its request gate turns away any request without the app's own credential, keys included.

See the [API guide](./api/overview.md#authentication) for using them.

### Share links

- A share link's token is 32 random bytes, in the URL. The database finds a link by the token's SHA-256 (`shared_links.token_hash`, migration 132, the same `hashToken` as sessions), so a copy of the database alone can't open a share. The owner's copy, for copying the link again from the album, is stored encrypted with the server's key (`token_encrypted`, see [Secrets at rest](#secrets)). Links from before migration 132 were hashed in place and keep working; their plain token is encrypted, and cleared, at the API's next start (`encryptStoredShareTokens` in `apps/api/src/shares/routes.ts`). Request logs replace share tokens with `[redacted]` (`redactShareTokens`, used by `packages/core/src/lib/log.ts`).
- A link can have a password (hashed like the account password), an expiry date, and can be revoked. A link only shows the one album it was made for, and downloads of originals only when the owner allowed them.
- Unlocking a password-protected link sets a cookie signed with HMAC-SHA256 under a key generated when the server starts (`apps/api/src/shares/unlockCookie.ts`). It lasts 24 hours, and a restart signs every visitor out of every unlocked share.

### iNaturalist sign-in

Linking an iNaturalist account uses OAuth with PKCE and a random `state` value kept in memory for the user who started it (`apps/api/src/inaturalist/routes.ts`). Lifer stores no iNaturalist client secret. The access and refresh tokens it receives are stored encrypted with the server's key (`apps/api/src/inaturalist/tokenStore.ts`, see [Secrets at rest](#secrets)). Tokens stored in plain text by an older version are encrypted at the next start, or when first read.

## Cross-site requests {#csrf}

A page on another site can make your browser send requests to Lifer, with your cookie. Lifer blocks state changes from those in every mode, with an `onRequest` hook (`isBlockedCrossSiteWrite` in `packages/core/src/lib/requestGuard.ts`, unit-tested in `requestGuard.test.ts`):

- `GET`, `HEAD` and `OPTIONS` pass. Every other method needs the header `x-lifer-client: 1`, which Lifer's own web app sends on every request (`apps/web/src/api/client.ts`) and the desktop shell sends on its own calls. A page on another site can't add a custom header without a CORS preflight, and Lifer registers no CORS handler, so the preflight fails.
- On top of that, a browser's `Sec-Fetch-Site` must be `same-origin` or `none`; without it, an `Origin` header must match the host.
- Requests with an `x-api-key` header skip this check, because they're API clients rather than a browser carrying a cookie. The route still checks the key, and on a server a wrong key gets a 401. A browser can't send that header cross-site either.

The guard relies on state-changing routes not using `GET`. Two tests in `apiRoutes.test.ts` check it: every `GET` route must be on the reviewed list in `apps/api/src/readOnlyGetRoutes.ts`, so a new one fails until someone checks it, and a `GET` handler whose own code writes to the database fails unless the write is listed there with its reason. The listed writes are caches and bookkeeping (a downloaded reference photo's path, a drive's last-seen time) and the iNaturalist sign-in redirect, which has to be a `GET` and acts only on a `state` value the signed-in user started. The second test reads each handler's own code, not the helpers it calls, so the list review is the main safeguard.

Other browser protections, from `@fastify/helmet` in `apps/api/src/index.ts`:

- A Content-Security-Policy that allows scripts from Lifer itself only (`script-src 'self'`) and forbids framing (`frame-ancestors 'none'`, plus `X-Frame-Options: DENY`).
- `Referrer-Policy: strict-origin-when-cross-origin`.
- Images may load from any `https:` origin, which reference photos need. Styles allow `'unsafe-inline'`.

## Rate limiting {#rate-limiting}

Only password checks are rate limited (`apps/api/src/auth/rateLimiter.ts`). The client address is the connection's own unless [`TRUST_PROXY`](#home-server-on-a-lan) names a proxy to believe:

| What | Limit |
|---|---|
| Login, per email and client address | 10 failed attempts in 15 minutes |
| Login, per email across all addresses | 50 failed attempts in 15 minutes |
| Share link password, per link and client address | 10 failed attempts in 15 minutes |
| Share link password, per link | 50 failed attempts in 15 minutes |

Only failures count, so the owner isn't locked out by someone else's guesses from another address once they sign in correctly. IPv6 clients are grouped by /64. The counters are in memory: they reset when Lifer restarts and wouldn't be shared between several API processes (Lifer runs one).

Other routes aren't rate limited. Lifer doesn't defend against a signed-in user, or anyone with a valid API key, overloading their own server.

## File access {#file-access}

On a server, Lifer can only read and write the library folder (`DATA_DIR`, `/data` in Docker) and the folders listed in `LIFER_LIBRARY_ROOTS` (`assertAllowedPath` in `packages/core/src/lib/allowedPaths.ts`):

- The path must be absolute and inside an allowed root. That's checked lexically first, so a refused path never reveals whether it exists.
- Both the root and the path are then resolved with `realpath`, so a symlink inside an allowed folder that leads outside it is refused.
- Containment uses `path.relative` rather than a string prefix (`isWithin` in `packages/core/src/lib/pathContainment.ts`), so `/data2` isn't mistaken for being inside `/data`.
- Trip folders apply the same check to each file within the trip's own folder (`resolveWithinTripFolder` in `apps/api/src/trips/scan.ts`).

In the desktop app any path is allowed: the user picks folders in native dialogs, on any drive, and only the app's own window can reach these routes. See [Folders on desktop](#folders-on-desktop).

Lifer writes into the library: it files photos into species folders and writes species keywords and ratings into files it manages (see [Imports and metadata](./contributing/imports-and-metadata.md)). Files it links in place, without managing them, are never moved or written. In Docker, the `permissions` container only changes ownership of the top of the library folder and of root-owned files (see [File ownership](./install/docker.md#file-ownership)).

## Uploads

- **Size:** `MAX_UPLOAD_BYTES` caps a single file, for both multipart uploads and resumable (tus) uploads, where an `Upload-Length` over the cap is refused before any data is sent. It defaults to `0`, no limit, because wildlife videos and RAW files are large and the uploader is the account holder. JSON bodies are capped separately at 64 MB (`LIFER_MAX_JSON_BODY_BYTES`).
- **Ownership:** a resumable upload's ID includes the user's ID, and every request for it is checked against the caller (`apps/api/src/uploads/tus.ts`, `apps/api/src/lib/tusUploads.ts`). Its SHA-256 is computed as it arrives and checked again when it's imported.
- **Cleanup:** uploads idle for two hours, and staged files not imported, are deleted by a maintenance task (`apps/api/src/lib/maintenance.ts`).
- **Parsing:** uploaded files are read by `sharp` (libvips), ExifTool (through `exiftool-vendored`) and FFmpeg. These are large parsers of untrusted formats; a vulnerability in one is a vulnerability in Lifer. Only the signed-in user can upload, which limits who can feed them files.

Disk exhaustion by the account holder or an API key with `photos.write` is out of scope (SECURITY.md).

### Vectors computed by the desktop app

When the desktop app is connected to a server, it can run species matching itself and send the resulting vectors with the photo, so the server doesn't have to (`packages/core/src/species/clientVectors.ts`). The server accepts them without running the models again. It checks that they're for the same photo (its SHA-256), the same preprocessing and model versions, and that each is a 768-number unit vector of finite values; anything else is ignored and the server computes its own.

A sender could still send well-formed but wrong vectors. That's an accepted risk: only the signed-in user or an API key with `photos.write` can upload, and the vectors only affect that user's own photos (their suggestions, similar-photo search and duplicate hints), never the catalog or anyone else's data. Recomputing even a sample would cost the server the very work this feature saves, for no protection beyond what an account holder can already do to their own library.

## Outbound requests {#ssrf}

Lifer fetches data from a fixed set of services ([Privacy](./privacy.md) lists them). Where the URLs come from:

- **Lifer's own data** (catalog, packs, photo store, map, models): from `packages/core/src/config.ts` defaults or environment variables the server admin sets, never from a request.
- **Species information and photos:** iNaturalist, GBIF and Wikimedia URLs built in code, or photo URLs that come from those services' responses and the catalog.
- **GPU runtime libraries:** fixed npm, NuGet and PyPI URLs, each pinned by SHA-256 and size in `apps/api/src/species/gpuRuntime.ts`. Model files are checked against `packages/core/src/species/modelChecksums.ts`.
- **S3 photo sources:** the endpoint, bucket and region come only from environment variables (`apps/api/src/photoSources/s3.ts`). A request supplies an object key, not a URL.
- **Migrating a desktop library to a server:** the one place a user types a URL that the API then requests (`apps/api/src/settings/migrateToServer.ts`). It's available only in the desktop app (`desktopOnly`). It refuses loopback, link-local (which includes cloud metadata services) and unspecified addresses, and allows private network addresses, since a home server is the normal target. The check runs on the resolved addresses first, for a clear message, and then on every connection the migration makes, against the address actually connected to (`guardedDispatcher` in `apps/api/src/lib/outboundGuard.ts`). So a name that resolves to a public address when checked and to `127.0.0.1` when used (DNS rebinding), a redirect, or an upload address the server answers with can't reach loopback.

No route on a server takes a URL to fetch.

## Secrets at rest {#secrets}

| Secret | Where | How it's stored |
|---|---|---|
| Account password | `users.password_hash` | Argon2id hash |
| Session tokens, API keys | `sessions.id`, `api_keys.key_hash` | SHA-256 |
| Share link tokens | `shared_links.token_hash`, `shared_links.token_encrypted` | SHA-256 to find a link; the owner's copy AES-256-GCM encrypted |
| Share link passwords | `shared_links.password_hash` | Argon2id hash |
| iNaturalist access and refresh tokens | `user_inaturalist_accounts` | AES-256-GCM encrypted |
| The key for the encrypted values | `secrets/at-rest-key-v1` in the app data folder (`APP_DATA_DIR`) | Plain, mode 0600 in a 0700 folder; never in the database |
| Database password, server | `DB_PASSWORD` in `.env`, and in `DATABASE_URL` in the container's environment | Plain text, readable by anyone who can read `.env` or inspect the container |
| Database password, desktop | `app-data/postgres-password` | Plain text, mode 0600 |
| S3 credentials | The container's environment, read by the AWS SDK | Wherever you configure them; never in the database |

The encrypted values use AES-256-GCM through `node:crypto`, with a random IV each time and the kind of secret bound in as associated data, so a value moved to another column doesn't decrypt (`apps/api/src/lib/secretBox.ts`). The key is 32 random bytes the server makes on first use. Each value starts with its key's version (`lifer-enc:v1:`), so a new key can be introduced later: old values still decrypt with their own key file and are re-encrypted as they're read. On Windows the file modes don't apply; the app data folder's own permissions do.

This protects a copy of the database on its own, like a dump or a backup of the database volume. It doesn't protect against someone who has both the database and the app data folder, or who controls the server. Losing the key (restoring the database without the app data folder) means linking iNaturalist again; share links keep working, but their addresses can't be shown again. See [Backup and restore](./install/backup-restore.md#secrets-key).

Nothing else in the database or on disk is encrypted. Protect the database volume, its backups and the app data folder as you would the photos themselves. The Docker setup's database password defaults to `lifer` if you don't set one; the database still isn't reachable from the network, but set your own.

## Releases and dependencies

- **Builds:** releases are built only by GitHub Actions from a version tag, after the full test suite passes (`.github/workflows/release.yml`). See [Code signing policy](./code-signing.md).
- **Checksums:** every release has a `SHA256SUMS` file covering its downloads.
- **Desktop updates:** signed with Lifer's update key; the app refuses an update whose signature doesn't match.
- **Windows and macOS signing:** Windows signing through SignPath applies once Lifer's application is approved; until then Windows builds are unsigned. macOS builds are signed with Lifer's own self-signed identity and aren't notarized. Details on [Code signing policy](./code-signing.md).
- **Docker image:** pushed to GHCR with a BuildKit SBOM and provenance attestation (`sbom: true`, `provenance: mode=max`), plus a GitHub build provenance attestation (`actions/attest-build-provenance`).
- **Dependencies:** a committed `package-lock.json` installed with `npm ci` in CI. Dependabot opens grouped updates weekly for npm and Cargo, monthly for the docs, GitHub Actions and Docker base images, and security updates as advisories are published (`.github/dependabot.yml`). CodeQL scans the code (`.github/workflows/codeql.yml`).
- **Bundled tools:** the desktop build fails if the Node runtime doesn't match nodejs.org's `SHASUMS256.txt`, and the macOS FFmpeg is built from pinned, checksum-verified sources ([Desktop app](./contributing/desktop-app.md#building-an-installer)).
- **Workflow actions:** third-party actions in `ci.yml`, `codeql.yml`, `docs.yml`, `mutation.yml` and `catalog-seed.yml` are pinned by full commit SHA, with the version in a comment, which Dependabot keeps updated. **Known gap:** `release.yml` and `desktop-build.yml` still pin by version tag (`actions/checkout@v4`), so a compromised upstream tag would reach those builds.
- **Catalog seed:** the species catalog is checked against the SHA-256 in its manifest when the server downloads it (`downloadSeed` in `apps/api/src/species/catalogSeedUpdate.ts`), and the copy bundled into the Docker image is checked against the manifest bundled with it before a first boot loads it (`verifiedBundledSeed`), refusing on a mismatch. The desktop build checks the seed it bundles; the desktop app's own restore of that bundled seed at first launch (`embedded_db.rs`) doesn't check it again yet.

## Desktop offline cache {#offline-cache}

With **Keep an offline cache** on (the default), the desktop app keeps a copy of the signed-in user's collection from the connected server in `offline-cache` in its app data folder (`apps/desktop/src-tauri/src/offline_cache.rs`): species names, collected and seen status, and covers of at most 48 KB each. It isn't encrypted, so anyone who can read your OS account's files can see which species you've collected and small versions of your cover photos. It holds no password, session, API key or full-size photo.

Only the connected server's own pages, which already hold the session, can write it, and only the app's bundled offline page can read it. It's tied to one server address and one user id, and deleted when the user signs out, unticks the option, switches server or goes back to the local library; a different user on the same server starts from empty. See [Offline cache](./install/connect-desktop-to-server.md#offline-cache).

## Out of scope

- Anyone who controls the computer or server Lifer runs on, its OS account, or its Docker host.
- Software running as your own OS account on the same computer as the desktop app (see [above](#other-software-on-the-same-computer)).
- The account holder, or an API key they created, acting against their own server, including filling its disk.
- A server exposed to the internet without HTTPS.
- Vulnerabilities in the services Lifer downloads data from, and the contents of that public data.
- Multiple users on one server: Lifer has one account per server, and the schema's per-user columns aren't a security boundary that's been tested as one.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/SECURITY.md). Report privately through GitHub's "Report a vulnerability"; fixes ship in the latest release, with credit.
