#!/usr/bin/env bash
# Builds the PostgreSQL server the macOS desktop app bundles, from pinned, checksum-verified sources.
#
# Why: the app used to download Postgres from theseus-rs/postgresql-binaries on first launch, so
# first launch needed the internet, and those macOS binaries require macOS 15. This build is the
# same PostgreSQL release, compiled for an older macOS (MACOSX_DEPLOYMENT_TARGET below) with only
# what Lifer's embedded database uses: the server, initdb, pg_ctl and psql, the backup and
# upgrade tools (pg_dump, pg_restore, pg_dumpall, pg_upgrade and the programs pg_upgrade runs:
# pg_controldata, pg_resetwal, vacuumdb), plus the pg_trgm, unaccent and pgcrypto extensions.
# prepare-resources.js (stage-postgres.js) copies the result into the bundle when
# LIFER_POSTGRES_DIR points at the output directory, or, for the previous major version that a
# release moving to a new major also ships (so the app can pg_upgrade old data), when
# LIFER_POSTGRES_PREVIOUS_DIR does.
#
# Usage: apps/desktop/scripts/build-postgres-macos.sh <output-dir> [arm64|x86_64] [major]
# Writes <output-dir>/bin, lib and share (a relocatable PostgreSQL install) plus COPYRIGHT,
# LICENSE.OpenSSL.txt and README.txt, for Apple Silicon (arm64, the default) or Intel (x86_64).
# <major> picks one of the pinned releases below; it defaults to the one the app bundles
# (BUNDLED_MAJOR). Building the previous major uses the same steps and checks.
# Runs on an Apple Silicon Mac either way: the Intel build is cross-compiled with clang -arch
# x86_64, and its self-test runs it under Rosetta 2. Needs Xcode's command line tools.
#
# Changing anything here changes the CI cache key, so the next release rebuilds.
set -euo pipefail

# The major version the app bundles. Moving to a new major changes this, POSTGRES_VERSION in
# stage-postgres.js and BUNDLED_PG_MAJOR in src-tauri/src/pg_upgrade.rs together (a unit test
# there checks they agree); see "Upgrading the bundled PostgreSQL" in
# docs/docs/contributing/desktop-app.md.
BUNDLED_MAJOR="18"

if [ $# -lt 1 ] || [ $# -gt 3 ]; then
  echo "usage: $0 <output-dir> [arm64|x86_64] [major]" >&2
  exit 2
fi
PG_MAJOR="${3:-$BUNDLED_MAJOR}"

# One pinned release per major. Each hash is the one postgresql.org publishes next to the tarball
# (postgresql-<version>.tar.bz2.sha256).
case "$PG_MAJOR" in
  # 18.6: the newest 18.x, and the same release the app downloaded before, so existing installs'
  # data directories open unchanged.
  18)
    PG_VERSION="18.6"
    PG_SHA256="555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f"
    ;;
  # 17.11: the newest 17.x. Not shipped; it's the "previous major" the 17-to-18 upgrade test
  # (src-tauri/tests/pg-upgrade-test.sh) upgrades from.
  17)
    PG_VERSION="17.11"
    PG_SHA256="dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979"
    ;;
  *)
    echo "[build-postgres] no pinned PostgreSQL $PG_MAJOR release (pin one in this script)" >&2
    exit 2
    ;;
esac
PG_URL="https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2"

# OpenSSL 3.5 (the LTS line, supported until 2030), only for pgcrypto: migration 001 creates the
# extension and migration 109 calls its digest(), and pgcrypto can't be built without OpenSSL.
# It's linked statically into pgcrypto alone; the server and libpq are built without SSL, since
# the embedded database only takes local connections. The hash matches both the .sha256 file
# openssl.org publishes and the one on the GitHub release.
OPENSSL_VERSION="3.5.9"
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"

# As low as the Node 22 sidecar (11.0, the oldest any bundled runtime goes), so Postgres never
# sets the app's floor; tauri.conf.json's minimumSystemVersion is that floor, and
# prepare-resources.js fails a build whose Mach-O files need a newer macOS than it. Postgres's
# configure builds with -Werror=unguarded-availability-new, so a libc function newer than this
# target counts as missing rather than being weakly linked.
export MACOSX_DEPLOYMENT_TARGET="11.0"

ARCH="${2:-arm64}"
case "$ARCH" in
  arm64 | x86_64) ;;
  *)
    echo "[build-postgres] unknown architecture $ARCH (expected arm64 or x86_64)" >&2
    exit 2
    ;;
esac
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "[build-postgres] run this on an Apple Silicon Mac (it cross-compiles the x86_64 build)" >&2
  exit 1
fi
# The self-test at the end runs the binaries, so an Intel build needs Rosetta 2.
RUN=()
if [ "$ARCH" = "x86_64" ]; then
  RUN=(arch -x86_64)
  if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "[build-postgres] the x86_64 build needs Rosetta 2: softwareupdate --install-rosetta --agree-to-license" >&2
    exit 1
  fi
fi

mkdir -p "$1"
OUT_DIR="$(cd "$1" && pwd)"
# Short, so the self-test's Unix socket path stays under macOS's 104-byte limit.
WORK_DIR="$(mktemp -d /tmp/lifer-pg.XXXXXX)"
SELFTEST_DATA="$WORK_DIR/selftest-data"
cleanup() {
  if [ -f "$SELFTEST_DATA/postmaster.pid" ]; then
    ${RUN[@]+"${RUN[@]}"} "$WORK_DIR/postgresql/bin/pg_ctl" -D "$SELFTEST_DATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
JOBS="$(sysctl -n hw.ncpu)"

fetch() {
  local url="$1" sha="$2" dest="$3"
  curl -fsSL --retry 3 -o "$dest" "$url"
  echo "$sha  $dest" | shasum -a 256 -c -
}

cd "$WORK_DIR"
fetch "$PG_URL" "$PG_SHA256" postgresql.tar.bz2
fetch "$OPENSSL_URL" "$OPENSSL_SHA256" openssl.tar.gz
tar xf postgresql.tar.bz2
tar xf openssl.tar.gz

echo "[build-postgres] building OpenSSL ${OPENSSL_VERSION} (static libcrypto for pgcrypto)"
OPENSSL_PREFIX="$WORK_DIR/openssl"
(
  cd "openssl-${OPENSSL_VERSION}"
  # No shared libraries, programs, engines or loadable providers: only what pgcrypto links.
  # no-autoload-config: nothing reads an openssl.cnf, so no file on the user's Mac can load code
  # into the database server. /var/empty (root-owned, always empty) is the config directory
  # anyway.
  ./Configure "darwin64-${ARCH}-cc" --prefix="$OPENSSL_PREFIX" --libdir=lib --openssldir=/var/empty \
    no-shared no-module no-engine no-apps no-docs no-tests no-autoload-config no-ui-console \
    no-comp no-quic no-ssl3 no-dso
  make -j"$JOBS" build_libs
  make install_dev
)

echo "[build-postgres] building PostgreSQL ${PG_VERSION}"
# The prefix contains "postgresql", so make install puts files straight into lib/ and share/
# rather than lib/postgresql/ and share/postgresql/, the layout theseus's builds use too. The
# install is relocatable: each program finds share/ and lib/ relative to its own bin/.
PREFIX="$WORK_DIR/postgresql"
PG_CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  # Lifer's databases use the default libc collation provider (initdb's default; the downloaded
  # build had no ICU either) and no COLLATE clause, so ICU would only add ~30MB.
  --without-icu
  # psql only runs scripts here, never interactively.
  --without-readline
  # macOS's own /usr/share/zoneinfo, like the downloaded build. Saves shipping a copy.
  --with-system-tzdata=/usr/share/zoneinfo
  # The rest are off by default; spelled out so a future default can't add a dependency. So is
  # SSL (no --with-ssl): the server only takes local connections, so neither it nor libpq links
  # OpenSSL. Only pgcrypto does, below.
  --without-libxml
  --without-libxslt
  --without-lz4
  --without-zstd
  --without-gssapi
  --without-ldap
  --without-pam
  --without-bonjour
  --without-llvm
  --disable-nls
  # zlib is macOS's own /usr/lib/libz.
  --with-zlib
  CC="clang -arch $ARCH"
  CPPFLAGS="-I$OPENSSL_PREFIX/include"
  LDFLAGS="-L$OPENSSL_PREFIX/lib"
)
# PostgreSQL 18 added libcurl (for OAuth); older configure scripts don't know the option.
if [ "$PG_MAJOR" -ge 18 ]; then
  PG_CONFIGURE_FLAGS+=(--without-libcurl)
fi
# Nothing is picked up from the build machine's pkg-config (Homebrew libraries would become dylib
# dependencies); every optional library is off anyway.
export PKG_CONFIG_LIBDIR="$WORK_DIR/no-pkg-config"
unset PKG_CONFIG_PATH
if [ "$ARCH" = "x86_64" ]; then
  PG_CONFIGURE_FLAGS+=(--host=x86_64-apple-darwin --build=aarch64-apple-darwin)
fi
(
  cd "postgresql-${PG_VERSION}"
  ./configure "${PG_CONFIGURE_FLAGS[@]}"
  make -j"$JOBS"
  make install
  make -C contrib/pg_trgm -j"$JOBS" install
  make -C contrib/unaccent -j"$JOBS" install
  # contrib/Makefile only builds pgcrypto with --with-ssl=openssl, but its own Makefile builds
  # it either way and links whatever -lcrypto LIBS names: here, the static libcrypto.a above
  # (the only libcrypto on the -L path).
  make -C contrib/pgcrypto -j"$JOBS" LIBS="-lcrypto -lz" install
)

echo "[build-postgres] trimming the install"
# Only what the app uses: the server, the three programs it runs to manage it (initdb, pg_ctl,
# psql), and the backup and upgrade tools: pg_dump, pg_restore and pg_dumpall, and pg_upgrade
# with the programs it runs (pg_controldata and pg_resetwal from both versions' bin/, vacuumdb
# from the new one's). Other client tools, headers, static libraries, pkg-config files,
# unversioned symlinks, the ecpg libraries and the replication plugins are for building against
# Postgres or for features the app doesn't use. stage-postgres.js applies its own list again when
# bundling (a smaller one for a previous major's copy).
KEEP_PROGRAMS=(postgres initdb pg_ctl psql pg_dump pg_restore pg_dumpall pg_upgrade pg_controldata pg_resetwal vacuumdb)
FIND_KEEP=()
for p in "${KEEP_PROGRAMS[@]}"; do FIND_KEEP+=(! -name "$p"); done
find "$PREFIX/bin" -type f "${FIND_KEEP[@]}" -delete
for p in "${KEEP_PROGRAMS[@]}"; do
  if [ ! -f "$PREFIX/bin/$p" ]; then
    echo "[build-postgres] ERROR: make install didn't produce bin/$p" >&2
    exit 1
  fi
done
rm -rf "$PREFIX/include" "$PREFIX/lib/pkgconfig" "$PREFIX/lib/pgxs"
rm -f "$PREFIX"/lib/*.a "$PREFIX"/lib/libecpg* "$PREFIX"/lib/libpgtypes* "$PREFIX/lib/libpq.dylib" \
  "$PREFIX/lib/libpqwalreceiver.dylib" "$PREFIX/lib/pgoutput.dylib"
rm -f "$PREFIX/share/psqlrc.sample" "$PREFIX/share/pg_service.conf.sample" "$PREFIX/share/errcodes.txt"

# Mach-O files in the install: executables in bin/, libpq and loadable modules in lib/.
MACHO=()
while IFS= read -r f; do
  if file -b "$f" | grep -q "Mach-O"; then MACHO+=("$f"); fi
done < <(find "$PREFIX/bin" "$PREFIX/lib" -type f)

# libpq is linked by its absolute install path; point it at lib/ next to the program instead,
# as theseus's builds do, so the install works wherever the app is.
LIBPQ="libpq.5.dylib"
install_name_tool -id "@loader_path/../lib/$LIBPQ" "$PREFIX/lib/$LIBPQ"
for f in "${MACHO[@]}"; do
  if otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -qx "$PREFIX/lib/$LIBPQ"; then
    install_name_tool -change "$PREFIX/lib/$LIBPQ" "@loader_path/../lib/$LIBPQ" "$f"
  fi
done
# Local symbols only (modules resolve the server's global ones), then a fresh ad-hoc signature,
# since install_name_tool and strip invalidate the linker's. resign-macos.js signs the app itself.
for f in "${MACHO[@]}"; do
  strip -x "$f"
  codesign --force --sign - "$f"
done

echo "[build-postgres] checking the result"
failed=0
for f in "${MACHO[@]}"; do
  rel="${f#"$PREFIX"/}"
  archs="$(lipo -archs "$f")"
  if [ "$archs" != "$ARCH" ]; then
    echo "[build-postgres] ERROR: $rel is built for '$archs', expected $ARCH" >&2
    failed=1
  fi
  minos="$(vtool -show-build "$f" | awk '/minos/{print $2}')"
  if [ "$minos" != "$MACOSX_DEPLOYMENT_TARGET" ]; then
    echo "[build-postgres] ERROR: $rel needs macOS $minos, expected $MACOSX_DEPLOYMENT_TARGET" >&2
    failed=1
  fi
  # Only the OS's own libraries and libpq from lib/: anything else wouldn't exist on a user's Mac.
  while IFS= read -r dep; do
    case "$dep" in
      /usr/lib/* | /System/Library/*) ;;
      "@loader_path/../lib/$LIBPQ") ;;
      *)
        echo "[build-postgres] ERROR: $rel links $dep, which isn't part of macOS or this install" >&2
        failed=1
        ;;
    esac
  done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
  # A weakly linked symbol is one the target macOS may not have; nothing here should need one.
  weak="$(nm -m "$f" 2>/dev/null | grep -E "\(undefined\) weak external" || true)"
  if [ -n "$weak" ]; then
    echo "[build-postgres] ERROR: $rel weakly links symbols newer than macOS $MACOSX_DEPLOYMENT_TARGET:" >&2
    echo "$weak" >&2
    failed=1
  fi
done
if [ "$failed" != 0 ]; then exit 1; fi
echo "[build-postgres] ${#MACHO[@]} Mach-O files: $ARCH, macOS $MACOSX_DEPLOYMENT_TARGET+, system libraries only"

# A real cluster, the way the app uses one: initdb, start, the three extensions, a dump and
# restore, ANALYZE, stop. Unix socket only (listen_addresses=''), so it can't collide with a
# server already on a TCP port.
echo "[build-postgres] self-test"
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/initdb" -D "$SELFTEST_DATA" -U postgres --auth=trust --encoding=UTF8 --no-instructions >/dev/null
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/pg_ctl" -D "$SELFTEST_DATA" -l "$WORK_DIR/selftest.log" -w \
  -o "-c listen_addresses='' -k $WORK_DIR -p 54329" start >/dev/null || {
  cat "$WORK_DIR/selftest.log" >&2
  exit 1
}
RESULT="$(${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/psql" -h "$WORK_DIR" -p 54329 -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -c "
  CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION pgcrypto;
  SELECT unaccent('Hôtel Ñandú'),
         similarity('heron', 'herons') > 0.5,
         encode(digest('lifer', 'sha256'), 'hex') = encode(sha256('lifer'::bytea), 'hex'),
         gen_random_uuid() IS NOT NULL,
         version();
  CREATE TABLE selftest AS SELECT g AS id, md5(g::text) AS name FROM generate_series(1, 100) g;
  CREATE INDEX selftest_trgm ON selftest USING gin (name gin_trgm_ops);" -c "CREATE DATABASE restored;")"
echo "$RESULT"
case "$RESULT" in
  "Hotel Nandu|t|t|t|PostgreSQL ${PG_VERSION} "*) ;;
  *)
    echo "[build-postgres] ERROR: unexpected self-test result" >&2
    exit 1
    ;;
esac
# The backup and upgrade tools: a custom-format dump restored into another database, a globals
# dump, ANALYZE, and the two programs pg_upgrade runs against a stopped cluster.
PGCONN=(-h "$WORK_DIR" -p 54329 -U postgres)
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/pg_dump" "${PGCONN[@]}" -Fc -f "$WORK_DIR/selftest.dump" postgres
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/pg_restore" "${PGCONN[@]}" --exit-on-error -d restored "$WORK_DIR/selftest.dump"
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/pg_dumpall" "${PGCONN[@]}" --globals-only >/dev/null
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/vacuumdb" "${PGCONN[@]}" --analyze-only --quiet restored
RESTORED="$(${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/psql" "${PGCONN[@]}" -d restored -X -q -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*), bool_and(name = md5(id::text)) FROM selftest;")"
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/pg_ctl" -D "$SELFTEST_DATA" -m fast -w stop >/dev/null
if [ "$RESTORED" != "100|t" ]; then
  echo "[build-postgres] ERROR: pg_dump/pg_restore round trip gave '$RESTORED'" >&2
  exit 1
fi
${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/pg_controldata" "$SELFTEST_DATA" | grep -q "Database cluster state: *shut down" || {
  echo "[build-postgres] ERROR: pg_controldata can't read the self-test cluster" >&2
  exit 1
}
for p in pg_upgrade pg_resetwal; do
  case "$(${RUN[@]+"${RUN[@]}"} "$PREFIX/bin/$p" --version)" in
    *" ${PG_VERSION}") ;;
    *)
      echo "[build-postgres] ERROR: $p doesn't report version ${PG_VERSION}" >&2
      exit 1
      ;;
  esac
done

rm -rf "$OUT_DIR/bin" "$OUT_DIR/lib" "$OUT_DIR/share"
cp -R "$PREFIX/bin" "$PREFIX/lib" "$PREFIX/share" "$OUT_DIR/"
cp "postgresql-${PG_VERSION}/COPYRIGHT" "$OUT_DIR/COPYRIGHT"
cp "openssl-${OPENSSL_VERSION}/LICENSE.txt" "$OUT_DIR/LICENSE.OpenSSL.txt"
cat >"$OUT_DIR/README.txt" <<EOF
PostgreSQL ${PG_VERSION} for Lifer (macOS ${ARCH}, macOS ${MACOSX_DEPLOYMENT_TARGET} or later).
PostgreSQL License (COPYRIGHT). pgcrypto statically links OpenSSL ${OPENSSL_VERSION}, Apache License 2.0
(LICENSE.OpenSSL.txt). Built by apps/desktop/scripts/build-postgres-macos.sh in the Lifer
repository (https://github.com/Sparklysparkspark/lifer-app) from these sources:
  ${PG_URL}
    sha256 ${PG_SHA256}
  ${OPENSSL_URL}
    sha256 ${OPENSSL_SHA256}
EOF

echo "[build-postgres] wrote $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
