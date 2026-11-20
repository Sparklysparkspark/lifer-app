---
title: Releasing
description: How a maintainer cuts a Lifer release, and what the release workflow publishes.
---

# Releasing

This page is for maintainers. A release is a git tag; `.github/workflows/release.yml` does the rest.

## Cut a release

1. **Update the changelog.** In `CHANGELOG.md`, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`, and add a new, empty `[Unreleased]` section above it. The release notes come from this section, and the workflow fails if it's missing, so write it for users.
2. **Bump the versions** in every `package.json`:

   ```bash
   npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version
   ```

3. **Commit** both, for example `chore: release X.Y.Z`, and push it to `main`.
4. **Tag and push the tag:**

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

## What the workflow does

When a `v*` tag is pushed, `release.yml`:

1. Runs the full CI first, and the desktop database upgrade test on Apple Silicon (`desktop-build.yml`'s `pg-upgrade` job, see [Desktop app](./desktop-app.md#pg-upgrade)). Nothing is published if either fails.
2. Extracts the version's section from `CHANGELOG.md` into the release notes.
3. Builds the desktop installers:
   - macOS: `Lifer-macos-arm64.zip` (Apple Silicon) and `Lifer-macos-x64.zip` (Intel), both built on an Apple Silicon runner, the Intel one cross-compiled (see [Desktop app](./desktop-app.md#intel-macs)). Each ships FFmpeg built from source by `build-ffmpeg-macos.sh` in place of ffmpeg-static's nonfree binary (see [Desktop app](./desktop-app.md#building-an-installer)), and PostgreSQL built from source by `build-postgres-macos.sh` (see [The bundled PostgreSQL](./desktop-app.md#bundled-postgres)). With the Developer ID settings (see [below](#macos-developer-id)) both are signed with Lifer's Developer ID, notarized by Apple and stapled, so they open without a warning. Without them, they're signed with Lifer's own self-signed identity and users confirm the first launch once (see the [code signing policy](../code-signing.md)). The FFmpeg and PostgreSQL builds are each cached until their script changes, but a tag can only reuse a cache saved on the default branch, so after changing either script, run the Desktop build workflow on `main` once for each architecture to save them.
   - Windows (x64): an NSIS `.exe` installer, signed through SignPath once that's set up (see [below](#windows-code-signing))
   - Linux (x64): a `.deb` and an AppImage
4. Writes the signed Tauri update manifest (`latest.json`) that the desktop app's updater reads, and a `SHA256SUMS` file for every download.
5. Builds the Docker image for `linux/amd64` and `linux/arm64`, and pushes it to `ghcr.io/sparklysparkspark/lifer-app` with these tags:

| Tag | Example | Points at |
|---|---|---|
| `X.Y.Z` | `0.9.1` | Exactly this release |
| `X.Y` | `0.9` | The newest release in this minor line |
| `release` | | The newest stable release. The compose file's default. |
| `latest` | | The same as `release`, for tools that pull `latest` by default |

## Windows code signing {#windows-code-signing}

Unsigned, the Windows installer makes SmartScreen warn that Lifer is from an unknown publisher. [SignPath Foundation](https://signpath.org) signs open source projects' releases for free, with a certificate issued to the Foundation. The release workflow is ready for it but does nothing until it's configured: without the settings below, the installer ships unsigned, as before.

Once set up, the Windows build signs twice, because SignPath can't sign inside an NSIS installer: first the app's own `lifer-desktop.exe` (built with `tauri build --no-bundle`), then the installer that `tauri bundle` packs around it. Each is a separate signing request that someone has to approve in SignPath, and the build waits up to an hour for each. The Tauri updater signature (`TAURI_SIGNING_PRIVATE_KEY`) is separate and unchanged; it's made afterwards, over the signed installer.

### 1. Apply

Apply at [signpath.org/apply](https://signpath.org/apply), and check the [conditions](https://signpath.org/terms) are still met. Lifer's side of them is already published: the [code signing policy](../code-signing.md) (SignPath's required attribution, the team's roles, how releases are built and what's signed) and the [privacy page](../privacy.md) it links to. Keep both true as the release flow changes. Everyone with access to SignPath or the repository needs multi-factor authentication.

### 2. Set up the SignPath project

After approval, in SignPath ([docs](https://docs.signpath.io/trusted-build-systems/github)):

1. Add the predefined **GitHub.com** trusted build system to the organization and link it to Lifer's project. Optionally install the SignPath GitHub App on the repository.
2. Create two **artifact configurations**. `actions/upload-artifact` uploads each file inside a zip, so both have a `<zip-file>` root: one with a `<pe-file>` for `lifer-desktop.exe`, one for the installer (`Lifer_*_x64-setup.exe`). Use the product name and version checks SignPath Foundation requires (see their [artifact configuration docs](https://docs.signpath.io/artifact-configuration)); Tauri sets the product name **Lifer** and the release's version on both files.
3. Use the **signing policy** for releases that SignPath Foundation set up, with approval required.
4. Create a CI user with **submitter** permission on that policy, and an API token for it.

### 3. Add the GitHub settings

In the repository's **Settings > Secrets and variables > Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | The CI user's API token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | The SignPath organization ID |
| Variable | `SIGNPATH_PROJECT_SLUG` | The project's slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | The release signing policy's slug |
| Variable | `SIGNPATH_EXE_ARTIFACT_CONFIGURATION_SLUG` | The artifact configuration for `lifer-desktop.exe` |
| Variable | `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG` | The artifact configuration for the installer |

Signing switches on when `SIGNPATH_API_TOKEN` or `SIGNPATH_ORGANIZATION_ID` is set. If either is set but anything else in the table is missing, the Windows build fails rather than publishing an unsigned installer by mistake.

### 4. Release

Cut releases as usual. While the Windows build runs, approve its two signing requests in SignPath. The build checks the installer's Authenticode signature before uploading it. After the first signed release, update the Windows steps in [Install the desktop app](../install/desktop.md#install-on-windows), which still describe the unsigned warning.

## macOS Developer ID and notarization {#macos-developer-id}

Notarized, the macOS app opens with no Gatekeeper prompt. It needs a paid Apple Developer Program membership. Without the settings below, releases keep Lifer's self-signed identity.

1. In the Apple Developer account, create a **Developer ID Application** certificate. Export it with its private key from Keychain Access as a `.p12` with a password.
2. In App Store Connect, under **Users and Access > Integrations**, create a team API key with the **Developer** role. Download the `.p8` (it can be downloaded once) and note its key ID and the issuer ID.
3. Add these in **Settings > Secrets and variables > Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `APPLE_DEVELOPER_ID_P12_BASE64` | `base64 -i cert.p12` |
| Secret | `APPLE_DEVELOPER_ID_PASSWORD` | The `.p12`'s password |
| Secret | `APPLE_NOTARY_KEY_P8_BASE64` | `base64 -i AuthKey_XXXX.p8` |
| Variable | `APPLE_NOTARY_KEY_ID` | The API key's ID |
| Variable | `APPLE_NOTARY_ISSUER` | The issuer ID |

Notarizing switches on when `APPLE_DEVELOPER_ID_P12_BASE64` is set; if anything else in the table is missing, the macOS build fails rather than shipping an unnotarized release. `resign-macos.js` then signs every binary in the app with the hardened runtime (`src-tauri/entitlements.plist` lists its exceptions), submits it with `notarytool`, staples the ticket and checks it with `spctl`. Notarization usually takes a few minutes. After the first notarized release, update the macOS steps in [Install the desktop app](../install/desktop.md) and the [code signing policy](../code-signing.md), which still describe the first-launch prompt.

## Prereleases

A tag with a hyphen, like `v1.0.0-rc.1`, is a prerelease. It gets its exact version tags only, never `release` or `latest`, and the GitHub release isn't marked as latest. So servers on the default `release` tag and desktop apps checking for updates don't get it. Testers opt in by setting `LIFER_VERSION=1.0.0-rc.1`.

## Data releases

The species data ships separately from the app, as GitHub releases the [data pipeline](./data-pipeline.md) publishes: `catalog-latest`, `packs-latest`, `photos-latest`, `map-latest` and `models`. These are always marked as **prereleases**, and must never be marked "Latest". The desktop updater and the web app's update banner both read the repository's latest release, so a data release marked latest would hide the app's real one.

## Third-party sources

The `third-party-sources` release holds the source of LGPL libraries the installers ship as
binaries: today, the GNU gettext and libiconv DLLs in the Windows app's bundled PostgreSQL. Like the
data releases, it's a prerelease and must never be marked "Latest". When a PostgreSQL update
changes either DLL, `stage-postgres.js` stops the Windows build and says which one. Download that
version's source and its `.sig` from <https://ftp.gnu.org/gnu/>, check the signature, upload both
to the release, then add the DLL's sha256 and source to `WINDOWS_LGPL_DLLS` in
`apps/desktop/scripts/stage-postgres.js` and update THIRD_PARTY_NOTICES.md.

## After releasing

Before tagging the final release, run the [platform and release checklists](./platform-checklists.md) on a release candidate.

- Check the GitHub release page: notes, installers, `SHA256SUMS`.
- Pull the new image on a test server and start it, to see the migrations run.
- Install the update from inside an older desktop app, to check the updater.
