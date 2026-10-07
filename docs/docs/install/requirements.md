---
title: Requirements
description: What you need to run Lifer as a desktop app or a Docker server, including memory, disk space and an optional GPU.
---

# Requirements

Lifer runs as a [desktop app](./desktop.md) or a [Docker server](./docker.md). Here's what each needs.

## Desktop app

| Computer | Supported |
|---|---|
| Mac with Apple Silicon (M1 or newer) | Yes, macOS 14 (Sonoma) or later |
| Mac with an Intel processor | Yes, macOS 14 (Sonoma) or later (`Lifer-macos-x64.zip`) |
| Windows, 64-bit Intel or AMD (x64) | Yes |
| Linux, 64-bit Intel or AMD (x64) | Yes, as a `.deb` (Debian, Ubuntu and similar) or an AppImage |
| Windows or Linux on ARM | Not yet |

The desktop app works offline from the first launch: its database engine and the species catalog come with it. The internet is only needed for optional downloads such as offline packs, the map and species-matching models.

## Docker server

- **Docker** with Docker Compose (the `docker compose` command).
- **A 64-bit processor**: Intel or AMD (`amd64`), or ARM (`arm64`), such as a Raspberry Pi 4 or 5 running a 64-bit OS. The image is published for both.
- **Linux** is what servers are tested on. Docker Desktop on macOS or Windows works for trying Lifer out.
- **Postgres** comes with the compose file. If you'd rather use your own, Lifer needs Postgres 16 or newer (the compose file uses 18) with the `pgcrypto`, `pg_trgm` and `unaccent` extensions, which come with standard Postgres. It doesn't need PostGIS.

## Memory

Species matching loads two image models into memory, and photo previews are made in memory too. As a rough guide:

- **4 GB** of RAM on the machine is a workable minimum.
- **8 GB or more** is comfortable, especially for importing many photos at once or a large library.

On a server, Postgres runs alongside Lifer and needs some of that too. If memory is tight, matching is slower but still works.

## Disk space

Besides your photos, Lifer keeps its own files: previews of your photos, downloaded models, the offline map, and region packs. Roughly:

| What | Size |
|---|---|
| Species-matching models | about 620 MB |
| Offline map | about 550 MB, if you download it |
| Region packs | varies by region and whether you choose Full or Small. Sizes are shown before you download. |
| Previews of your photos | grows with your library: roughly half a MB per photo |
| Database | a few GB, mostly the species catalog and its matching data. Your own records add little. |
| NVIDIA GPU support | about 2.7 GB more, only on a server with an NVIDIA card |

An SSD for Lifer's own files and the database makes browsing noticeably faster. Your photo library can be on any disk, including a NAS share or an external drive.

## GPU (optional)

A GPU isn't needed. When there is one, Lifer tests it and uses it for species matching only if it's faster. The desktop app uses the Mac's GPU, or any GPU on Windows, with nothing to set up. A Docker server can use NVIDIA cards, and Intel or AMD cards on Linux, once you pass them into the container. See [GPU acceleration](./hardware-acceleration.md).

## Browser

Any current version of Chrome, Edge, Firefox or Safari, on a computer, tablet or phone.
