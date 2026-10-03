---
title: Install with Docker
description: Run Lifer as a self-hosted server on a NAS or always-on computer with Docker Compose.
---

# Install with Docker

Run Lifer on a NAS or any always-on computer, and reach it from a browser or the desktop app on any device. You need Docker with Docker Compose. You don't need to download the source code.

The server runs as two containers: Lifer itself (image `ghcr.io/sparklysparkspark/lifer-app`, for 64-bit Intel/AMD and ARM) and a Postgres database. A short-lived `permissions` container runs before Lifer starts (see [File ownership](#file-ownership)), and an optional Watchtower container keeps Lifer updated.

## Install

1. Make a folder for Lifer on your server, for example `~/lifer`.
2. Download these two files into it:
   - [`docker-compose.yml`](https://raw.githubusercontent.com/Sparklysparkspark/lifer-app/main/docker-compose.yml)
   - [`.env.example`](https://raw.githubusercontent.com/Sparklysparkspark/lifer-app/main/.env.example), then rename it to `.env`
3. Open `.env` in a text editor and set:
   - `LIFER_STORAGE_DIR` to the folder on the server where your photos should live, like `/mnt/photos/lifer`. Lifer creates it if it doesn't exist.
   - Optionally `PUID` and `PGID`, the user and group Lifer runs as. See [File ownership](#file-ownership).
4. Start Lifer:

   ```bash
   docker compose up -d
   ```

   This downloads the ready-made image. Nothing is built on your server.
5. Open `http://<server-ip>:4000` in a browser, using your server's LAN IP address, and [create your account](#first-account).

On a NAS with a Docker interface (TrueNAS Custom App, Portainer Stacks, Synology Container Manager, or Unraid's Compose Manager plugin), paste the contents of `docker-compose.yml` into it and set the same variables there. You don't need a terminal.

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
| `/data` | The folder in `LIFER_STORAGE_DIR` | **Your photo library.** `Birds`, `Mammals` and other folders go directly in here. |
| `/app-data` | Docker volume `lifer-app-data` | Lifer's own files: thumbnails and preview images of your photos, the offline map, species-matching models, and catalog downloads. Lifer can download or rebuild all of it, but a lost volume means a slow rebuild. |
| `/var/lib/postgresql/data` (in the `postgres` container) | Docker volume `lifer-postgres-data` | The database: your species assignments, ratings, tags, albums, trips and settings. |

Your photos and the database are what you must [back up](./backup-restore.md).

:::note The database isn't on your network
Postgres is only reachable by Lifer, inside Docker. It doesn't use your server's port `5432`, so it won't clash with another database. To reach it yourself, go through Docker, for example `docker compose exec postgres psql -U lifer lifer`. [Backups](./backup-restore.md) work the same way.
:::

:::caution Moving the library folder
To move or rename the library folder, stop Lifer first (`docker compose down`), move the folder, update `LIFER_STORAGE_DIR` in `.env`, then start Lifer again. Moving it while Lifer runs makes every upload fail until Lifer restarts.
:::

The species catalog is built into the image, so a new server shows countries and checklists right away, even without internet access.

## File ownership {#file-ownership}

Lifer doesn't run as root. It runs as the user and group in `PUID` and `PGID` in `.env`, `568` by default (the same `apps` user TrueNAS uses). Every file Lifer creates in your library belongs to that user.

Each time you run `docker compose up`, a short-lived `permissions` container runs first, as root. It creates the library folder and the `lifer-app-data` volume if they're missing, and gives them to `PUID:PGID`. It only changes files that belong to someone else, so on a normal start it changes nothing. Lifer starts once it has finished. Its log shows what it did:

```bash
docker compose logs permissions
```

To have Lifer's files belong to your own account instead, set `PUID` and `PGID` to its numbers (run `id` on the server to see them), then run `docker compose up -d` again.

Folders you add under [Extra library folders](#extra-library-folders) aren't changed. Make sure the `PUID` user can read them, and write to them if Lifer should save photos there.

## Extra library folders {#extra-library-folders}

On a server, Lifer can only read and write folders you give it. Besides `/data`, you can add more, for example an existing photo archive on another disk. Lifer can then import from them, build [trips](../guides/trips.md) from them, and save photos to them.

1. Mount each folder into the `api` container. In `docker-compose.yml`, under `api:` > `volumes:`, add a line like:

   ```yaml
         - /srv/nas/photos:/library/nas
   ```

2. In `.env`, list it with a label:

   ```ini
   LIFER_LIBRARY_ROOTS=NAS=/library/nas
   ```

   Separate several with commas: `NAS=/library/nas,Archive=/library/archive`.
3. Run `docker compose up -d` again.

The folders show up in **Settings > Storage > Library folders**. Anything outside `/data` and these folders is refused.

All the settings are listed in [Environment variables](./environment-variables.md).

## GPU (optional) {#gpu}

Lifer can use an NVIDIA, Intel or AMD graphics card to match species faster. It tests the GPU by itself and only uses it when it's faster, so all you do is pass it into the container. The compose file has the lines ready to uncomment. See [GPU acceleration](./hardware-acceleration.md).

## Updating {#updating}

**Automatic:** the compose file includes Watchtower. It checks for a new Lifer image every hour and restarts Lifer on it. It only updates Lifer, never the database. If you'd rather update by hand, delete the `watchtower` service from `docker-compose.yml`.

**By hand:** from the folder with `docker-compose.yml`, run:

```bash
docker compose pull
docker compose up -d
```

Lifer applies any database changes by itself when it starts. The web app shows a banner when a newer release exists.

To stay on a specific version, change `ghcr.io/sparklysparkspark/lifer-app:latest` in `docker-compose.yml` to a version tag like `:v0.8.2`.

## Admin commands

The image includes `lifer-admin` for tasks you do from a shell inside the container:

```bash
docker compose exec api lifer-admin list-users
docker compose exec api lifer-admin reset-password
```

`reset-password` asks for the new password twice, without showing it. It also signs out every device that was logged in.

On TrueNAS you can also open **Apps > Lifer > Shell** and type the commands directly.

## Server logs

```bash
docker compose logs -f api
```

See [Troubleshooting](../troubleshooting.md#logs) for log lines worth knowing.
