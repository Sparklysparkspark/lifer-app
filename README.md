<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/branding/Dark%20Wordmark.png">
    <img src="./assets/branding/Wordmark.png" alt="Lifer" width="360">
  </picture>
</p>

Lifer is an open-source photo and video management and archival application built for wildlife
photographers.

It turns a collection of wildlife photos into a structured archive organized around **species,
taxonomy, locations, dates, trips, and albums**, while also maintaining your photographic life
list and regional checklists. A species only counts as "collected" once you've actually attached
your own photo of it — this isn't a sightings log.

Your photographs and videos remain on the drives you choose. Lifer provides the wildlife-specific
organization and information built around them.

![Lifer gallery](./assets/Gallery.png)

## Your wildlife collection, organized

Wildlife photography collections get hard to keep track of as they grow. Photos accumulate across
years, trips, locations, and storage drives. You might have photographed a species several times
without knowing where all of those photos are, or keep your life list somewhere entirely separate
from your actual photo archive.

Lifer brings those together. Import a batch from a shoot, a whole folder from a trip, or a photo
at a time from a species' own page — Lifer can use local AI to suggest a species for anything
still unidentified, trained against your own collection rather than a cloud service, and you
confirm or correct it in a couple keystrokes.

![Lifer import](./assets/Import.png)

Once imported, a photo belongs to a species, a trip, a location, a date, and your life list all at
once. You don't have to build those relationships by hand.

## Organize your files your way

Lifer doesn't impose a particular folder structure on your originals. Uploads land in a real,
navigable folder tree grouped by taxon and species (with a separate `RAW` folder alongside your
edited copy, linked automatically by filename and capture time) — species folders can be named
using common names, scientific names, eBird codes, ABA codes, or full taxonomy, whichever you
prefer:

```
Lifer Photos/Birds/<species name>/Adjusted/<your edited JPEG>
Lifer Photos/Birds/<species name>/RAW/<matching RAW file>
```

Your physical file organization is yours to set, and can be changed later if your preferences
change.

## From photographs to a life list

Your archive and your life list are connected. Browse checklists by region — country,
province/state, or a nearby marine zone for fish — see exactly which species you still need, and
watch photographed species join your life list automatically. Each species carries a rarity tier
(how hard it is to actually go find and photograph, not conservation status), a reference photo,
and habitat info, so you know roughly what you're looking for.

![Lifer collection](./assets/Collection%20View.png)

Checklists are meant to be personal: hide or archive species you're not pursuing so the list
reflects your own goals, not every species that could theoretically occur somewhere in the region.

## Wildlife information, downloaded once

Species packs carry the reference photos, taxonomy, distribution, and rarity info for a region —
download the ones you care about and they work fully offline afterward. Full checklist and
reference-photo coverage is live for **birds, mammals, and fish** today, with more taxonomic
groups (reptiles, amphibians, marine invertebrates, and others) being added.

![Lifer offline packs](./assets/Offline%20Packs.png)

For anything outside Lifer's curated data, species can be imported from iNaturalist instead —
insects, plants, fungi, and the rest of the iNaturalist taxonomy — and observations can be
exported back to iNaturalist when you want to contribute them.

## Everything you've shot, and what it adds up to

Browse the whole Gallery across every species, searchable by name, camera details ("600mm"), or a
natural-language description of the shot ("fox playing"). Group favorites into Albums, point Lifer
at a trip's folder without copying anything in, and check Stats for a real breakdown of your own
archive: most-photographed species, gear-and-species patterns, year-over-year comparisons.

![Lifer stats](./assets/Stats.png)

## Your files stay yours

There is no Lifer cloud service and no required account. Your photos and videos remain on the
drives you choose, including a collection spread across several external drives — common for a
photographer before they consolidate. Lifer tracks which drive each photo lives on and still shows
a thumbnail when that drive is unplugged, so you always know which one to go grab rather than
needing every drive connected just to browse.

Species and taxonomy get written into your actual files, not hidden away in a Lifer-only database:
a flat keyword list (common name, scientific name, eBird/ABA codes) plus a Lightroom/digiKam-style
hierarchical tag (`Species/Aves/Alcedinidae/Belted Kingfisher`), using the same standard IPTC/XMP
fields those tools already read. That means a collection already tagged in Lightroom or digiKam
can be recognized on import instead of asking you to identify everything again, and if you ever
stop using Lifer, pointing a fresh install at the same files rebuilds the collection from that
metadata.

## Run it your way

Lifer can run as a local desktop application (Windows, macOS, Linux) or as a self-hosted Docker
server on your own hardware — useful for a collection on a NAS, or reaching the same archive from
multiple devices. The server is entirely self-hosted; there's no Lifer-hosted service involved.

|                  | **Desktop app**                                                                        | **Server**                              |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| Where it runs    | Your own computer                                                                        | A NAS or always-on machine, via Docker  |
| Who can reach it | Just you, on that machine                                                                | Anyone with the URL and login           |
| Login            | None, although you can log into your server through the Desktop app for remote access.  | Account and password                    |
| Your photos live | On your computer, unless pointed at a server instead                                    | On that machine                         |
| Setup            | [Desktop app setup](#desktop-app-setup)                                                  | [Server setup](#server-setup-docker)    |

The desktop app can also just be a client for a server you already run: on first launch it asks
whether to use your computer's own local library, or log into a server. Switch between the two, or
push a local library up to a server, from Settings at any time.

Albums and trips can also be shared through secure links (server mode) — optional password,
expiration, and revocable download permission any time. GPS location is never exposed.

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

First launch asks you to create the one account this instance has. The species/region catalog
(Offline Packs map, checklists) is bundled into the image and restored automatically on first
start — no network wait needed. If it ever looks empty (a custom image built without network
access, say), check `docker compose logs api` for a "Catalog auto-seed failed" line, and retry
manually from Settings > Species catalog updates once network access is available.

## Desktop app setup

Download the installer for your OS from the [latest release](../../releases/latest), no
build step:

- **macOS**: the `.zip` (Apple Silicon only for now, Intel Macs aren't built yet; unzip and drag `Lifer.app` to Applications)
- **Windows**: the `.exe` installer
- **Linux**: the `.AppImage` (run directly) or `.deb` (Debian/Ubuntu)

Local/offline mode is fully self-contained: the app manages its own embedded Postgres
database automatically, no separate install or Docker needed.

First launch asks:
- **Use this computer's own library**: pick a folder for your photos, then run entirely
  locally. No login, no account.
- **Connect to a server**: enter a server URL and log in, same as opening it in a browser,
  just in a native window.

Switch later from **Settings → App connection**, or push a local library up to a server from
**Settings → Migrate to a server**.

The desktop build isn't signed with a paid Apple/Microsoft developer certificate, so the OS will
warn on first launch: Windows shows "Windows protected your PC" (click **More info → Run
anyway**); macOS blocks it outright (System Settings → Privacy & Security → **Open Anyway**). This
repeats on every new version, not just once — for the same reason, the in-app auto-updater's
install step can fail on macOS specifically (it falls back to a manual-download link when that
happens).

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

## Status

Lifer is currently in beta. It's actively developed, and some features and interfaces may change
before the first stable release. Bug reports and feedback are welcome through GitHub Issues and
Discussions.

## Contributing

Working on Lifer itself, not just running it? See [CONTRIBUTING.md](./CONTRIBUTING.md) for local
setup (Postgres, migrations, seeding, running the dev servers).

## License

[AGPL-3.0](./LICENSE).
