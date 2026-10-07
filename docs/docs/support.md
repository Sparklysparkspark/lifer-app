---
title: Getting help
description: Where to ask questions, report bugs and report security problems, and what to include.
---

# Getting help

Lifer is built by volunteers in the open. Here's where to go, depending on what you need.

| You want to... | Go to |
|---|---|
| Ask a question, or get help with your setup | [Discussions: Q&A](https://github.com/Sparklysparkspark/lifer-app/discussions) |
| Suggest a feature or share an idea | [Discussions: Ideas](https://github.com/Sparklysparkspark/lifer-app/discussions) |
| Show off your setup or your life list | [Discussions: Show and tell](https://github.com/Sparklysparkspark/lifer-app/discussions) |
| Report a bug | [Issues](https://github.com/Sparklysparkspark/lifer-app/issues/new/choose), using the bug report form |
| Report a security problem | [A private security advisory](https://github.com/Sparklysparkspark/lifer-app/security/advisories/new). Please don't open a public issue. |

Before asking, check [Troubleshooting](./troubleshooting.md) and the [FAQ](./faq.md), and search the existing issues and discussions. Someone may already have the answer.

Issues are for bugs and for feature work that's been agreed on. Ideas start in Discussions, so they can be talked through first.

## What to include

A good report gets a fix much sooner. Include:

- **Your Lifer version.** In the desktop app, it's in **Settings > General > App updates**. On a server, open `/version` on your server's address, like `http://192.168.1.50:4000/version`.
- **How you run Lifer:** the desktop app (and on which operating system), or Docker (and on what: a NAS, Unraid, TrueNAS, a Linux server).
- **What you did, what you expected, and what happened instead.** Steps to make it happen again are the most useful thing of all.
- **Logs** from around the time it happened (below).
- Screenshots, if it's something you can see.

Check logs and screenshots for anything private, such as email addresses, folder names or server addresses, before you post them.

## Getting logs {#logs}

**Docker server:** from the folder with `docker-compose.yml`:

```bash
docker compose logs --since 1h api > lifer-logs.txt
```

Change `1h` to cover when the problem happened. On a NAS, open the Lifer container's logs in its interface. If Lifer doesn't start at all, include the other containers' logs too: `docker compose logs postgres permissions`.

**Desktop app:** the app doesn't write a log file. If Lifer stops unexpectedly, the error dialog shows its last messages: copy those. To see everything as it happens, start Lifer from a terminal:

- **macOS:** `/Applications/Lifer.app/Contents/MacOS/lifer-desktop`
- **Linux AppImage:** run the `.AppImage` file from a terminal.

Then make the problem happen and copy what the terminal shows.

See [Where the logs are](./troubleshooting.md#logs) for log lines worth knowing.

## Which versions are supported

Lifer is in beta, and only the **latest release** is supported. If you're on an older version, please [update](./install/upgrading.md) and check whether the problem is still there before reporting it. Fixes go into new releases; older versions don't get updates.

## Code of Conduct

Everyone taking part in Lifer's issues, discussions and pull requests is expected to follow the [Code of Conduct](https://github.com/Sparklysparkspark/lifer-app/blob/main/CODE_OF_CONDUCT.md).
