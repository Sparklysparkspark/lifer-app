# Lifer

Lifer is a self-hosted, species-indexed life list for wildlife photography. Instead of a
sightings log, it's photo-verified: a species only counts as "collected" once you've actually
attached your own photo of it.

Once you add photos it keeps all the files organized in an easily navigable folder structure so
that it is easy to keep track of where you put all your files (ie no more where on Earth did I
leave that raw file frantic searches across a bunch of scattered storage solutions). If your
library is spread across a few external hard drives instead of one NAS, common for photographers
before they consolidate, Lifer can track that too: it knows which drive each photo lives on and
still shows you a thumbnail even when that drive isn't plugged in, so you always know which one to
go grab.

Browse checklists by region (country, province, or a nearby marine zone for fish), see which
species you still need, and upload your photos to fill in the gaps. Each species carries a
rarity tier, a reference photo, and habitat info pulled from public sources, so you know roughly
what you're looking for and how hard it'll be to find. Everything including photos, originals,
your whole library stays on hardware you control.

The rarity tier is meant to approximate how hard it is to go find the subject to photograph, it
doesn't reflect how rare or endangered it actually is.

## Features

- **Region checklists**: browse by country, province/state, or a nearby marine zone for fish,
  and see exactly which species you still need.
- **Rarity tiers**: ranked by how hard a species actually is to get a photo of, not
  conservation status.
- **Reference photos & habitat info**: pulled from public sources, so you know roughly what
  you're looking for before you go find it.
- **Organized photo library**: uploads land in a real `<species>/Adjusted` (and `RAW`, if you
  add one) folder structure on disk, so your library stays usable outside Lifer too.
- **Multiple drives, one library** (desktop app): register the external hard drives your photo
  library is already spread across; Lifer remembers which drive each photo is on and still shows
  a thumbnail when that drive is unplugged, so you never have to guess which one to reconnect.
  When you're ready to consolidate onto a single drive or a NAS, move everything over from
  Settings in one step.
- **RAW matching**: add a RAW alongside its edited JPEG, or separately, and Lifer links them
  by filename and timestamp automatically.
- **Trips**: point Lifer at a folder of photos from a trip without importing or copying
  anything; it references the files right where they are, and picks up new photos (and their
  matching RAWs) automatically on a rescan.
- **Offline reference packs**: download a region's reference photos and habitat data ahead of
  time, with pack recommendations for whatever species you're still missing, so the app stays
  useful without a live connection.
- **Archive**: hide species you don't care about photographing from your checklist and counts,
  without losing any history; unarchive any time.
- **Gallery**: every photo you've taken, across every species, in one browsable, sortable grid.

Full checklist and reference-photo coverage is live for **birds, mammals, and fish** today, with
more taxonomic groups (reptiles, amphibians, marine invertebrates, and others) being added.

## Which one do you want?

Same app, two ways to run it:

|                  | **Server**                             | **Desktop app**                                                                        |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| Where it runs    | A NAS or always-on machine, via Docker | Your own computer                                                                      |
| Who can reach it | Anyone with the URL and login          | Just you, on that machine                                                              |
| Login            | Account and password                   | None, although you can login to your server through the Desktop app for remote access. |
| Your photos live | On that machine                        | On your computer, unless pointed at a server instead                                   |
| Setup            | [Server setup](#server-setup-docker)   | [Desktop app setup](#desktop-app-setup)                                                |

The desktop app can also just be a client for a server you already run: on first launch it
asks whether to use your computer's own local library, or log into a server. Switch between
the two, or push a local library up to a server, from Settings at any time.

## Server setup (Docker)

No source checkout needed, just two files and a running Docker.

1. Download [`docker-compose.yml`](./docker-compose.yml) and [`.env.example`](./.env.example)
   into a folder on your NAS or server, and rename `.env.example` to `.env`.
2. Edit `.env`, set at least `APP_URL` (see [Environment variables](#environment-variables)).
3. Start it:
   ```bash
   docker compose up -d
   ```
   This pulls the prebuilt image from `ghcr.io`; nothing is built locally. On a NAS with a
   Docker/Compose UI (TrueNAS Custom App, Portainer Stacks, Synology Container Manager, Unraid's
   Compose Manager plugin), paste the same `docker-compose.yml` in there instead, no terminal
   needed at all.

The API serves the built web app on one port (`PORT` in `.env`, `4000` by default). Put a
reverse proxy in front for TLS/a domain; that's configured on your end, not part of this repo.

First launch asks you to create the one account this instance has.

## Desktop app setup

Download the installer for your OS from the [latest release](../../releases/latest), no
build step:

- **macOS**: the `.zip` (Apple Silicon only for now, Intel Macs aren't built yet; unzip and drag `Lifer.app` to Applications)
- **Windows**: the `.exe` installer
- **Linux**: the `.AppImage` (run directly) or `.deb` (Debian/Ubuntu)

Local/offline mode still needs a reachable Postgres, either `docker compose up postgres` from
a downloaded `docker-compose.yml` (see above), or any Postgres 16+ with PostGIS enabled.

First launch asks:
- **Use this computer's own library**: pick a folder for your photos, then run entirely
  locally. No login, no account.
- **Connect to a server**: enter a server URL and log in, same as opening it in a browser,
  just in a native window.

Switch later from **Settings → App connection**, or push a local library up to a server from
**Settings → Migrate to a server**.

The desktop build isn't code-signed, so the OS will warn on first launch: Windows shows
"Windows protected your PC" (click **More info → Run anyway**); macOS blocks it outright (System
Settings → Privacy & Security → **Open Anyway**). This repeats on every new version, not just once.

## Environment variables

Only `DATABASE_URL` is close to required; everything else has a default. Set these in `.env`
for Docker.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://lifer:lifer@localhost:5432/lifer` | Postgres connection string. |
| `PORT` | `4000` | Port the server listens on. |
| `LIFER_STORAGE_DIR` | `./data/lifer` | Host path for your photo library: an external drive, a NAS mount, wherever. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | unset | Outgoing mail for password-reset links. Unset, the reset link is just logged to the server console instead. |
| `APP_URL` | `http://localhost:$PORT` | The address you actually reach this instance at (e.g. `http://192.168.1.50:4000`, or your domain), used in password-reset emails. Set this; the default only works for the machine running the server. |
| `MAX_UPLOAD_BYTES` | 2GB | Per-file upload size ceiling. |

## License

[AGPL-3.0](./LICENSE).
