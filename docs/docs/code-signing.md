---
title: Code signing policy
description: How Lifer's release builds are produced and signed, who can sign them, and how to verify a download.
---

# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

- **Windows:** the Lifer installer and the app it installs, for each [release](https://github.com/Sparklysparkspark/lifer-app/releases). Signing applies once Lifer's application to the SignPath Foundation is approved; until then Windows builds are unsigned.
- **macOS:** signed with Lifer's own self-signed identity, which keeps macOS permissions and updates working across versions. Lifer isn't notarized by Apple: it's a free project, so macOS asks you to confirm the first launch. See [Install the desktop app](./install/desktop.md).
- **Updates:** every platform's in-app updates are signed separately with Lifer's update key, and the app refuses an update that doesn't match it.
- **Every download** is listed in the release's `SHA256SUMS` file, so you can check a file wasn't altered.

Only Lifer's own code is built and signed this way. Bundled third-party programs (such as FFmpeg, ExifTool and Node.js; see [THIRD_PARTY_NOTICES.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/THIRD_PARTY_NOTICES.md)) keep their own signatures or none: for example, the bundled `node.exe` keeps the Node.js project's signature, and the installer's generated uninstaller isn't signed.

## How a release is built

Releases are built only by GitHub Actions ([release.yml](https://github.com/Sparklysparkspark/lifer-app/blob/main/.github/workflows/release.yml)) from a version tag in the [Lifer repository](https://github.com/Sparklysparkspark/lifer-app), after the full test suite passes. No release binary is built or signed on a personal computer. The source of every release is the tagged commit.

## Team and roles

| Role | Who | Responsibility |
|---|---|---|
| Author (committer) | [@Sparklysparkspark](https://github.com/Sparklysparkspark), maintainer | Writes and commits Lifer's code. |
| Reviewer | [@Sparklysparkspark](https://github.com/Sparklysparkspark) | Reviews and approves every outside contribution before it's merged ([review process](./contributing/review-process.md)). |
| Approver | [@Sparklysparkspark](https://github.com/Sparklysparkspark) | Approves each release's signing request. |

Everyone with these roles uses multi-factor authentication on GitHub and SignPath. Outside contributors can't merge, tag a release or approve signing.

## Privacy

Lifer has no telemetry and sends nothing about its users to the project. It connects to other services only to download public data and updates, and for features the user turns on. [Privacy](./privacy.md) lists every connection.

## Reporting a problem

To report a security issue, including a problem with a signed file, follow the [security policy](https://github.com/Sparklysparkspark/lifer-app/security/policy).
