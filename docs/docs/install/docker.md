---
title: Install with Docker
description: Run Lifer as a self-hosted server on a NAS or always-on computer with Docker Compose.
---

# Install with Docker

Run Lifer on a NAS or any always-on computer, and reach it from a browser or the desktop app on any device. You need Docker with Docker Compose. You don't need to download the source code.

The server runs as two containers: Lifer itself (image `ghcr.io/sparklysparkspark/lifer-app`, for 64-bit Intel/AMD and ARM) and a Postgres database. Check the [requirements](./requirements.md) first.

## Install

1. Make two folders on your server: one for your photo library and one for Lifer's own files, for example `/mnt/tank/photos` and `/mnt/tank/apps/lifer`.
2. Make them writable by user and group `568`, which Lifer runs as (the same `apps` user TrueNAS uses):

   ```bash
   sudo chown -R 568:568 /mnt/tank/photos /mnt/tank/apps/lifer
   ```

   To run Lifer as a different user instead, see [File ownership](#file-ownership).
3. Save this as `docker-compose.yml` in a folder of its own, and replace everything in `<angle brackets>`:

   ```yaml
   services:
     postgres:
       image: postgres:18-alpine
       restart: unless-stopped
       # Time to finish writing on shutdown, and enough shared memory for large queries.
       stop_grace_period: 1m
       shm_size: 256mb
       environment:
         POSTGRES_USER: lifer
         POSTGRES_DB: lifer
         # Letters and numbers only; it's also in DATABASE_URL below. Postgres reads it once,
         # when it creates the database.
         POSTGRES_PASSWORD: <database-password>
       volumes:
         - <lifer-folder>/postgres:/var/lib/postgresql
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U lifer -d lifer"]
         interval: 2s
         timeout: 3s
         retries: 30

     api:
       # "release" is the newest stable version. Use a version number, like 0.9.1, to update
       # only when you choose.
       image: ghcr.io/sparklysparkspark/lifer-app:release
       restart: unless-stopped
       init: true
       depends_on:
         postgres:
           condition: service_healthy
       environment:
         DATABASE_URL: postgres://lifer:<database-password>@postgres:5432/lifer
         NODE_ENV: production
         PORT: 4000
         DATA_DIR: /data
         APP_DATA_DIR: /app-data
       ports:
         - "4000:4000"
       volumes:
         # Your photo library.
         - <photo-library-folder>:/data
         # Lifer's own files: previews, the offline map, models, downloads.
         - <lifer-folder>/app-data:/app-data
   ```

4. Start Lifer from that folder:

   ```bash
   docker compose up -d
   ```

   This downloads the ready-made image. Nothing is built on your server.
5. Open `http://<server-ip>:4000` in a browser, using your server's LAN IP address, and [create your account](#first-account).

That's the whole setup. Every other setting has a sensible default; the ones you might want later are in [Environment variables](./environment-variables.md), and they go under `environment:` in the same file.

On a NAS with a Docker interface (a TrueNAS Custom App, Portainer Stacks, Synology Container Manager, or Unraid's Compose Manager plugin), paste the file from step 3 into it, with your folders and password filled in. You don't need a terminal.

### Alternative: the repository's compose file with a `.env` file {#env-setup}

The repository has a fuller [`docker-compose.yml`](https://raw.githubusercontent.com/Sparklysparkspark/lifer-app/main/docker-compose.yml) that reads its settings from a [`.env`](https://raw.githubusercontent.com/Sparklysparkspark/lifer-app/main/.env.example) file (rename `.env.example` to `.env`). It adds three things the file above leaves out:

- a `permissions` step that makes the library folder writable for you, with `PUID` and `PGID` choosing the user (see [File ownership](#file-ownership));
- the automatic move of a database from Lifer 0.9.0 or earlier to Postgres 18 (see [Upgrading](./upgrading.md#postgres-18)), for installs that used its named volumes;
- every optional setting listed, so you can change one by editing `.env`.

In `.env`, set `LIFER_STORAGE_DIR` to your photo library folder and `DB_PASSWORD` to a database password before the first start, then run `docker compose up -d`.

Nothing else needs setting up. Lifer works out whether you reached it over plain `http://` or HTTPS on its own, for every request.

Lifer serves the web app and its API on one port (`PORT`, `4000` by default). For HTTPS or a domain name, put a reverse proxy in front. See [Reverse proxy and HTTPS](./reverse-proxy.md).

## Create the first account {#first-account}

A Lifer server has exactly one account, and whoever opens Lifer first creates it. Do this right after you start the server, before you make it reachable from outside your home network.

1. Open Lifer in a browser. It shows a setup form instead of a login.
2. Enter your **Email**, a **Password** (at least 8 characters), and **Confirm password**.
3. Click **Make account**.

There's no setup code or invite to enter: the first person to reach the form gets the account. After the account exists, the setup form is gone for good. If you ever forget the password, see [Reset a forgotten password](../troubleshooting.md#forgot-password).

Lifer then walks you through a short first-run setup. See [Getting started](../getting-started.md#server).

## Volumes {#volumes}

The compose file stores data in three places:

| Inside the container | On your server | What it holds |
|---|---|---|
| `/data` | Your photo library folder (`LIFER_STORAGE_DIR` with `.env`) | **Your photo library.** `Birds`, `Mammals` and other folders go directly in here. |
| `/app-data` | `<lifer-folder>/app-data` (Docker volume `lifer-app-data` with `.env`) | Lifer's own files: thumbnails and preview images of your photos, the offline map, species-matching models, and catalog downloads. Lifer can download or rebuild all of it, but a lost volume means a slow rebuild. |
| `/var/lib/postgresql` (in the `postgres` container) | `<lifer-folder>/postgres` (Docker volume `lifer-db` with `.env`) | The database: your species assignments, ratings, tags, albums, trips and settings. |

Your photos and the database are what you must [back up](./backup-restore.md).

With the `.env` setup, servers installed with Lifer 0.9.0 or earlier also have a volume `lifer-postgres-data`, the old Postgres 16 database. Lifer reads it once, read-only, to [move it to Postgres 18](./upgrading.md#postgres-18), and you can remove it afterwards. On a new install it stays empty.

:::note The database isn't on your network
Postgres is only reachable by Lifer, inside Docker. It doesn't use your server's port `5432`, so it won't clash with another database. To reach it yourself, go through Docker, for example `docker compose exec postgres psql -U lifer lifer`. [Backups](./backup-restore.md) work the same way.
:::

:::caution Moving the library folder
To move or rename the library folder, stop Lifer first (`docker compose down`), move the folder, update its path in `docker-compose.yml` (or `LIFER_STORAGE_DIR` in `.env`), then start Lifer again. Moving it while Lifer runs makes every upload fail until Lifer restarts.
:::

The species catalog is built into the image, so a new server shows countries and checklists right away, even without internet access.

## File ownership {#file-ownership}

Lifer doesn't run as root. It runs as user and group `568` (the same `apps` user TrueNAS uses), and every file it creates in your library belongs to that user.

With the single-file setup, the folders you mount must be writable by that user, which step 2 of [Install](#install) does. To run Lifer as your own account instead, add `user: "1000:1000"` under `api:` with your own numbers (run `id` on the server to see them), and give the folders to that user.

With the [`.env` setup](#env-setup), `PUID` and `PGID` in `.env` choose the user, and each time you run `docker compose up`, a short-lived `permissions` container runs first, as root. It creates the library folder and the `lifer-app-data` volume if they're missing, then:

- gives everything in the `lifer-app-data` volume to `PUID:PGID`, since those are Lifer's own files;
- gives the top of your library folder to `PUID:PGID`, so Lifer can create folders in it;
- once, the first time you start Lifer 0.9.0 or newer, gives `PUID:PGID` any files in the library that belong to root. Versions before 0.9.0 ran as root, so this lets Lifer manage the photos it saved back then.

It never changes library files that belong to anyone else, such as files written by an SMB share, Syncthing or another app. Make sure the `PUID` user can read those, and write to them if Lifer should rename or tag them. Lifer starts once the `permissions` container has finished. Its log shows what it did:

```bash
docker compose logs permissions
```

To have Lifer's files belong to your own account instead, set `PUID` and `PGID` to its numbers (run `id` on the server to see them), then run `docker compose up -d` again. Files Lifer already wrote keep their old owner, so change them yourself, for example with `sudo chown -R 1000:1000 /mnt/photos/lifer`.

## Database password {#db-password}

The database password is `POSTGRES_PASSWORD` in the single-file setup, repeated in `DATABASE_URL`, or `DB_PASSWORD` in `.env`, which defaults to `lifer`. The database can't be reached from your network either way (see [Volumes](#volumes)), but a password of your own is still better.

Postgres only reads the password when it creates the database, on the very first start. Changing it in the file later doesn't change the database's password, and Lifer then can't connect. To change it on an existing install, change it inside Postgres first, then in the file:

```bash
docker compose exec postgres psql -U lifer -c "ALTER USER lifer PASSWORD 'new-password'"
# then put new-password in POSTGRES_PASSWORD and DATABASE_URL (or DB_PASSWORD in .env), and:
docker compose up -d
```

Folders you add under [Extra library folders](#extra-library-folders) aren't changed. Make sure the `PUID` user can read them, and write to them if Lifer should save photos there.

## Extra library folders {#extra-library-folders}

On a server, Lifer can only read and write folders you give it. Besides `/data`, you can add more, for example an existing photo archive on another disk. Lifer can then import from them, build [trips](../guides/trips.md) from them, and save photos to them.

1. Mount each folder into the `api` container. In `docker-compose.yml`, under `api:` > `volumes:`, add a line like:

   ```yaml
         - /srv/nas/photos:/library/nas
   ```

2. List it with a label, under `api:` > `environment:`:

   ```yaml
         LIFER_LIBRARY_ROOTS: NAS=/library/nas
   ```

   With the `.env` setup, put `LIFER_LIBRARY_ROOTS=NAS=/library/nas` in `.env` instead.

   Separate several with commas: `NAS=/library/nas,Archive=/library/archive`.
3. Run `docker compose up -d` again.

The folders show up in **Settings > Storage > Library folders**. Anything outside `/data` and these folders is refused.

All the settings are listed in [Environment variables](./environment-variables.md).

## GPU (optional) {#gpu}

Lifer can use an NVIDIA, Intel or AMD graphics card to match species faster. It tests the GPU by itself and only uses it when it's faster, so all you do is pass it into the container. The compose file has the lines ready to uncomment. See [GPU acceleration](./hardware-acceleration.md).

## Updating {#updating}

Lifer doesn't update itself on a server. You choose when to update:

1. [Back up the database](./backup-restore.md#back-up-the-database). Updates can change the database, and there's no way back to an older version afterwards.
2. Read the [release notes](https://github.com/Sparklysparkspark/lifer-app/releases) for anything you need to do.
3. From the folder with `docker-compose.yml`, run:

   ```bash
   docker compose pull
   docker compose up -d
   ```

Lifer applies any database changes by itself when it starts. The web app shows a banner when a newer release exists.

Coming from Lifer 0.9.0 or earlier:

- **With the repository's compose file and `.env`:** download the new `docker-compose.yml` first. The database moves to Postgres 18 by itself on that first start. See [Moving the database to Postgres 18](./upgrading.md#postgres-18).
- **With your own compose file** that still uses `postgis/postgis:16-3.4-alpine`: keep that image for now. Lifer works with it. Don't just change it to `postgres:18-alpine`: Postgres 18 can't open a Postgres 16 database folder. To move, [back up the database](./backup-restore.md#back-up-the-database), switch to the setup above with a new, empty database folder, and [restore](./backup-restore.md) into it.

See [Upgrading](./upgrading.md) for choosing a version, rolling back, and auto-updaters.
## Admin commands

The image includes `lifer-admin` for tasks you do from a shell inside the container:

```bash
docker compose exec api lifer-admin list-users
docker compose exec api lifer-admin reset-password
```

`reset-password` asks for the new password twice, without showing it. It also signs out every device that was logged in.

If you run Lifer as a Custom App on TrueNAS, you can also open the app's **Shell** in the TrueNAS web interface and type `lifer-admin` commands directly.

## Server logs

```bash
docker compose logs -f api
```

See [Troubleshooting](../troubleshooting.md#logs) for log lines worth knowing.
