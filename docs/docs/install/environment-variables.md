---
title: Environment variables
description: Every setting a Lifer server reads from its environment, with defaults.
---

# Environment variables

A Lifer server is configured with environment variables. Everything has a sensible default: the [single-file setup](./docker.md#install) needs only the database address and the two folders. With Docker, a variable goes under the `api` service's `environment:` in `docker-compose.yml`, or, with the [`.env` setup](./docker.md#env-setup), in `.env`. Lifer works out on its own whether it's reached over plain `http://` or HTTPS, and it never sends email: a forgotten password is [reset from the server's shell](../troubleshooting.md#forgot-password).

The desktop app sets all of these itself. You never need to touch them there.

:::caution With the `.env` setup, some variables need a line in docker-compose.yml
Docker Compose only passes a variable into the container if it's listed under the `api` service's `environment:` section. The shipped `docker-compose.yml` lists the ones marked **In compose file: Yes** below, so for those you just set the value in `.env` and run `docker compose up -d` again.

For any other variable, add a line yourself, for example:

```yaml
services:
  api:
    environment:
      # ...the existing lines...
      MAX_UPLOAD_BYTES: ${MAX_UPLOAD_BYTES:-}
```

Then set the value in `.env` and run `docker compose up -d` again.

A variable that's present but empty (like `LIFER_LIBRARY_ROOTS=` in the shipped `.env`) counts as unset, so Lifer uses its default.
:::

## Docker Compose settings {#compose}

These are read by the repository's `docker-compose.yml` itself, not by Lifer, so they only apply to the [`.env` setup](./docker.md#env-setup). Set them in `.env`.

| Variable | Default | What it does |
|---|---|---|
| `LIFER_VERSION` | `release` | Which Lifer image to run. `release` is the newest stable version. Set a version like `0.9.1` to stay on it, or a minor line like `0.9` to get only that line's fixes. See [Upgrading](./upgrading.md#pin). |
| `DB_PASSWORD` | `lifer` | The database password. The compose file gives it to the `postgres` container and puts it in `DATABASE_URL`. Use letters and numbers only. Postgres only reads it when the database is first created, so set it before the first start. See [Database password](./docker.md#db-password) to change it later. |
| `LIFER_SKIP_DB_UPGRADE` | `0` | Set to `1` to start without moving a Postgres 16 database from Lifer 0.9.0 or earlier into the new Postgres 18 one, for example to start fresh or restore a backup yourself. See [Moving the database to Postgres 18](./upgrading.md#postgres-18). |
| `RENDER_GROUP_ID` | `107` | Intel or AMD GPUs only, with `hwaccel.yml`: the server's `render` group number, so Lifer can open the GPU. See [GPU acceleration](./hardware-acceleration.md#intel-and-amd). |

## The common ones

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `PORT` | `4000` | Yes | The port Lifer listens on. The compose file publishes the same port on the host. |
| `LIFER_STORAGE_DIR` | `./data/lifer` | Yes (as the `/data` volume) | The folder on the host that holds your photo library. It can be an external drive or a NAS share. Docker mounts it at `/data` inside the container. Lifer creates it if it's missing. |
| `PUID` | `568` | Yes (as the `api` user) | The user ID Lifer runs as. Lifer never runs as root. On each start the `permissions` step gives the library and app data to this user. See [File ownership](./docker.md#file-ownership). |
| `PGID` | `568` | Yes (as the `api` group) | The group ID Lifer runs as, paired with `PUID`. |
| `LIFER_LIBRARY_ROOTS` | empty | Yes | Extra folders Lifer may import from, build trips from, and save photos to, besides the library. A comma-separated list of `Label=/container/path` entries (or just `/container/path`, which uses the folder name as the label). Each one must also be mounted as a volume. See [Extra library folders](./docker.md#extra-library-folders). |
| `LIFER_FREEZE_RESTART_SECONDS` | `120` | Yes | If the server stops responding for this many seconds, it writes what it was doing to the log and restarts itself. Needs `restart: unless-stopped`, which the compose file has. `0` keeps only the log warning and never restarts. |

## Security and reverse proxies

Only needed behind a reverse proxy. See [Reverse proxy and HTTPS](./reverse-proxy.md#trust-proxy). The login cookie is HTTPS only exactly when you reach Lifer over HTTPS, directly or through a proxy that sends `X-Forwarded-Proto`, so there's nothing to set for it.

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `TRUST_PROXY` | unset (no proxy trusted) | Yes | Which reverse proxy Lifer believes about each visitor's real IP address and whether they used HTTPS. **Set it if Lifer is behind a reverse proxy**: otherwise every visitor looks like the proxy, and the login limit is shared by all of them. Give the proxy's address as Lifer sees it, like `192.168.1.5`, or a range like `172.16.0.0/12`; `loopback` for a proxy on the same machine outside Docker; or a number of hops, like `2`, for a public proxy such as Cloudflare in front of your own. Also accepts `true`, `false`, or a comma-separated list. See [Reverse proxy and HTTPS](./reverse-proxy.md#trust-proxy). Earlier versions trusted any proxy on a private network by default; see the reverse proxy page if you relied on that. |

## Uploads

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `MAX_UPLOAD_BYTES` | `0` (no limit) | Yes | The largest single file, in bytes, anyone can upload. `0` means no limit. Set it only as a safety net for a small disk, for example `53687091200` for 50 GB. An upload over the cap is refused before it starts. |
| `LIFER_MAX_IMAGE_PIXELS` | `2000000000` (2 gigapixels) | Yes | The largest photo, in pixels, Lifer will open. It guards against broken or malicious files; memory use depends on a photo's width more than its total pixels, so even very large panoramas are fine. `0` means no limit. |
| `LIFER_UPLOAD_WORK_DIR` | next to the library | Yes | Where uploads are received and kept until they're imported. By default Lifer uses the `uploads` folder in `APP_DATA_DIR` when that's on the same drive as the library, and otherwise a hidden `.lifer-uploads` folder inside the library, so filing a finished upload is a quick move rather than a second copy. Set it only if you want uploads received somewhere else, for example because that drive is short on space. Unfinished uploads are removed 2 hours after their last piece arrived. |
| `LIFER_MAX_JSON_BODY_BYTES` | `67108864` (64 MB) | Yes | The largest ordinary (non-upload) request. Uploads aren't affected by it. You shouldn't need to change it. |
| `RATE_LIMIT_PER_MINUTE` | `3000` | No | How many requests one address can make per minute before Lifer answers "too many requests" for the rest of that minute. It's generous on purpose: scrolling a large gallery makes many requests, and everyone in a household usually shares one address. `0` turns it off. Behind a reverse proxy, set `TRUST_PROXY` so each visitor is counted separately rather than all as the proxy. Sign-in has its own, much stricter limit. The desktop app doesn't use it. |

Uploads are sent in resumable pieces, so there's no request-size setting to keep in step with your reverse proxy. See [Reverse proxy](./reverse-proxy.md#large-uploads).

## Storage paths inside the container

The compose file sets these for you. Change them only if you build your own setup.

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `DATABASE_URL` | `postgres://lifer:lifer@localhost:5432/lifer` | Yes | The Postgres connection string. The compose file points it at the bundled `postgres` service, with the password from `DB_PASSWORD`. Lifer needs Postgres 16 or newer with the `pgcrypto`, `pg_trgm` and `unaccent` extensions, which come with standard Postgres. It doesn't need PostGIS. |
| `DATA_DIR` | `/data` in Docker | Yes | Where the photo library is, inside the container. |
| `APP_DATA_DIR` | `/app-data` in Docker | Yes | Where Lifer keeps its own files: thumbnails and preview images of your photos, the offline map, the species-matching models, and catalog downloads. None of it is original data: Lifer can download or rebuild it. |
| `WEB_DIST_DIR` | the built web app inside the image | No | Where the web app's files are. Only for custom builds. |
| `NODE_ENV` | `production` | Yes | Standard Node.js setting. Leave it as is. |
| `APP_VERSION` | set when the image is built | No | The version Lifer reports, used for the "newer release" banner. Leave it as is. |

## Download sources

Lifer downloads region packs, catalog updates and models from the project's GitHub releases and from Hugging Face. You'd only change these to use a mirror or for development.

| Variable | Default | What it does |
|---|---|---|
| `PACK_INDEX_URL` | the `packs-latest` release on GitHub | The list of downloadable region packs. |
| `CATALOG_MANIFEST_URL` | the `catalog-latest` release on GitHub | A small file Lifer checks to see if a newer species catalog exists. |
| `CATALOG_SEED_URL` | the `catalog-latest` release on GitHub | The species catalog itself. Docker images already include a copy, so a new server works without internet on first start. |
| `EMBEDDING_MODEL_URL` | the `models` release on GitHub | The general image model (CLIP ViT-L/14, compressed to run well on a CPU) used for Gallery content search, duplicate detection, and suggestions until the identification model is installed. |
| `EMBEDDING_MODEL_GPU_URL` | CLIP ViT-L/14 on Hugging Face | The full-precision copy of the general image model, downloaded only when Lifer moves matching onto a GPU. |
| `ID_MODEL_URL` | the `models` release on GitHub | The species identification model (BioCLIP 2) used for species suggestions. |
| `ID_MODEL_GPU_URL` | the `models` release on GitHub | The full-precision copy of the identification model, downloaded only when Lifer moves matching onto a GPU. See [One-time downloads for NVIDIA](./hardware-acceleration.md#nvidia-downloads). |
| `MAP_DOWNLOAD_URL` | the `map-latest` release on GitHub | Where to download the offline basemap from. Only needed to use a different map file. |

These are all unset in the shipped compose file, so add them under `environment:` if you use them.

## Performance

You rarely need these. The defaults suit a typical home server.

| Variable | Default | What it does |
|---|---|---|
| `PG_POOL_MAX` | `20` | The most database connections Lifer opens at once. Lower it if your Postgres is shared and short on connections. |
| `LIFER_VECTOR_CACHE_MB` | `128` | How much memory, in MB, Lifer uses to keep your own photos' matching data in memory. It speeds up species suggestions, duplicate checks and Gallery content search. Raise it for a very large library on a server with memory to spare. |
| `INAT_MIN_HOST_INTERVAL_MS` | `1000` | The shortest gap, in milliseconds, between requests Lifer sends to iNaturalist while filling in species details. Raise it (for example to `2500`) if iNaturalist starts limiting your server. |
| `LIFER_GPU` | unset (automatic) | Set to `off` to keep species matching on the CPU even when a GPU is available. Only for troubleshooting: by default Lifer uses a GPU only when it gives the same results and is faster. Already listed in the compose file. See [GPU acceleration](./hardware-acceleration.md). |
| `LOG_LEVEL` | `info` | How much the server logs: `error`, `warn`, `info`, `debug` or `trace`. Use `debug` when troubleshooting, then set it back. |
| `LIFER_INFERENCE_IN_PROCESS` | unset | Set to `1` to run the species-matching models on Lifer's main thread instead of a separate background worker. Only for debugging: the app can become unresponsive while photos are matched. |

## Rarely used

| Variable | Default | What it does |
|---|---|---|
| `LIFER_S3_BUCKET`, `LIFER_S3_REGION`, `LIFER_S3_ENDPOINT` | unset, `us-east-1`, unset | Lets photos added through the API point at objects in an S3 or S3-compatible bucket (like MinIO) instead of files on disk. The app itself doesn't use this. |
| `SINGLE_USER_MODE` | unset | Used by the desktop app, which has no login: the app's own window is signed in with the per-launch secret `LIFER_LAUNCH_TOKEN` instead. **Never set this on a server.** Lifer refuses to start with `SINGLE_USER_MODE=1` unless it also has `LIFER_LAUNCH_TOKEN`, and in this mode it only listens on `127.0.0.1` and refuses requests that came through a proxy. |
| `INAT_CLIENT_ID` | unset | The client ID of an iNaturalist application you registered at [inaturalist.org/oauth/applications](https://www.inaturalist.org/oauth/applications), for linking an iNaturalist account. That feature is still [coming soon](../guides/inaturalist.md#observations). A client ID saved in Settings takes priority over this. |
| `INAT_REDIRECT_URI` | the address you opened Lifer at, plus `/api/inaturalist/callback` | The address iNaturalist sends you back to after you link your account. It must match the one registered with your iNaturalist application. A redirect URI saved in Settings takes priority over this. |
| `LIFER_ALLOW_UNTOKENED_DESKTOP` | unset | For development only. Set to `1` to let `SINGLE_USER_MODE` run without the desktop app's launch token; every request on `127.0.0.1` is then signed in as the local user, with no credential. **Never set this on a server.** |

The desktop app also sets a few internal variables (`LIFER_LAUNCH_TOKEN`, `LIFER_LAUNCH_ID`, `LIFER_WATCH_PARENT_PID`, `LIFER_PG_CTL`, `LIFER_PG_DATA`, and for [matching on this computer](./connect-desktop-to-server.md#desktop-assisted-matching) `LIFER_INFERENCE_TOKEN` and `LIFER_MODEL_DIR`) to manage its background processes. They aren't meant to be set by hand.
