#!/usr/bin/env bash
# Builds the ffmpeg binary the macOS desktop app ships, from pinned, checksum-verified sources.
#
# Why: ffmpeg-static's macOS binary (osxexperts) is configured with --enable-nonfree, which
# FFmpeg's license says can't be redistributed. Lifer only needs native decoders, a few encoders
# (libx264, aac, mjpeg, png) and the MP4 family, so this is a GPL build with nothing nonfree.
# prepare-resources.js copies the result over node_modules/ffmpeg-static/ffmpeg in the bundle
# when LIFER_FFMPEG_DIR points at the output directory. Dev machines keep ffmpeg-static's.
#
# Usage: apps/desktop/scripts/build-ffmpeg-macos.sh <output-dir> [arm64|x86_64]
# Writes <output-dir>/ffmpeg, ffmpeg.LICENSE and ffmpeg.README for Apple Silicon (arm64, the
# default) or Intel (x86_64). Runs on an Apple Silicon Mac either way: the Intel binary is
# cross-compiled with clang -arch x86_64, and its checks run it under Rosetta 2. Needs Xcode's
# command line tools and pkg-config (installed via Homebrew if missing).
#
# This script and the pinned tarballs below are the corresponding source for the GPL.
# Changing anything here changes the CI cache key, so the next release rebuilds.
set -euo pipefail

# FFmpeg 8.1.3: the newest point release (2026-09) of the newest stable branch. The tarball is
# signed with the FFmpeg release key (FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8); the
# hash below is of the tarball that signature verified.
FFMPEG_VERSION="8.1.3"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"

# x264 has no release tarballs; its "stable" branch head is the release line. The archive of this
# commit is served from Lifer's third-party-sources release (which also offers it as the GPL
# FFmpeg's source): code.videolan.org now answers scripted downloads with a bot check. It's
# byte-identical to `git archive --prefix=x264-<commit>/ <commit> | bzip2 -9` of the commit from
# https://code.videolan.org/videolan/x264.git, which is how a new one is made.
X264_COMMIT="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
X264_URL="https://github.com/Sparklysparkspark/lifer-app/releases/download/third-party-sources/x264-${X264_COMMIT}.tar.bz2"
X264_SHA256="6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224"

# NASM assembles x264's and FFmpeg's x86 SIMD code (arm64 uses clang's own assembler), so it's
# only built for an x86_64 target. It's a build tool, not part of the shipped binary. The hash
# matches the one Homebrew's nasm formula pins for the same tarball.
NASM_VERSION="3.02"
NASM_URL="https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz"
NASM_SHA256="87336eba53b4acfe917424ab5d500d2b0054d9f5148d35c2273ccf2cfb712f0d"

# As low as the Node 22 sidecar (11.0, on both architectures), so FFmpeg never sets the app's
# floor: that's tauri.conf.json's minimumSystemVersion, which prepare-resources.js checks every
# bundled binary against.
export MACOSX_DEPLOYMENT_TARGET="11.0"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <output-dir> [arm64|x86_64]" >&2
  exit 2
fi
ARCH="${2:-arm64}"
case "$ARCH" in
  arm64 | x86_64) ;;
  *)
    echo "[build-ffmpeg] unknown architecture $ARCH (expected arm64 or x86_64)" >&2
    exit 2
    ;;
esac
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "[build-ffmpeg] run this on an Apple Silicon Mac (it cross-compiles the x86_64 build)" >&2
  exit 1
fi
# The checks at the end run the binary, so an Intel one needs Rosetta 2.
RUN=()
if [ "$ARCH" = "x86_64" ]; then
  RUN=(arch -x86_64)
  if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "[build-ffmpeg] the x86_64 build needs Rosetta 2: softwareupdate --install-rosetta --agree-to-license" >&2
    exit 1
  fi
fi

mkdir -p "$1"
OUT_DIR="$(cd "$1" && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lifer-ffmpeg.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
PREFIX="$WORK_DIR/prefix"
JOBS="$(sysctl -n hw.ncpu)"

if ! command -v pkg-config >/dev/null 2>&1; then
  echo "[build-ffmpeg] installing pkg-config (FFmpeg's configure finds x264 through it)"
  brew install pkgconf
fi

fetch() {
  local url="$1" sha="$2" dest="$3"
  curl -fsSL --retry 3 -o "$dest" "$url"
  echo "$sha  $dest" | shasum -a 256 -c -
}

cd "$WORK_DIR"
fetch "$FFMPEG_URL" "$FFMPEG_SHA256" ffmpeg.tar.xz
fetch "$X264_URL" "$X264_SHA256" x264.tar.bz2
tar xf ffmpeg.tar.xz
tar xf x264.tar.bz2

# Flags for compiling and linking for the target architecture. On arm64 they're what clang does
# anyway; for x86_64 they make every object and the final link Intel.
ARCH_FLAGS="-arch $ARCH"
X264_HOST_FLAGS=()
FFMPEG_ARCH_FLAGS=(--arch=arm64)
if [ "$ARCH" = "x86_64" ]; then
  echo "[build-ffmpeg] building NASM ${NASM_VERSION} (a build tool for the x86 assembly)"
  fetch "$NASM_URL" "$NASM_SHA256" nasm.tar.xz
  tar xf nasm.tar.xz
  (
    cd "nasm-${NASM_VERSION}"
    # Built for this (arm64) machine: it runs here and only emits x86 object code.
    ./configure --prefix="$WORK_DIR/tools"
    make -j"$JOBS" nasm
    mkdir -p "$WORK_DIR/tools/bin"
    cp nasm "$WORK_DIR/tools/bin/nasm"
  )
  export PATH="$WORK_DIR/tools/bin:$PATH"
  X264_HOST_FLAGS=(--host=x86_64-apple-darwin)
  FFMPEG_ARCH_FLAGS=(--enable-cross-compile --target-os=darwin --arch=x86_64 --x86asmexe=nasm)
fi

echo "[build-ffmpeg] building x264 ${X264_COMMIT}"
(
  cd "x264-${X264_COMMIT}"
  # Default bit depths (8 and 10): FFmpeg's libx264 wrapper offers 10-bit input formats whatever
  # x264 supports, so an 8-bit-only x264 makes a 10-bit source (an iPhone HDR clip) fail to encode.
  ./configure --prefix="$PREFIX" ${X264_HOST_FLAGS[@]+"${X264_HOST_FLAGS[@]}"} --extra-cflags="$ARCH_FLAGS" --extra-ldflags="$ARCH_FLAGS" \
    --enable-static --enable-pic --disable-cli \
    --disable-opencl --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash
  make -j"$JOBS"
  make install
)

echo "[build-ffmpeg] building FFmpeg ${FFMPEG_VERSION}"
# PKG_CONFIG_LIBDIR (not _PATH) so only our static x264 can be found, never a Homebrew one.
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
unset PKG_CONFIG_PATH
# The commas below are configure's own list syntax, not mistaken array separators.
# shellcheck disable=SC2054
FFMPEG_CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  --cc=clang
  "${FFMPEG_ARCH_FLAGS[@]}"
  --pkg-config-flags=--static
  --extra-cflags="$ARCH_FLAGS -I$PREFIX/include"
  --extra-ldflags="$ARCH_FLAGS -L$PREFIX/lib"
  --enable-gpl
  --disable-nonfree
  --enable-libx264
  # Nothing is picked up from the build machine (Homebrew libraries would become dylib
  # dependencies). That also turns off threads and zlib, so both come back explicitly; zlib is
  # macOS's own /usr/lib/libz and the PNG encoder needs it.
  --disable-autodetect
  --enable-pthreads
  --enable-zlib
  --disable-ffplay
  --disable-ffprobe
  --disable-doc
  --disable-debug
  --disable-network
  --disable-hwaccels
  # Every native decoder, parser and bitstream filter stays: cameras use many codecs and they're
  # cheap. Everything else is off, then only what image.ts and the API tests use comes back.
  --disable-encoders
  --disable-muxers
  --disable-demuxers
  --disable-protocols
  --disable-filters
  --disable-indevs
  --disable-outdevs
  --disable-devices
  # image.ts: preview transcode, poster PNG and suggestion JPEG frames. mpeg4 only for the API
  # tests' synthetic clips.
  --enable-encoder=libx264,aac,mjpeg,png,mpeg4
  # FFMPEG_INPUT_RESTRICTIONS allows only the MP4 family, which is all one demuxer.
  --enable-demuxer=mov
  # mp4 for previews, image2pipe for frames; avi and mov only for the API tests' clips, null
  # and image2 for debugging by hand.
  --enable-muxer=mp4,mov,image2pipe,image2,avi,null
  --enable-protocol=file,pipe
  # buffer*/format/null and the conversion filters (scale, aresample) are what every ffmpeg run
  # needs. trim/atrim come with -ss, transpose/hflip/vflip/rotate with autorotate (phone video
  # carries a display matrix), crop with container cropping. testsrc/sine and the lavfi input
  # device generate test clips.
  --enable-filter=buffer,buffersink,abuffer,abuffersink,format,aformat,null,anull,scale,aresample,trim,atrim,transpose,hflip,vflip,rotate,crop,setpts,asetpts,testsrc,sine
  --enable-indev=lavfi
)
(
  cd "ffmpeg-${FFMPEG_VERSION}"
  ./configure "${FFMPEG_CONFIGURE_FLAGS[@]}"
  make -j"$JOBS"
  make install
)

BIN="$PREFIX/bin/ffmpeg"

echo "[build-ffmpeg] checking the result"
# A single-architecture binary of the requested kind, not a fat one or the host's.
BIN_ARCHS="$(lipo -archs "$BIN")"
if [ "$BIN_ARCHS" != "$ARCH" ]; then
  echo "[build-ffmpeg] ERROR: built for '$BIN_ARCHS', expected $ARCH" >&2
  exit 1
fi
${RUN[@]+"${RUN[@]}"} "$BIN" -hide_banner -version
BUILDCONF="$(${RUN[@]+"${RUN[@]}"} "$BIN" -hide_banner -buildconf 2>&1)"
echo "$BUILDCONF"
if grep -q -- "--enable-nonfree" <<<"$BUILDCONF" || ${RUN[@]+"${RUN[@]}"} "$BIN" -hide_banner -L 2>&1 | grep -qi "nonfree"; then
  echo "[build-ffmpeg] ERROR: this ffmpeg includes nonfree code and can't be redistributed" >&2
  exit 1
fi
# Only the OS's own libraries may be linked: anything else wouldn't exist on a user's Mac.
DYLIBS="$(otool -L "$BIN" | tail -n +2 | awk '{print $1}')"
echo "$DYLIBS"
if grep -v -E '^(/usr/lib/|/System/Library/)' <<<"$DYLIBS"; then
  echo "[build-ffmpeg] ERROR: the libraries above aren't part of macOS" >&2
  exit 1
fi
otool -l "$BIN" | grep -A4 LC_BUILD_VERSION | grep -E "minos|sdk"

cp "$BIN" "$OUT_DIR/ffmpeg"
# Same names as ffmpeg-static's own license and readme, which this build replaces.
{
  cat "ffmpeg-${FFMPEG_VERSION}/LICENSE.md"
  printf '\n\nThis build is configured with --enable-gpl and includes x264, so it is distributed under\nthe GNU General Public License version 2 or later, reproduced below.\n\n'
  cat "ffmpeg-${FFMPEG_VERSION}/COPYING.GPLv2"
} >"$OUT_DIR/ffmpeg.LICENSE"
cat >"$OUT_DIR/ffmpeg.README" <<EOF
FFmpeg ${FFMPEG_VERSION} for Lifer (macOS ${ARCH}), with x264 ${X264_COMMIT}.
GPL-2.0-or-later. Built by apps/desktop/scripts/build-ffmpeg-macos.sh in the Lifer repository
(https://github.com/Sparklysparkspark/lifer-app) from these sources:
  ${FFMPEG_URL}
    sha256 ${FFMPEG_SHA256}
  ${X264_URL}
    sha256 ${X264_SHA256}

$(${RUN[@]+"${RUN[@]}"} "$BIN" -hide_banner -version)
EOF

echo "[build-ffmpeg] wrote $OUT_DIR/ffmpeg ($(du -h "$OUT_DIR/ffmpeg" | cut -f1))"
