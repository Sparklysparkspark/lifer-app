#!/bin/sh
# One-shot, run as root before Lifer starts: gives PUID:PGID the folders Lifer writes to.
#
# Usage: lifer-fix-permissions <library dir> <app-data dir>
#
# App data is Lifer's own, so everything in it is handed over. The photo library is the user's:
# only its top folder is changed, plus, once, entries still owned by root from images before
# 0.9.0 (which ran as root). Files owned by anyone else (SMB, Syncthing, another app) are never
# touched, and later starts don't walk the library at all.
set -eu

PUID="${PUID:-568}"
PGID="${PGID:-568}"
LIBRARY_DIR="$1"
APP_DATA_DIR="$2"
# Bump the suffix if a future release needs the library pass to run again.
ROOT_MIGRATION_MARKER="$APP_DATA_DIR/.permissions-root-migrated-v1"

mkdir -p "$LIBRARY_DIR" "$APP_DATA_DIR"

# -h changes a symlink itself, never what it points at.
changed=$(find "$APP_DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -exec chown -h "$PUID:$PGID" {} + | wc -l)
echo "[permissions] $APP_DATA_DIR: owner $PUID:$PGID, $changed entries changed"

chown -h "$PUID:$PGID" "$LIBRARY_DIR"
if [ ! -e "$ROOT_MIGRATION_MARKER" ]; then
  changed=$(find "$LIBRARY_DIR" -user 0 -print -exec chown -h "$PUID:$PGID" {} + | wc -l)
  echo "[permissions] $LIBRARY_DIR: $changed root-owned entries given to $PUID:$PGID (one-time)"
  touch "$ROOT_MIGRATION_MARKER"
  chown -h "$PUID:$PGID" "$ROOT_MIGRATION_MARKER"
else
  echo "[permissions] $LIBRARY_DIR: top folder owner $PUID:$PGID"
fi
