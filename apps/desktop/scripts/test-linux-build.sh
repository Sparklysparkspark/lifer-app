#!/usr/bin/env bash
# Runs the exact same Linux desktop build CI runs (npm ci + npm run dist -w desktop) inside a
# persistent Docker container matching ubuntu-latest (24.04, linux/amd64), so the AppImage
# bundling step can be iterated on locally in a couple minutes instead of a ~15min CI round trip
# per attempt. On an Apple Silicon Mac this runs under QEMU emulation (real x86_64 binaries, not
# Rosetta) — slower per-instruction than native, but the FIRST run's ~5min Rust compile is the
# only slow part; the container and its cargo/npm caches persist between runs (named volumes,
# not --rm), so a second run after a small code change only rebuilds what changed.
#
# Usage: apps/desktop/scripts/test-linux-build.sh          # build
#        apps/desktop/scripts/test-linux-build.sh --shell  # drop into a shell in the container instead
#        apps/desktop/scripts/test-linux-build.sh --reset  # remove the container + caches, start fresh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTAINER_NAME="lifer-linux-build-test"
IMAGE="ubuntu:24.04"

if [[ "${1:-}" == "--reset" ]]; then
  echo "[test-linux-build] removing container + cached volumes..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm lifer-linux-cargo-registry lifer-linux-cargo-target lifer-linux-node-modules lifer-linux-rustup >/dev/null 2>&1 || true
  echo "[test-linux-build] done. Run again without --reset to rebuild from scratch."
  exit 0
fi

# Create the container once; reuse it (and its installed rustup/node/apt packages) on every
# subsequent invocation instead of reinstalling the whole toolchain every time.
if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "[test-linux-build] first run — creating container (this one will be slow: installs Rust/Node/apt deps)..."
  docker run -d --platform linux/amd64 --name "$CONTAINER_NAME" \
    -v "$REPO_ROOT":/workspace \
    -v lifer-linux-cargo-registry:/root/.cargo/registry \
    -v lifer-linux-cargo-target:/workspace/apps/desktop/src-tauri/target \
    -v lifer-linux-node-modules:/workspace/node_modules \
    -v lifer-linux-rustup:/root/.rustup \
    -w /workspace \
    "$IMAGE" sleep infinity

  docker exec "$CONTAINER_NAME" bash -c '
    set -e
    apt-get update -qq
    apt-get install -y -qq curl build-essential libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf fuse libfuse2 unzip file xdg-utils desktop-file-utils > /dev/null
    curl -fsSL https://sh.rustup.rs | sh -s -- --default-toolchain stable -y
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null
    apt-get install -y -qq nodejs > /dev/null
  '
else
  docker start "$CONTAINER_NAME" >/dev/null
fi

if [[ "${1:-}" == "--shell" ]]; then
  exec docker exec -it "$CONTAINER_NAME" bash
fi

echo "[test-linux-build] running the build (npm ci, then npm run dist -w desktop)..."
docker exec "$CONTAINER_NAME" bash -c '
  source "$HOME/.cargo/env"
  npm ci
  cd apps/desktop
  APPIMAGE_EXTRACT_AND_RUN=1 TAURI_BUILD_ARGS=--verbose npm run dist
'

echo "[test-linux-build] done. Built artifacts (if it succeeded) are under apps/desktop/src-tauri/target/release/bundle/ — but note that lives in a Docker VOLUME (lifer-linux-cargo-target), not on your host filesystem, since it's shadowing that path inside the container. Use --shell to poke around inside the container directly."
