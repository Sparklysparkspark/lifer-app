#!/bin/sh
# One-shot, run as root before Lifer starts: gives PUID:PGID the folders Lifer writes to.
# Only entries whose owner differs are changed, so a library that is already right is untouched.
set -eu

PUID="${PUID:-568}"
PGID="${PGID:-568}"

for dir in "$@"; do
  mkdir -p "$dir"
  # -h changes a symlink itself, never what it points at.
  changed=$(find "$dir" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -exec chown -h "$PUID:$PGID" {} + | wc -l)
  echo "[permissions] $dir: owner $PUID:$PGID, $changed entries changed"
done
