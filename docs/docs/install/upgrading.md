---
title: Upgrading
description: How to update Lifer safely, stay on a version you choose, and what to do if an update goes wrong.
---

# Upgrading

Lifer is in beta, and new releases come often. This page covers updating a Docker server and the desktop app. Each release's changes are listed in the [release notes](https://github.com/Sparklysparkspark/lifer-app/releases) and the [changelog](https://github.com/Sparklysparkspark/lifer-app/blob/main/CHANGELOG.md).

## Before you update a server

1. **Back up the database.** From the folder with `docker-compose.yml`:

   ```bash
   docker compose exec -T postgres pg_dump -U lifer lifer > lifer-db-$(date +%F).sql
   ```

   See [Backup and restore](./backup-restore.md) for the whole routine.
2. **Read the release notes** for every version between yours and the new one. They say if you need to do anything by hand.

Your version is shown at `/version` on your server's address, like `http://192.168.1.50:4000/version`.

## Update a Docker server

```bash
docker compose pull
docker compose up -d
```

When Lifer starts on the new version, it updates the database by itself. Watch the log until it's ready:

```bash
docker compose logs -f api
```

The database container keeps its Postgres version through ordinary updates.

## Choose a version {#pin}

The compose file runs the image `ghcr.io/sparklysparkspark/lifer-app:${LIFER_VERSION:-release}`. Set `LIFER_VERSION` in `.env` to choose what `docker compose pull` gets:

| `LIFER_VERSION` | What you get |
|---|---|
| unset, or `release` | The newest stable release. Recommended. |
| `0.9` | The newest release in the 0.9 line, so fixes but no bigger changes. |
| `0.9.1` | Exactly that version. It never changes until you change the setting. |

`latest` is another name for `release`. Tags with a `v` in front, like `v0.9.1`, are also published. Test versions (release candidates such as `1.0.0-rc.1`) are only ever published under their exact version, never as `release` or `latest`.

After changing `LIFER_VERSION`, run `docker compose pull` and `docker compose up -d`.

## Automatic updates {#auto-update}

Lifer doesn't ship an auto-updater for servers. You can add your own, such as Watchtower, at your own risk, but during the beta we recommend against it: an update you didn't plan can change your database before you've made a backup, and there's no way back. If you do use one, pin a minor line like `LIFER_VERSION=0.10` and keep scheduled [database backups](./backup-restore.md#back-up-the-database).

## Going back to an older version {#downgrade}

Lifer only changes the database forward. An older Lifer can't run on a database a newer one has updated, so you can't downgrade by changing the image tag.

If an update goes wrong:

1. Stop Lifer: `docker compose down`.
2. Set `LIFER_VERSION` in `.env` to the version you had before.
3. [Restore the database backup](./backup-restore.md#restore) you made before updating.
4. Start Lifer: `docker compose up -d`.

Then [tell us what happened](../support.md), so it can be fixed.

## The desktop app

The desktop app checks for updates by itself and offers to install them. See [Updating the desktop app](./desktop.md#updating). It only offers stable releases, and it keeps your library and database as they are. Like the server, an updated app can't go back to an older version with the same database, so keep a [backup](./backup-restore.md#desktop-app) if your library matters to you.

If you use the desktop app [connected to a server](./connect-desktop-to-server.md), keep the app and the server on the same version where you can.

### When an update includes a new database version {#desktop-database-upgrade}

Now and then an update moves the desktop app to a newer version of PostgreSQL, the database inside it. The app upgrades your library's database by itself the first time it opens after that update. You don't need to do anything, and it works offline:

- While it runs, the startup screen says **Upgrading your database (one time)…** with the current step. It usually takes under a minute, and longer for a very large library. Keep Lifer open until your library appears.
- It needs some free disk space. On a Mac the copy it makes takes almost no extra space; on Windows and most Linux systems it needs about as much free space again as your database. If there isn't enough, Lifer says so and changes nothing: free some space and open it again.
- If Lifer is closed or your computer turns off part way through, nothing is lost. The next time Lifer opens, it starts the upgrade over from your untouched database.
- When your library has opened on the upgraded database, Lifer tells you that a copy of the old database is kept, how big it is and where, and offers to delete it. Keep it until you've checked your library looks right.

The old copy is a folder named like `postgres-data.pg17-backup`, next to the database folder `postgres-data` in Lifer's own data folder:

- **macOS:** `~/Library/Application Support/app.lifer.desktop/app-data/`
- **Windows:** `%APPDATA%\app.lifer.desktop\app-data\`
- **Linux:** `~/.local/share/app.lifer.desktop/app-data/`

To free the space later, quit Lifer and delete that `postgres-data.pg…-backup` folder. Don't touch `postgres-data` itself.

If you skip several updates, you may be asked to install an update in between first: each release can upgrade from the database version of the release before it, not from any older one. Your data is unchanged until you do.
