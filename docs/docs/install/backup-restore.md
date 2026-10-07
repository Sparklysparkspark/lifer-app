---
title: Backup and restore
description: What to back up in Lifer, and how, for Docker servers and the desktop app.
---

# Backup and restore

Lifer doesn't have a built-in backup button. Your data lives in ordinary files and a database, so you back them up with the tools you already use.

## What to back up

| What | Why it matters | Where it is |
|---|---|---|
| **Your photo library** | Your original photos, RAW files and videos. You can't get these back any other way. | Docker: the folder in `LIFER_STORAGE_DIR`. Desktop: the folder you chose at setup, plus any external drives. Also your [trip](../guides/trips.md) folders, wherever they are. |
| **The database** | Which species each photo shows, ratings, tags, albums, trips, hidden and archived species, and settings. | Docker: the `postgres` container. Desktop: inside Lifer's app data folder. |
| App data | Thumbnails and preview images, downloaded models, the offline map and catalog downloads, and the key that encrypts a few secrets in the database (`secrets/`). | Docker: the `lifer-app-data` volume. Desktop: the app data folder. Optional: Lifer downloads or rebuilds all of it, but rebuilding thumbnails for a big library takes a while. See [The secrets key](#secrets-key). |

You don't need to back up the upload work folder (`uploads` in the app data folder, or a hidden `.lifer-uploads` folder inside the library). It only holds files on their way in, and Lifer clears it out by itself.

Downloaded region packs can also be downloaded again from [Offline packs](../guides/offline-packs-and-map.md).

:::tip Your files carry a safety net
Lifer writes each photo's species and rating into the file itself (or an `.xmp` sidecar next to a RAW), and keeps small recovery records in `.lifer` folders inside the library: your seen species, targets, archived and hidden species, your own rarity tiers and checklist additions (`.lifer/collection-state.json`), which albums each photo is in, and the species of photos in trip folders. Collected species come back from the photos themselves. So even with only the photo library, **Settings > Library > Reimport library** can rebuild most of your collection. Settings, trips, cover photo choices, share links, API keys and your account aren't in the files, so they need the database backup.
:::

### The secrets key {#secrets-key}

Lifer encrypts the few secrets it has to keep readable, a linked iNaturalist account's sign-in and your copy of each share link, with a key in the app data's `secrets` folder (`secrets/at-rest-key-v1`), not in the database. That way a database backup on its own doesn't carry them. Keep the `secrets` folder with your database backup if you can; it's tiny.

If you restore the database without it, nothing else is lost: you link iNaturalist again in Settings, and existing share links keep working, but their addresses can no longer be shown in the album's share list (create a new link if you need to copy one). Keep the key as private as the database: together they open those secrets.

## Docker server

### Back up the database

From the folder with `docker-compose.yml`, while Lifer is running:

```bash
docker compose exec -T postgres pg_dump -U lifer lifer > lifer-db-$(date +%F).sql
```

This writes a single `.sql` file with everything in the database. Run it on a schedule (with cron, or your NAS's task scheduler) and keep a few copies.

### Back up the photo library

Copy the `LIFER_STORAGE_DIR` folder with your normal backup tool: your NAS's snapshots or replication, `rsync`, restic, Borg, or a cloud backup. It's plain folders of photos, so any tool works.

Take the database backup and the library backup around the same time, so they match.

To keep the [secrets key](#secrets-key) too, copy it out of the app data volume:

```bash
docker compose cp api:/app-data/secrets ./lifer-secrets
```

To put it back when you restore, do this before step 4 below. The `permissions` step gives the copied files to Lifer's user when everything starts.

```bash
docker compose create api
docker compose cp ./lifer-secrets/. api:/app-data/secrets/
```

### Restore

1. Put the photo library back in the `LIFER_STORAGE_DIR` folder. Make sure Lifer's user (`PUID:PGID`, `568:568` by default) can read and write the restored files, for example with `sudo chown -R 568:568 /mnt/photos/lifer`. The `permissions` step only fixes the top folder, and files owned by root. See [File ownership](./docker.md#file-ownership).
2. Start only the database, with an empty volume:

   ```bash
   docker compose down
   docker volume rm lifer_lifer-db   # only if you're replacing an existing database
   docker compose up -d --no-deps postgres
   ```

   The volume name starts with your project folder's name. Run `docker volume ls` to check it. `--no-deps` starts only the database, without the one-time [move of a Postgres 16 database](./upgrading.md#postgres-18) from Lifer 0.9.0 or earlier, so that your backup is what ends up in it.
3. Load the backup:

   ```bash
   docker compose exec -T postgres psql -U lifer lifer < lifer-db-2026-09-25.sql
   ```

   The new database gets the password in `DB_PASSWORD`, the same as a first start.
4. Start everything:

   ```bash
   docker compose up -d
   ```

Lifer updates the database to the current version by itself when it starts, so an older backup restores fine on a newer Lifer.

## Desktop app

### Back up

1. Quit Lifer, so the database isn't in use.
2. Copy these somewhere safe:
   - Your library folder (and any external drives you use with Lifer).
   - Lifer's app data folder:
     - macOS: `~/Library/Application Support/app.lifer.desktop/`
     - Windows: `%APPDATA%\app.lifer.desktop\`
     - Linux: `~/.local/share/app.lifer.desktop/`

The database is in `app-data/postgres-data/` inside the app data folder, and its password is in `app-data/postgres-password` next to it. Always copy those two together, because the database can't be opened without its password file. Copy `app-data/secrets/` with them too (see [The secrets key](#secrets-key)). The `app-data/models/` and `app-data/maps/` folders are large and can be downloaded again, so you can leave them out.

Tools like Time Machine or File History cover both folders, as long as Lifer is quit or the backup runs while the computer is idle.

### Restore

1. Install Lifer, but don't open it yet (or quit it).
2. Copy the app data folder back to the same place.
3. Put your library folder back where it was before.
4. Open Lifer.

If the library is now in a different place, Lifer shows a "Lifer can't save photos right now" banner. Choose the new location in [Settings > Storage](../settings.md#storage-location), then restart Lifer.

### Starting fresh with only your photos

If you've lost the database, install Lifer, choose your old library folder at setup, then run **Settings > Library > Reimport library** with **Reimport my existing library**. Lifer rebuilds your photos and species from the files and restores your collected and seen status from the library.

## Moving from the desktop app to a server

You don't need a backup to move. The desktop app can upload your whole library to a server. See [Migrate your library to a server](./connect-desktop-to-server.md#migrate).
