# Third-party notices

Lifer is licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0-only).
It includes, or downloads at runtime, the third-party software, models and data listed here, each
under its own license. This file covers the notable components: native binaries, machine
learning models and datasets. Every npm and Rust dependency's license is also in its package
metadata (`node_modules/*/package.json`, `apps/desktop/src-tauri/Cargo.lock`).

"Docker" means the image `ghcr.io/sparklysparkspark/lifer-app`; "desktop" means the desktop app
installers. Versions are the ones locked in this repository at the time of writing.

## Bundled binaries and native libraries

### FFmpeg

FFmpeg runs in Docker and the desktop app to read videos, grab frames from them and make
playable previews. The API finds it through
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0 (binary release b6.1.1), whose
binary differs by platform:

- macOS desktop app (Apple Silicon and Intel): FFmpeg 8.1.3 with x264 (commit
  `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`, from x264's stable branch), built in Lifer's release
  workflow by [`apps/desktop/scripts/build-ffmpeg-macos.sh`](./apps/desktop/scripts/build-ffmpeg-macos.sh),
  which replaces ffmpeg-static's macOS binary in the app. That one is built with
  `--enable-nonfree`, so it can't be redistributed and isn't shipped. The Intel binary is
  cross-compiled with `-arch x86_64`; NASM 3.02 (a build tool only, not shipped) assembles its x86
  code.
  - License: GPL-2.0-or-later (FFmpeg with `--enable-gpl`; x264 is GPL-2.0-or-later)
  - Configuration: `--enable-gpl --disable-nonfree --enable-libx264 --disable-autodetect
    --enable-pthreads --enable-zlib --disable-network`, with every native decoder and only the
    encoders, formats, protocols and filters Lifer uses. The script lists every flag, and
    `ffmpeg -buildconf` prints them.
  - Source: the build script and the two tarballs it downloads and checks by SHA-256, which are
    the complete corresponding source:
    <https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz> (sha256
    `7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3`) and
    <https://github.com/Sparklysparkspark/lifer-app/releases/download/third-party-sources/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2>
    (sha256 `6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224`), the archive of that
    commit from <https://code.videolan.org/videolan/x264.git>.
- Linux desktop app and Docker (x64 and arm64): ffmpeg-static's binaries, FFmpeg 7.0.2 static
  builds by [John Van Sickle](https://johnvansickle.com/ffmpeg/), unmodified.
  - License: GPL-3.0-or-later
  - Configuration: `--enable-gpl --enable-version3 --enable-static`, plus external libraries
    (including libx264, libx265, libvpx, libaom, libdav1d, libmp3lame, libopus and gnutls). No
    `--enable-nonfree`.
  - Source: <https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz>; the build's library versions are
    in `node_modules/ffmpeg-static/ffmpeg.README`.
- Windows desktop app (x64): ffmpeg-static's binary, the FFmpeg 6.1.1 "essentials" build from
  [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), unmodified.
  - License: GPL-3.0-or-later
  - Configuration: `--enable-gpl --enable-version3 --enable-static`, plus external libraries
    (including libx264, libx265, libvpx, libaom, libmp3lame, libopus and gnutls). No
    `--enable-nonfree`.
  - Source: <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93> (FFmpeg 6.1.1); the build's
    settings are in `node_modules/ffmpeg-static/ffmpeg.exe.README`.

Each binary's license text ships beside it as `node_modules/ffmpeg-static/ffmpeg.LICENSE`
(`ffmpeg.exe.LICENSE` on Windows), and `ffmpeg -L` prints its license.

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the
[GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) (macOS) and the
[GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) (Linux, Windows and Docker).

### ExifTool

- Component: [ExifTool](https://exiftool.org) 13.59 by Phil Harvey, through
  [exiftool-vendored](https://github.com/photostructure/exiftool-vendored.js) 38.3.0 (MIT) and
  exiftool-vendored.pl 13.59.3 (MIT). The Windows build (exiftool-vendored.exe) includes a Perl
  runtime.
- License: ExifTool is free software under the same terms as Perl itself (Artistic License or
  GPL-1.0-or-later)
- Used in: Docker (with the Debian `perl` package) and desktop, to read and write photo metadata

Copyright 2003-2026, Phil Harvey.

### libvips (through sharp)

- Component: [sharp](https://github.com/lovell/sharp) 0.35.4 (Apache-2.0) with prebuilt
  [libvips](https://www.libvips.org) 8.18.6 from
  [sharp-libvips](https://github.com/lovell/sharp-libvips) 1.3.3
- License: libvips is LGPL-3.0-or-later. The prebuilt library also bundles other open-source
  libraries (such as libheif, libjpeg-turbo/mozjpeg, libpng, libwebp, libtiff, cairo, pango,
  glib and harfbuzz), each under its own license; see the `versions.json` and README in
  `node_modules/@img/sharp-libvips-*`.
- Used in: Docker and desktop, for image decoding, resizing and previews
- Source: <https://github.com/lovell/sharp-libvips/tree/v1.3.3>. libvips is dynamically linked,
  so it can be replaced with a modified build.

### libheif (through libheif-js)

- Component: [libheif](https://github.com/strukturag/libheif) compiled to JavaScript and
  WebAssembly by [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.23.2, used by
  [heic-decode](https://github.com/catdad-experiments/heic-decode) 2.1.0 (ISC)
- License: LGPL-3.0
- Used in: Docker and desktop, to read HEIC photos
- Source: <https://github.com/strukturag/libheif> and
  <https://github.com/catdad-experiments/libheif-js>

### ONNX Runtime

- Component: [onnxruntime-node](https://github.com/microsoft/onnxruntime) 1.30.0, used directly
  and by [@huggingface/transformers](https://github.com/huggingface/transformers.js) 4.3.0
  (Apache-2.0). transformers.js depends on @huggingface/jinja and @huggingface/tokenizers
  (Apache-2.0), and its compiled `dist` includes code from onnxruntime-web (MIT), protobufjs
  (BSD-3-Clause), long (Apache-2.0) and flatbuffers (Apache-2.0).
  The Intel macOS app ships onnxruntime-node and onnxruntime-common 1.23.2 instead, the last
  release with Intel Mac binaries.
- License: MIT. Copyright (c) Microsoft Corporation.
- Used in: Docker and desktop, to run the species-matching models; the phone app (onnxruntime-react-native
  1.24.3, see Phone app below), to embed search queries. The Windows build includes
  Microsoft's DirectML and DirectX Shader Compiler libraries, under Microsoft's redistribution
  terms.

On a server with an NVIDIA GPU, Lifer downloads NVIDIA's CUDA libraries and the ONNX Runtime GPU
build at runtime, from NVIDIA's and Microsoft's own package servers. They are not redistributed
by Lifer and come under NVIDIA's and Microsoft's license terms. The Docker image and desktop
app don't include onnxruntime-node's own CUDA or TensorRT provider libraries.

### DuckDB

- Component: [duckdb](https://github.com/duckdb/duckdb-node) 1.4.4
- License: MIT
- Used in: the maintainer's data-pipeline scripts (AVONET import, FishBase checks) only. It is not
  included in the Docker image or the desktop app.

### Node.js

- Component: [Node.js](https://nodejs.org) 22.23.3, the official build from nodejs.org, bundled
  as the desktop app's API runtime. The Docker image is based on the official `node:22-slim`
  image (Debian).
- License: MIT, with bundled dependencies (V8, libuv, OpenSSL, ICU and others) under their own
  licenses, listed in the LICENSE file that ships with Node.js
- Used in: desktop (bundled) and Docker (base image)

### PostgreSQL (desktop)

- Component: [PostgreSQL](https://www.postgresql.org) 18.6, bundled in the desktop app as its
  embedded database server (`postgres`, `initdb`, `pg_ctl`, `psql`, libpq, and the `plpgsql`,
  `pg_trgm`, `unaccent` and `pgcrypto` modules), run by the
  [postgresql_embedded](https://github.com/theseus-rs/postgresql-embedded) crate 0.21.0
  ((Apache-2.0 OR MIT) AND PostgreSQL).
  - macOS (Apple Silicon and Intel): built from source by
    [`apps/desktop/scripts/build-postgres-macos.sh`](./apps/desktop/scripts/build-postgres-macos.sh)
    from <https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2> (sha256
    `555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f`). Its pgcrypto module
    statically links [OpenSSL](https://www.openssl.org) 3.5.9 (Apache-2.0), built from
    <https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz>
    (sha256 `603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a`).
  - Linux and Windows (x64): the prebuilt binaries from
    [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries) 18.6.0,
    unmodified apart from leaving out unused files. The Linux build uses the system's libraries.
    The Windows build includes, as DLLs, OpenSSL 3 (Apache-2.0), ICU 77 (Unicode-3.0), libxml2
    (MIT), zlib, LZ4 (BSD-2-Clause), Zstandard (BSD-3-Clause), GNU gettext's libintl and GNU
    libiconv (LGPL-2.1-or-later), and winpthreads; their licenses ship as
    `postgres/commandlinetools_3rd_party_licenses.txt`.
  - Source for the Windows build's LGPL libraries: `libintl-9.dll` is GNU gettext 0.19.8 and
    `libiconv-2.dll` is GNU libiconv 1.19. Their unmodified upstream sources, with GNU's
    signatures, are on Lifer's
    [third-party-sources](https://github.com/Sparklysparkspark/lifer-app/releases/tag/third-party-sources)
    release, and upstream at <https://ftp.gnu.org/gnu/gettext/gettext-0.19.8.tar.gz> and
    <https://ftp.gnu.org/gnu/libiconv/libiconv-1.19.tar.gz>. The installer says so in
    `postgres/THIRD_PARTY_SOURCES.txt`. Both are dynamically linked, so they can be replaced with
    modified builds.
- License: PostgreSQL License (`postgres/COPYRIGHT` or `postgres/LICENSE`), plus the licenses
  above.
- Used in: desktop, bundled in the installer.

The Docker setup runs the official `postgres:18-alpine` image as a separate container; it isn't
part of the Lifer image.

### Tauri

- Component: [Tauri](https://tauri.app) 2 and its plugins
- License: Apache-2.0 OR MIT
- Used in: desktop

### Phone companion

- Components used by the desktop app's phone listener, tray icon and Settings > Connect phone page:
  [rcgen](https://github.com/rustls/rcgen) 0.14 (self-signed certificate; MIT OR Apache-2.0),
  [mdns-sd](https://github.com/keepsimple1/mdns-sd) 0.21 (local network discovery; Apache-2.0 OR
  MIT), [if-addrs](https://github.com/messense/if-addrs) 0.15 (this computer's network
  addresses; MIT OR BSD-3-Clause),
  [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace) 2 (the optional "Start
  at login"; MIT OR Apache-2.0), and [lean-qr](https://github.com/davidje13/lean-qr) 2.7 (the
  pairing QR code; MIT)
- Typed pairing's key exchange (CPace, in `packages/shared`), on the API and in the phone app:
  [@noble/curves](https://github.com/paulmillr/noble-curves) 2.4.0 (ristretto255; MIT) and
  [@noble/hashes](https://github.com/paulmillr/noble-hashes) 2.4.0 (SHA-512 and HMAC; MIT), both
  by Paul Miller
- Used in: desktop (the Rust crates), Docker and desktop (lean-qr, in the web app; the noble
  libraries, in the API), phone app (the noble libraries)

### Map libraries

- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 6.4.1: BSD-3-Clause
- [PMTiles](https://github.com/protomaps/PMTiles) 4.5.0: BSD-3-Clause
- [Protomaps basemaps](https://github.com/protomaps/basemaps) 5.7.2 (map styles): BSD-3-Clause
- [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) Regular, as map label glyphs (Latin
  ranges only, `apps/web/public/map-glyphs`, licence text beside them) from
  [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets): SIL Open Font License 1.1,
  © 2022 The Noto Project Authors
- Used in: Docker and desktop (the web app)

## Machine learning models

| Model | License | Shipped how | Credit |
|---|---|---|---|
| [YOLOv8n](https://github.com/ultralytics/ultralytics), Ultralytics | AGPL-3.0 | Included in the repository and both builds (`packages/core/src/species/models/yolov8n.onnx`) | Jocher, G., Chaurasia, A. and Qiu, J. (2023) Ultralytics YOLOv8 |
| [BioCLIP 2](https://huggingface.co/imageomics/bioclip-2), Imageomics Institute | MIT | Converted to ONNX and downloaded at runtime from this repository's `models` release | Gu, J. et al. (2025) BioCLIP 2, doi:10.57967/hf/5765 |
| [CLIP ViT-L/14](https://github.com/openai/CLIP), OpenAI, ONNX conversion by [Xenova](https://huggingface.co/Xenova/clip-vit-large-patch14) | MIT | Downloaded at runtime from this repository's `models` release and from Hugging Face | Radford, A. et al. (2021) Learning Transferable Visual Models From Natural Language Supervision |
| [UperNet ConvNeXt-tiny](https://huggingface.co/openmmlab/upernet-convnext-tiny), OpenMMLab, trained on [ADE20K](https://ade20k.csail.mit.edu/) by MIT CSAIL | MIT | Converted to ONNX and downloaded at runtime from this repository's `models` release | Xiao, T. et al. (2018) Unified Perceptual Parsing for Scene Understanding; Liu, Z. et al. (2022) A ConvNet for the 2020s; Zhou, B. et al. (2017) Scene Parsing through ADE20K Dataset |

## Data

The species catalog, region packs, reference photos and offline map are built from open
datasets, each under its own license. Reference photos remain the property of their
photographers, under the license each chose, and are credited in the app. Published packs include
photos under CC0, public domain and every Creative Commons license (CC BY, BY-SA, BY-ND, BY-NC,
BY-NC-SA and BY-NC-ND); the NC ones may only be reused non-commercially, so anyone reusing Lifer's
published data commercially must leave them out. Photos whose license doesn't allow redistribution are
never published in packs, the photo store or the catalog seed; an install may download them from
iNaturalist for its user's personal viewing, with their credit and license. The full list, with
licenses and required citations, is in
[packages/data-pipeline/DATA_SOURCES.md](./packages/data-pipeline/DATA_SOURCES.md) and on the
[Data sources and credits](https://sparklysparkspark.github.io/lifer-app/credits) docs page.

The iNaturalist logo shown beside Lifer's iNaturalist page is a trademark of iNaturalist. Lifer uses it
only to mark that integration, and is not affiliated with or endorsed by iNaturalist.

The offline map contains data © OpenStreetMap contributors, available under the
[Open Database License](https://www.openstreetmap.org/copyright).

The offline town list in the catalog seed (`gazetteer_places`) is derived from
[GeoNames](https://www.geonames.org/) `cities1000`, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): place names from GeoNames
(geonames.org). Lifer keeps a subset of the fields and adds each town's Lifer region. GeoNames
provides the data "as is" without warranty of accuracy, timeliness or completeness.

Online map services, used when the photo map is zoomed in and online (unless the user turns online
detail off) or Satellite is picked, and never bundled:

- Detail tiles from [OpenFreeMap](https://openfreemap.org/): "OpenFreeMap © OpenMapTiles Data from
  OpenStreetMap". OpenStreetMap data under the Open Database License; the
  [OpenMapTiles](https://openmaptiles.org/) schema under BSD-3-Clause (code) and CC BY 4.0 (design).
- Place search and place names (when online, unless turned off) from
  [Photon](https://photon.komoot.io) by komoot: OpenStreetMap data under the Open Database License,
  credited "Photon (komoot), © OpenStreetMap contributors" under the results.
- Satellite imagery: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified
  Copernicus Sentinel data 2025)", under
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) for non-commercial use. Lifer
  is non-commercial; anyone reusing Lifer commercially must swap this source out.

The sea zones in the catalog seed and the sea zone packs are derived from two datasets, both
under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

- Flanders Marine Institute (2018). IHO Sea Areas, version 3. Available online at
  https://www.marineregions.org/ https://doi.org/10.14284/323. Lifer leaves out the oceans.
- Flanders Marine Institute (2024). The intersect of the Exclusive Economic Zones and IHO sea
  areas, version 5. Available online at https://www.marineregions.org/
  https://doi.org/10.14284/699. Lifer uses only the oceans' national parts, without the high seas
  and joint regime areas.

Lifer reduces each area to a simplified outline of its largest polygon. See
https://www.marineregions.org/ for the current versions.

## Phone app (apps/mobile)

The phone app scans the pairing QR code with Apple's built-in scanner on iPhone (through expo-camera,
MIT) and, on Android, with ZXing core 3.5.4 ([Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0))
fed by AndroidX CameraX 1.6.0 (Apache-2.0). Both decode on the phone, offline. No Google ML Kit or
Play Services code is included on Android. Typed pairing uses @noble/curves and @noble/hashes (MIT,
listed under Phone companion above) and the platforms' own Bonjour (NWBrowser) and Network Service
Discovery (NsdManager) through Lifer's own module.

The phone's offline library uses Expo SDK modules (MIT): expo-sqlite (the on-phone database),
expo-image (photo display), expo-image-picker (the system photo picker), expo-location (one position
fix, only when asked), expo-file-system (the photo cache), expo-sharing (the system share sheet) and
expo-haptics. Screens are navigated with React Navigation (native-stack, bottom-tabs; MIT). The phone's
look uses expo-symbols (SF Symbols on iPhone, Material Symbols on Android; MIT, the symbol artwork
itself belongs to Apple and Google and is used through the system), expo-glass-effect (the system glass
material; MIT), @react-native-segmented-control/segmented-control (the system segmented control; MIT),
@shopify/flash-list (the recycled Collection list; MIT), and react-native-gesture-handler with
react-native-worklets (pinch and drag; MIT; worklets is gesture-handler's own requirement). None of
them phones home. The public pack index in standalone mode is fetched only when the person asks.

Smart search offline runs the hub's CLIP ViT-L/14 text encoder (int8 ONNX, listed under Models below) on the
phone with [onnxruntime-react-native](https://github.com/microsoft/onnxruntime) 1.24.3 (MIT; it bundles
the ONNX Runtime C library, MIT). The encoder, its tokenizer and each photo's image vector come from the
person's own Lifer; nothing is requested from a third party. Typed queries are tokenized by Lifer's own
TypeScript copy of CLIP's byte-pair tokenizer, using the vocabulary file the hub serves.
