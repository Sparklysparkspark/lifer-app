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
| App data | Thumbnails and preview images, downloaded models, the offline map and catalog downloads. | Docker: the `lifer-app-data` volume. Desktop: the app data folder. Optional: Lifer downloads or rebuilds all of it, but rebuilding thumbnails for a big library takes a while. |

You don't need to back up the upload work folder (`uploads` in the app data folder, or a hidden `.lifer-uploads` folder inside the library). It only holds files on their way in, and Lifer clears it out by itself.

Downloaded region packs can also be downloaded again from [Offline packs](../guides/offline-packs-and-map.md).

:::tip Your files carry a safety net
Lifer writes each photo's species and rating into the file itself (or an `.xmp` sidecar next to a RAW), and keeps small recovery records in `.lifer` folders inside the library: your collected and seen status (`.lifer/collection-state.json`), which albums each photo is in, and the species of photos in trip folders. So even with only the photo library, **Settings > Library > Reimport library** can rebuild most of your collection. Settings, hidden and archived species, share links, API keys and your account aren't in the files, so they need the database backup.
:::

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

### Restore

1. Put the photo library back in the `LIFER_STORAGE_DIR` folder. It doesn't matter which user owns the restored files: the `permissions` step gives them to Lifer's user when Lifer starts.
2. Start only the database, with an empty volume:

   ```bash
   docker compose down
   docker volume rm lifer_lifer-postgres-data   # only if you're replacing an existing database
   docker compose up -d postgres
   ```

   The volume name starts with your project folder's name. Run `docker volume ls` to check it.
3. Load the backup:

   ```bash
   docker compose exec -T postgres psql -U lifer lifer < lifer-db-2026-09-25.sql
   ```

   A message that the `postgis` extension already exists is harmless.
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

The database is in `app-data/postgres-data/` inside the app data folder, and its password is in `app-data/postgres-password` next to it. Always copy those two together, because the database can't be opened without its password file. The `app-data/models/` and `app-data/maps/` folders are large and can be downloaded again, so you can leave them out.

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
