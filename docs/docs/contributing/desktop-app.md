---
title: Desktop app
description: How the Tauri desktop app is put together, run in development, and built into installers.
---

# Desktop app

The desktop app (`apps/desktop`) is a Tauri 2 window around the same web app (`apps/web`) and API (`apps/api`) a server runs. The API runs as a sidecar process on a bundled Node runtime, talking to a Postgres embedded through the [`postgresql_embedded`](https://github.com/theseus-rs/postgresql-embedded) crate (`src-tauri/src/embedded_db.rs`). The PostgreSQL server ships inside the app (see [The bundled PostgreSQL](#bundled-postgres)), so it runs on its own, with no Docker, separate Postgres install or first-launch download. See [Architecture](./architecture.md#appsdesktop) for how the parts talk.

## Development

You need Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform, on top of the [usual setup](./development.md).

```bash
npm start -w desktop     # tauri dev: hot-reloads the web app against a local API
```

`tauri dev` runs the PostgreSQL that `prepare-resources.js` last staged in `src-tauri/resources-staging/postgres`. Without one (on a Mac, until you've built it, see below) the crate downloads a theseus-rs build into `~/.theseus/postgresql` on first start instead, which needs macOS 15.

Debug builds from `tauri dev` always have the browser devtools. CI checks the Rust code with `cargo fmt --check` and `cargo clippy`, so run both in `apps/desktop/src-tauri` before you push.

## Building an installer

```bash
npm run dist -w desktop
```

This chains several steps (see the `dist` script in `apps/desktop/package.json`, and `apps/desktop/scripts/`):

1. `npm run build -w web`: builds the web app.
2. `prepare-resources.js`: stages the API and its dependencies as bundled resources, and the PostgreSQL server (`stage-postgres.js`, see [below](#bundled-postgres)).
   ffmpeg-static's macOS binary is built with `--enable-nonfree`, which FFmpeg's license doesn't allow to be redistributed, so the macOS app ships a GPL build instead: `apps/desktop/scripts/build-ffmpeg-macos.sh <dir> [arm64|x86_64]` builds one from pinned, checksum-verified FFmpeg and x264 sources (a few minutes), and `LIFER_FFMPEG_DIR=<dir>` makes this step copy it over ffmpeg-static's in the bundle. Without it a local build warns and keeps ffmpeg-static's, which is fine for testing but not for sharing. In CI a nonfree ffmpeg fails the build.
3. `fetch-node-sidecar.js`: downloads the Node runtime that runs the API, and fails the build if it doesn't match nodejs.org's `SHASUMS256.txt` for that release.
4. `fetch-catalog-seed.js`: downloads the species catalog seed that every fresh install restores on first launch, plus its manifest. It checks the manifest's sha256 when present, and fails the build if the seed is over 400 MB.
5. `tauri-build.js`: the Tauri and Rust build, producing the platform's installer.
6. `resign-macos.js` (macOS only): re-signs the bundle and adds the folder-access descriptions to `Info.plist`, which macOS needs before it will ask for Desktop, Documents or Downloads access at all. It signs with `MACOS_SIGNING_IDENTITY` (release builds set it to a self-signed "Lifer" certificate), or ad hoc (`-`) when that's unset.

On macOS this step then checks that every native binary in the bundle (Mach-O executables and libraries) runs on the target CPU and on the app's oldest supported macOS, and fails the build if one doesn't. That floor is `bundle.macOS.minimumSystemVersion` in `src-tauri/tauri.conf.json` (macOS 14, set by onnxruntime-node's Apple Silicon build), which is also the version macOS checks before opening the app. A dependency update that raises a binary's minimum macOS (its `LC_BUILD_VERSION` minos, shown by `vtool -show-build <file>`) fails here, so raise the floor on purpose or keep the older dependency. `scripts/check-bundled-natives.js` goes further: run with a built app's own Node (`Lifer.app/Contents/MacOS/node scripts/check-bundled-natives.js Lifer.app/Contents/Resources`), it loads each native module from the bundle alone (sharp, argon2, onnxruntime, FFmpeg and the rest) and starts a throwaway database with the bundled PostgreSQL. Release builds run it for both Mac architectures.

Release builds ship without devtools. For a release build with them, pass `--features devtools` through `TAURI_BUILD_ARGS`.

Release installers are built by `.github/workflows/release.yml`. See [Releasing](./releasing.md).

## Intel Macs {#intel-macs}

The Intel Mac app is cross-compiled on an Apple Silicon Mac, as release builds do (GitHub's Intel Mac runners are being retired). It needs Rosetta 2 (`softwareupdate --install-rosetta --agree-to-license`), since the build runs the Intel FFmpeg, PostgreSQL and Node to check them:

```bash
rustup target add x86_64-apple-darwin
apps/desktop/scripts/build-ffmpeg-macos.sh ~/lifer-ffmpeg-x86_64 x86_64
apps/desktop/scripts/build-postgres-macos.sh ~/lifer-postgres-x86_64 x86_64
LIFER_TARGET_TRIPLE=x86_64-apple-darwin LIFER_FFMPEG_DIR=~/lifer-ffmpeg-x86_64 \
  LIFER_POSTGRES_DIR=~/lifer-postgres-x86_64 npm run dist -w desktop
```

`LIFER_TARGET_TRIPLE` (read by `scripts/target.js`) retargets every step: the Rust build gets `--target`, the Node sidecar is the Intel one, and the app lands in `src-tauri/target/x86_64-apple-darwin/release/bundle/`. `npm ci` only installed the build machine's native packages, so `scripts/retarget-natives.js` fetches the Intel ones into the staged bundle, leaving the repo's own `node_modules` alone. A new native dependency that it doesn't know about fails the architecture check above rather than shipping the wrong binary.

onnxruntime-node stopped publishing Intel Mac binaries after 1.23, so the Intel app bundles onnxruntime 1.23.2 instead of the repo's version. Some quantized models need a newer onnxruntime than that.

## The bundled PostgreSQL {#bundled-postgres}

The app ships the PostgreSQL server its embedded database runs, in `Resources/postgres` (`bin`, `lib`, `share`), so first launch works offline. `embedded_db.rs` points `postgresql_embedded` at it (`trust_installation_dir`), so the crate never downloads anything; it only runs `initdb` on a fresh data folder, then `pg_ctl` and `psql`. A build without a bundled server falls back to the crate's download from theseus-rs.

`scripts/stage-postgres.js` stages it, keeping only what the app needs: `postgres`, `initdb`, `pg_ctl` and `psql`; the backup and upgrade tools `pg_dump`, `pg_restore`, `pg_dumpall` and `pg_upgrade`, with the programs `pg_upgrade` runs (`pg_controldata`, `pg_resetwal`, `vacuumdb`); libpq, PL/pgSQL, the encoding conversions, the `pg_trgm`, `unaccent` and `pgcrypto` extensions the migrations create, and the data files `initdb` loads. A migration that creates another extension needs it added to the `KEEP` list there. The tools add about 1.5 MB (0.5 MB compressed) on macOS and Linux and 2 MB on Windows. Maintainer scripts use the bundled `pg_dump` too (see [Rebuilding the data](./rebuilding-data.md#software)).

- **macOS:** `apps/desktop/scripts/build-postgres-macos.sh <dir> [arm64|x86_64]` builds PostgreSQL 18 from pinned, checksum-verified sources (a few minutes) for macOS 11 and later, without ICU, readline or SSL. pgcrypto links a static OpenSSL 3.5 (also built from pinned source) and is the only part that uses it. Set `LIFER_POSTGRES_DIR=<dir>` for `npm run dist`. CI requires it; a local build without it warns and bundles none, so that copy downloads PostgreSQL on first launch like older versions (macOS 15 only). The prebuilt theseus-rs macOS binaries can't be bundled instead: they need macOS 15, which the floor check above rejects.
- **Linux and Windows:** `stage-postgres.js` downloads the same PostgreSQL release from [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries) at build time and checks it against the sha256 pinned in the script. On Windows it keeps only the DLLs the kept programs import. The Linux build links the system's OpenSSL 3, libxml2, zstd, lz4, Kerberos and readline libraries, as the downloaded one always did.

Existing installs keep their data folder and password. Their data was created by the same PostgreSQL release (18.6), so the bundled server opens it as is. A minor release (18.x) needs no data change: bump the version and hashes in both scripts. A new major version is upgraded on first launch, below.

### The database upgrade on a new major {#pg-upgrade}

PostgreSQL can't open a data folder made by an older major, so `src-tauri/src/pg_upgrade.rs` upgrades it before the server starts. `BUNDLED_PG_MAJOR` there is the one constant the app compares a data folder's `PG_VERSION` with; `POSTGRES_VERSION` in `stage-postgres.js` and `BUNDLED_MAJOR` in `build-postgres-macos.sh` must match it, which a unit test checks. When `PG_VERSION` is the bundled major, startup is as it always was. When it's older:

1. **Old binaries.** `pg_upgrade` needs the old major's server. A release that moves to a new major also ships the previous major's `postgres`, `pg_ctl`, `pg_controldata` and `pg_resetwal` (with their libraries and extensions) in `Resources/postgres-previous/<major>`, so the upgrade works offline. For 17 that's about 18 MB on macOS and 16 MB on Linux (about 7 MB compressed) and 58 MB on Windows. The alternative, downloading the old binaries on demand from a pinned, hash-checked release asset, keeps the app smaller but makes the first launch after the update need the internet, and fail without it; the bundle was chosen for that reason. Only the previous major is shipped, so someone who skips a whole major can't upgrade directly: the app says to install the release in between first.
2. **Before anything,** it checks free disk space, and writes `app-data/postgres-upgrade.json`, a marker that records the step it's on. A crash or force-quit during the upgrade is cleaned up on the next launch, which starts it over: it stops any `pg_upgrade` or server the crashed launch left running and deletes the half-made new folder.
3. **The new cluster** goes in `postgres-data.upgrading`, made by the new `initdb` with the crate's settings (superuser `postgres`, password auth, the install's password) and the old cluster's encoding, locale and checksum setting, which `pg_upgrade` requires to match. PostgreSQL 18's `initdb` enables checksums by default, and 17's didn't.
4. **`pg_upgrade --clone`**, a copy-on-write clone that takes almost no space on APFS, Btrfs and XFS. Where the file system can't clone, `--copy`; if `pg_upgrade` fails, a `pg_dump` of the `lifer` database restored into the new cluster with `pg_restore`. Not `--link`: the new cluster would share the old one's files, so the copy kept below would be ruined once the new server ran. Then `vacuumdb --analyze-in-stages` (`--missing-stats-only` after `pg_upgrade`, which carries statistics over since PostgreSQL 18).
5. **The swap.** `postgres-data` is renamed `postgres-data.pg<old>-backup` and the new folder takes its place. The app then starts as usual, runs the migrations and the API, and only once `/health` answers does it remove the marker and show a dialog with the old copy's size and path, offering to delete it. Nothing deletes the old copy otherwise; the user docs explain where it is ([Upgrading](../install/upgrading.md#desktop-database-upgrade)).

The startup page (`src/index.html`, updated through `src/startup.js`) shows "Upgrading your database (one time)…" with the current step while this runs. Errors (not enough space, or every method failing) leave the old folder untouched and are shown in the usual startup error dialog. `LIFER_PG_UPGRADE_METHOD=clone|copy|dump` forces one method, for tests and support.

**Testing it.** `src-tauri/tests/pg-upgrade-test.sh <old-pg-dir> <new-pg-dir> [x86_64-apple-darwin]` makes a cluster with the old major the way the crate does, runs every migration, loads sentinel data (`tests/pg-upgrade/sentinel.sql`: species rows, a trigram index, an index over `lifer_unaccent`, pgcrypto digests), then runs the `#[ignore]` `pg_upgrade_*` tests in `pg_upgrade.rs`. Those upgrade copies with each method, kill one launch in the middle of `pg_upgrade` and relaunch, and check the contents (`tests/pg-upgrade/fingerprint.sql`, identical before and after), the extensions, index use and statistics. Last, the script starts the API on the upgraded database and waits for `/health`. On a Mac:

```bash
apps/desktop/scripts/build-postgres-macos.sh ~/pg17 arm64 17
apps/desktop/scripts/build-postgres-macos.sh ~/pg18 arm64
apps/desktop/src-tauri/tests/pg-upgrade-test.sh ~/pg17 ~/pg18
```

With x86_64 builds and `x86_64-apple-darwin` as the third argument, it runs the Intel build under Rosetta. The `pg-upgrade` job in `desktop-build.yml` runs it for 17 to 18 (Apple Silicon) when started by hand.

### Upgrading the bundled PostgreSQL to a new major version {#new-major}

A checklist for moving from major N to N+1 (for example 18 to 19):

1. **Pin the new release.** In `build-postgres-macos.sh`, add an `N+1)` case with the newest N+1.x and the sha256 postgresql.org publishes next to it, and set `BUNDLED_MAJOR` to N+1. Keep the `N)` case: it now builds the previous major. Check the `configure` flags against the new release's (a new optional library is on by default only if `configure` says so).
2. **Linux and Windows.** In `stage-postgres.js`, set `POSTGRES_VERSION` to the theseus-rs N+1 release, set `PREVIOUS_POSTGRES_VERSION` to the N release the app shipped last, and pin both releases' sha256 in `THESEUS_SHA256` (download each archive and check it against the `.sha256` file next to it).
3. **The app.** Set `BUNDLED_PG_MAJOR` in `src-tauri/src/pg_upgrade.rs` to N+1. `cargo test --lib` checks the three agree.
4. **CI.** In `desktop-build.yml` and `release.yml`, build the previous major too (`build-postgres-macos.sh <dir> <arch> N`) and set `LIFER_POSTGRES_PREVIOUS_DIR` for the macOS builds, next to `LIFER_POSTGRES_DIR`. The cache key includes the script, so both rebuild once.
5. **Read the release notes** of N+1 for `pg_upgrade` and `initdb` changes: new defaults that must match between the clusters (as checksums did in 18), removed options, and extension changes for `pg_trgm`, `unaccent` and `pgcrypto`.
6. **Test the jump.** Run `tests/pg-upgrade-test.sh` with N and N+1 builds, for both Mac architectures, and update the `pg-upgrade` job's majors. A Linux run is worth doing too (it uses `--copy` on ext4).
7. **Check a real library.** Upgrade a copy of a real desktop library's `app-data` by opening it with the new app (point the app at a copy, never your only one), and check that the dialog shows the old copy's size.
8. **Ship.** The CHANGELOG says the first launch upgrades the database once, how long it may take, and that the old copy is kept until deleted.
9. **A few releases later** (three, or about six months), remove the previous major: set `PREVIOUS_POSTGRES_VERSION` back to `null`, drop the previous-major build from CI, and drop its case from `build-postgres-macos.sh` once nothing tests with it. Users still on major N then get the "install the release in between" message.

## Running the embedded Postgres on its own

`scripts/headless-postgres.js` (`start`, `stop`, `status`, `url`) runs the app's embedded Postgres as an independent process, without the app open. It's useful for long maintenance scripts that should keep their database while the app is rebuilt or relaunched: point `DATABASE_URL` at the URL it prints. It reads the per-install password the app writes to `app-data/postgres-password` (mode 0600) on first launch, and runs the installed app's bundled server (or the one staged in `src-tauri/resources-staging`).

## Connected to a server

When the app is connected to a server, the server's pages get access to the app's native features only for the origins saved in the desktop config. That access is granted at runtime in `src-tauri/src/lib.rs` (`grant_remote_capabilities`), not in `src-tauri/capabilities/`.

## Generated folders

You don't need to edit these. They're gitignored and rebuilt by the steps above:

- `src-tauri/target/`: Rust build output.
- `src-tauri/resources-staging/`: files staged by `prepare-resources.js`.
- `src-tauri/binaries/`: the Node sidecar.
