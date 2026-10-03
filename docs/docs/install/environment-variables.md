---
title: Environment variables
description: Every setting a Lifer server reads from its environment, with defaults.
---

# Environment variables

A Lifer server is configured with environment variables. With Docker, you put them in the `.env` file next to `docker-compose.yml`. Everything has a sensible default. On most installs you only set `LIFER_STORAGE_DIR`, and maybe `PORT`. Lifer works out on its own whether it's reached over plain `http://` or HTTPS, and it never sends email: a forgotten password is [reset from the server's shell](../troubleshooting.md#forgot-password).

The desktop app sets all of these itself. You never need to touch them there.

:::caution Some variables need a line in docker-compose.yml
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

You rarely need to change this. See [Reverse proxy and HTTPS](./reverse-proxy.md#advanced). The login cookie is HTTPS only exactly when you reach Lifer over HTTPS, directly or through a proxy that sends `X-Forwarded-Proto`, so there's nothing to set for it.

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `TRUST_PROXY` | proxies on local networks | Yes | Which reverse proxies Lifer believes about each visitor's real IP address and whether they used HTTPS. By default it trusts proxies on the same machine or a private network (Docker, a home LAN, a local tunnel), which covers almost every setup. Set a number of hops, like `2`, for a public proxy such as Cloudflare in front of your own. Also accepts `true`, `false`, or a comma-separated list of IP addresses or ranges. |

## Uploads

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `MAX_UPLOAD_BYTES` | `0` (no limit) | Yes | The largest single file, in bytes, anyone can upload. `0` means no limit. Set it only as a safety net for a small disk, for example `53687091200` for 50 GB. An upload over the cap is refused before it starts. |
| `LIFER_MAX_IMAGE_PIXELS` | `2000000000` (2 gigapixels) | Yes | The largest photo, in pixels, Lifer will open. It guards against broken or malicious files; memory use depends on a photo's width more than its total pixels, so even very large panoramas are fine. `0` means no limit. |
| `LIFER_UPLOAD_WORK_DIR` | next to the library | Yes | Where uploads are received and kept until they're imported. By default Lifer uses the `uploads` folder in `APP_DATA_DIR` when that's on the same drive as the library, and otherwise a hidden `.lifer-uploads` folder inside the library, so filing a finished upload is a quick move rather than a second copy. Set it only if you want uploads received somewhere else, for example because that drive is short on space. Unfinished uploads are removed 2 hours after their last piece arrived. |
| `LIFER_MAX_JSON_BODY_BYTES` | `67108864` (64 MB) | Yes | The largest ordinary (non-upload) request. Uploads aren't affected by it. You shouldn't need to change it. |

Uploads are sent in resumable pieces, so there's no request-size setting to keep in step with your reverse proxy. See [Reverse proxy](./reverse-proxy.md#large-uploads).

## Storage paths inside the container

The compose file sets these for you. Change them only if you build your own setup.

| Variable | Default | In compose file | What it does |
|---|---|---|---|
| `DATABASE_URL` | `postgres://lifer:lifer@localhost:5432/lifer` | Yes | The Postgres connection string. The compose file points it at the bundled `postgres` service. Lifer needs standard Postgres 14 or newer with the `pgcrypto`, `pg_trgm` and `unaccent` extensions, which come with it. The shipped compose file happens to use a PostGIS-enabled Postgres image, which is fine. |
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
| `EMBEDDING_MODEL_URL` | CLIP ViT-L/14 on Hugging Face | The general image model used for Gallery content search, duplicate detection, and suggestions until the identification model is installed. |
| `ID_MODEL_URL` | the `models` release on GitHub | The species identification model (BioCLIP 2) used for species suggestions. |
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
| `LIFER_INFERENCE_IN_PROCESS` | unset | Set to `1` to run the species-matching models on Lifer's main thread instead of a separate background worker. Only for debugging: the app can become unresponsive while photos are matched. |

## Rarely used

| Variable | Default | What it does |
|---|---|---|
| `LIFER_S3_BUCKET`, `LIFER_S3_REGION`, `LIFER_S3_ENDPOINT` | unset, `us-east-1`, unset | Lets photos added through the API point at objects in an S3 or S3-compatible bucket (like MinIO) instead of files on disk. The app itself doesn't use this. |
| `LIFER_ALLOW_NONCOMMERCIAL_PHOTOS` | unset | Set to `1` to also allow reference photos with non-commercial or no-derivatives Creative Commons licenses when Lifer fetches extra reference photos. By default only CC0, CC BY and CC BY-SA photos are used. |
| `SINGLE_USER_MODE` | unset | Used by the desktop app to skip login. **Never set this on a server.** Anyone who can reach the server would be signed in. Lifer refuses to start with `SINGLE_USER_MODE=1` unless it also has the desktop app's `LIFER_LAUNCH_TOKEN`, and in this mode it only listens on `127.0.0.1` and refuses requests that came through a proxy. |
| `LIFER_ALLOW_UNTOKENED_DESKTOP` | unset | For development only. Set to `1` to let `SINGLE_USER_MODE` run without the desktop app's launch token. **Never set this on a server.** |

The desktop app also sets a few internal variables (`LIFER_LAUNCH_TOKEN`, `LIFER_WATCH_PARENT_PID`, `LIFER_PG_CTL`, `LIFER_PG_DATA`, and for [matching on this computer](./connect-desktop-to-server.md#desktop-assisted-matching) `LIFER_INFERENCE_TOKEN` and `LIFER_MODEL_DIR`) to manage its background processes. They aren't meant to be set by hand.
