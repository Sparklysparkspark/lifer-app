// Puts the PostgreSQL server the embedded database runs (embedded_db.rs) into
// resources-staging/postgres, so the app never downloads it: first launch works offline and
// can't fail on a download.
//
// - macOS: the build from build-postgres-macos.sh, which LIFER_POSTGRES_DIR points at. The
//   theseus-rs binaries the app used to download require macOS 15; this one runs on the app's
//   floor (tauri.conf.json's minimumSystemVersion). Required in CI and for a cross build. A local
//   build without it bundles none, and the app then downloads one on first launch as it used to.
// - Linux and Windows: the same theseus-rs/postgresql-binaries release the app used to download,
//   fetched here at build time and checked against the hashes below.
//
// Either way only what the app needs is kept (see KEEP below): the server, the programs the app
// runs, the backup and upgrade tools, the libraries they load, the extensions Lifer's migrations
// create, and the data files initdb and the server read. Everything else in a PostgreSQL install
// (other client tools, headers, static libraries, documentation, other extensions) is left out.
//
// A release that moves to a new PostgreSQL major also stages the previous major's server in
// resources-staging/postgres-previous/<major>, so the app can pg_upgrade data made by the release
// before (src-tauri/src/pg_upgrade.rs): set PREVIOUS_POSTGRES_VERSION below (Linux and Windows),
// and LIFER_POSTGRES_PREVIOUS_DIR to a build-postgres-macos.sh build of it (macOS). Otherwise
// that folder holds only a note.
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// The PostgreSQL release, by theseus's name for it. build-postgres-macos.sh builds the same one
// (BUNDLED_MAJOR there), and BUNDLED_PG_MAJOR in src-tauri/src/pg_upgrade.rs is its major; a
// unit test there checks all three agree. Existing installs' data directories were created by
// this major, so a new major also needs PREVIOUS_POSTGRES_VERSION (see the runbook in
// docs/docs/contributing/desktop-app.md).
export const POSTGRES_VERSION = "18.6.0";
// The previous major's release, bundled for upgrading old data, or null when this release didn't
// change majors. Keep it for a few releases after a major change, then set it back to null.
// LIFER_POSTGRES_PREVIOUS_VERSION overrides it (the upgrade test uses 17.11.0).
export const PREVIOUS_POSTGRES_VERSION = null;
const THESEUS_RELEASES = "https://github.com/theseus-rs/postgresql-binaries/releases/download";
// sha256 of each archive, by release, from the .sha256 file published next to it (and checked
// against a fresh download when it was pinned).
const THESEUS_SHA256 = {
  "18.6.0": {
    "x86_64-unknown-linux-gnu": "bb3d09f876b2383e25a8c9ce09e32d185a03656a23d074f5195542b1b1b3ca61",
    "x86_64-pc-windows-msvc": "7da44c2dbcda3b49688ea08ce8cf99cfe677adf565f53a9145bf9002c74db7d5",
  },
  "17.11.0": {
    "x86_64-unknown-linux-gnu": "b7a1ba6bae6499d8296e3e81b0171eecfd1766ca9aaa0057e41ad3e844e5e2e0",
    "x86_64-pc-windows-msvc": "a013f0e082826f53985c7bc2a0fe1c2dcc47a9f3797023938cf1ff8c9d6d1792",
  },
};

const major = (version) => Number(String(version).split(".")[0]);

// What the bundle keeps, by name.
const KEEP = {
  // The server, the three programs the app runs (initdb on first launch, pg_ctl to start and
  // stop it, psql to load the species catalog), the backup tools (pg_dump, pg_restore,
  // pg_dumpall), and pg_upgrade with the programs it runs from the new version's bin/
  // (pg_controldata, pg_resetwal, vacuumdb; it also needs initdb, pg_dump, pg_dumpall,
  // pg_restore and psql there).
  programs: [
    "postgres",
    "initdb",
    "pg_ctl",
    "psql",
    "pg_dump",
    "pg_restore",
    "pg_dumpall",
    "pg_upgrade",
    "pg_controldata",
    "pg_resetwal",
    "vacuumdb",
  ],
  // A previous major's copy only has to run its old server for pg_upgrade (or for a dump, if
  // pg_upgrade fails): pg_upgrade needs postgres, pg_ctl, pg_controldata and pg_resetwal in the
  // old bin/. Its libraries, extensions and data files are the same list as below.
  previousPrograms: ["postgres", "pg_ctl", "pg_controldata", "pg_resetwal"],
  // Loadable modules: PL/pgSQL and snowball (initdb installs both), and the extensions the
  // migrations create (001 pgcrypto, 002 pg_trgm, 111 unaccent).
  modules: ["plpgsql", "dict_snowball", "pg_trgm", "unaccent", "pgcrypto"],
  extensions: ["plpgsql", "pg_trgm", "unaccent", "pgcrypto"],
  // Character set conversions (utf8_and_sjis, ...): loaded when a client's encoding differs
  // from the database's. Small, and psql picks its encoding from the user's locale.
  conversion: /(_and_|^euc2004_sjis2004$)/,
  // What initdb loads into a new cluster, the config templates it copies, and the server's
  // own data: timezone abbreviations, text search dictionaries (unaccent.rules among them), and
  // timezone data on Windows, which has no system copy.
  shareFiles: [
    "postgres.bki",
    "information_schema.sql",
    "sql_features.txt",
    "system_constraints.sql",
    "system_functions.sql",
    "system_views.sql",
    "snowball_create.sql",
    "pg_hba.conf.sample",
    "pg_ident.conf.sample",
    "postgresql.conf.sample",
  ],
  shareDirs: ["timezonesets", "tsearch_data", "timezone"],
};

const PLATFORM = {
  darwin: { triple: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" }, exe: "", module: ".dylib" },
  linux: { triple: { x64: "x86_64-unknown-linux-gnu" }, exe: "", module: ".so" },
  win32: { triple: { x64: "x86_64-pc-windows-msvc" }, exe: ".exe", module: ".dll" },
};

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Downloads (or reuses a cached copy of) the theseus archive for `triple` and extracts it.
// Returns the extracted install's root.
async function fetchTheseus(version, triple, workDir) {
  const expected = THESEUS_SHA256[version]?.[triple];
  if (!expected) throw new Error(`[stage-postgres] no pinned PostgreSQL ${version} archive for ${triple}`);
  const name = `postgresql-${version}-${triple}.tar.gz`;
  const cacheDir = path.join(os.tmpdir(), "lifer-postgres-cache");
  const archive = path.join(cacheDir, name);
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(archive) || sha256(archive) !== expected) {
    const url = `${THESEUS_RELEASES}/${version}/${name}`;
    console.log(`[stage-postgres] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[stage-postgres] couldn't download ${url}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
    const actual = sha256(archive);
    if (actual !== expected) {
      rmSync(archive, { force: true });
      throw new Error(`[stage-postgres] ${name} has sha256 ${actual}, expected ${expected}. Refusing to bundle it.`);
    }
  }
  console.log(`[stage-postgres] sha256 verified: ${name}`);
  // Relative paths only: GNU tar (Git for Windows') reads "C:\..." as a remote host.
  cpSync(archive, path.join(workDir, name));
  const result = spawnSync("tar", ["-xzf", name], { cwd: workDir, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`[stage-postgres] couldn't extract ${name}`);
  rmSync(path.join(workDir, name));
  const root = path.join(workDir, `postgresql-${version}-${triple}`);
  if (!existsSync(root)) throw new Error(`[stage-postgres] ${name} has no ${path.basename(root)} folder`);
  return root;
}

// The DLLs a Windows executable or DLL imports (normal and delay-loaded), from its PE headers.
function peImports(file) {
  const buf = readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) return [];
  const sectionCount = buf.readUInt16LE(pe + 6);
  const optionalSize = buf.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const dataDirs = optional + (buf.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const s = optional + optionalSize + i * 40;
    return {
      va: buf.readUInt32LE(s + 12),
      size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
      raw: buf.readUInt32LE(s + 20),
    };
  });
  const offset = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`[stage-postgres] ${file}: import table points outside its sections`);
    return rva - s.va + s.raw;
  };
  const cstring = (at) => buf.toString("latin1", at, buf.indexOf(0, at));
  const names = [];
  // IMAGE_DIRECTORY_ENTRY_IMPORT (1): 20-byte descriptors, the name RVA at +12.
  const importRva = buf.readUInt32LE(dataDirs + 1 * 8);
  if (importRva) {
    for (let d = offset(importRva); buf.readUInt32LE(d + 12) !== 0; d += 20)
      names.push(cstring(offset(buf.readUInt32LE(d + 12))));
  }
  // IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT (13): 32-byte descriptors, the name RVA at +4.
  const delayRva = buf.readUInt32LE(dataDirs + 13 * 8);
  if (delayRva) {
    for (let d = offset(delayRva); buf.readUInt32LE(d + 4) !== 0; d += 32)
      names.push(cstring(offset(buf.readUInt32LE(d + 4))));
  }
  return names;
}

// Every DLL in bin/ that the kept programs and modules need, directly or through each other.
// The rest (system DLLs, the C runtime) come from Windows.
function windowsDllClosure(root, roots) {
  const binDir = path.join(root, "bin");
  const available = new Map(
    readdirSync(binDir)
      .filter((n) => n.toLowerCase().endsWith(".dll"))
      .map((n) => [n.toLowerCase(), n]),
  );
  const needed = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    for (const dll of peImports(queue.pop())) {
      const local = available.get(dll.toLowerCase());
      if (!local || needed.has(local)) continue;
      needed.add(local);
      queue.push(path.join(binDir, local));
    }
  }
  return needed;
}

// Copies the files KEEP names from a PostgreSQL install at `root` to `dest`, dereferencing
// symlinks (Tauri's bundler drops them; Linux's libpq.so.5 is one).
function copyKept(root, dest, platform, keptPrograms) {
  const { exe, module } = PLATFORM[platform];
  const copy = (rel) => {
    mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    cpSync(path.join(root, rel), path.join(dest, rel), { recursive: true, dereference: true });
  };

  const programs = keptPrograms.map((p) => path.join("bin", p + exe));
  const libDir = path.join(root, "lib");
  const modules = readdirSync(libDir)
    .filter(
      (n) =>
        n.endsWith(module) &&
        (KEEP.modules.includes(path.basename(n, module)) || KEEP.conversion.test(path.basename(n, module))),
    )
    .map((n) => path.join("lib", n));
  for (const rel of [...programs, ...modules]) {
    if (!existsSync(path.join(root, rel))) throw new Error(`[stage-postgres] ${root} has no ${rel}`);
    copy(rel);
  }

  // Shared libraries the programs link. macOS (this repo's build) and Linux (theseus) link only
  // libpq from lib/ (both by the name below); everything else they link is the OS's. Windows
  // programs find their DLLs next to them in bin/.
  if (platform === "win32") {
    for (const dll of windowsDllClosure(
      root,
      [...programs, ...modules].map((rel) => path.join(root, rel)),
    ))
      copy(path.join("bin", dll));
  } else {
    copy(path.join("lib", platform === "darwin" ? "libpq.5.dylib" : "libpq.so.5"));
  }

  const extensionDir = path.join(root, "share", "extension");
  for (const name of readdirSync(extensionDir)) {
    const ext = name.replace(/(--.*)?\.(control|sql)$/, "");
    if (KEEP.extensions.includes(ext)) copy(path.join("share", "extension", name));
  }
  for (const name of KEEP.shareFiles) copy(path.join("share", name));
  for (const name of KEEP.shareDirs) if (existsSync(path.join(root, "share", name))) copy(path.join("share", name));
  // Licenses and readmes at the top level (Windows' covers the libraries in its DLLs).
  for (const name of readdirSync(root)) if (statSync(path.join(root, name)).isFile()) copy(name);
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

// The release a build-postgres-macos.sh output holds, from the README.txt it writes.
function ownBuildVersion(dir) {
  const readme = path.join(dir, "README.txt");
  const match = existsSync(readme) && /^PostgreSQL (\d+)\.(\d+) for Lifer/.exec(readFileSync(readme, "utf8"));
  if (!match) throw new Error(`[stage-postgres] ${dir} isn't a build-postgres-macos.sh build (no README.txt)`);
  return `${match[1]}.${match[2]}.0`;
}

// Stages the previous major's server at <stagingDir>/postgres-previous/<major> when this release
// bundles one (see PREVIOUS_POSTGRES_VERSION), or a note when it doesn't, so tauri.conf.json's
// resource entry always resolves. Returns its path or null.
async function stagePreviousPostgres(stagingDir, target, triple) {
  const parent = path.join(stagingDir, "postgres-previous");
  rmSync(parent, { recursive: true, force: true });
  mkdirSync(parent, { recursive: true });
  const ownDir = process.env.LIFER_POSTGRES_PREVIOUS_DIR?.trim();
  const version =
    process.env.LIFER_POSTGRES_PREVIOUS_VERSION?.trim() ||
    (ownDir ? ownBuildVersion(path.resolve(ownDir)) : PREVIOUS_POSTGRES_VERSION);
  if (!version) {
    writeFileSync(
      path.join(parent, "NOT-BUNDLED.txt"),
      "This release bundles no previous PostgreSQL major; see apps/desktop/scripts/stage-postgres.js.\n",
    );
    return null;
  }
  if (major(version) !== major(POSTGRES_VERSION) - 1) {
    throw new Error(
      `[stage-postgres] the previous major's server must be PostgreSQL ${major(POSTGRES_VERSION) - 1}, not ${version}`,
    );
  }
  if (!ownDir && target.platform === "darwin") {
    throw new Error(
      `[stage-postgres] this release bundles PostgreSQL ${version} for upgrades: run ` +
        `apps/desktop/scripts/build-postgres-macos.sh <dir> ${target.arch === "x64" ? "x86_64" : "arm64"} ${major(version)} ` +
        `and set LIFER_POSTGRES_PREVIOUS_DIR=<dir>`,
    );
  }
  const dest = path.join(parent, String(major(version)));
  const workDir = path.join(os.tmpdir(), `lifer-stage-postgres-previous-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    const root = ownDir ? path.resolve(ownDir) : await fetchTheseus(version, triple, workDir);
    copyKept(root, dest, target.platform, KEEP.previousPrograms);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(
    `[stage-postgres] bundled PostgreSQL ${version} for upgrades from ${ownDir || "theseus-rs/postgresql-binaries"} ` +
      `(${(dirSize(dest) / 1024 / 1024).toFixed(1)}MB)`,
  );
  return dest;
}

// Stages the bundled PostgreSQL at <stagingDir>/postgres, and the previous major's server when
// this release has one. Returns the former's path, or null when a local macOS build has none (the
// folder then holds only a note, so tauri.conf.json's resource entry still resolves).
export async function stagePostgres(stagingDir, target) {
  const current = await stageCurrentPostgres(stagingDir, target);
  await stagePreviousPostgres(stagingDir, target, PLATFORM[target.platform]?.triple[target.arch]);
  return current;
}

async function stageCurrentPostgres(stagingDir, target) {
  const dest = path.join(stagingDir, "postgres");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const triple = PLATFORM[target.platform]?.triple[target.arch];
  if (!triple) throw new Error(`[stage-postgres] no bundled PostgreSQL for ${target.platform}-${target.arch}`);

  const ownDir = process.env.LIFER_POSTGRES_DIR?.trim();
  if (!ownDir && target.platform === "darwin") {
    const arch = target.arch === "x64" ? "x86_64" : "arm64";
    const message =
      `[stage-postgres] a macOS build bundles the PostgreSQL that build-postgres-macos.sh makes: ` +
      `run apps/desktop/scripts/build-postgres-macos.sh <dir> ${arch} and set LIFER_POSTGRES_DIR=<dir>`;
    if (process.env.CI || target.cross) throw new Error(message);
    console.warn(
      `${message}. Continuing without one, since this isn't CI: this build downloads PostgreSQL on first launch (macOS 15+ only).`,
    );
    writeFileSync(
      path.join(dest, "NOT-BUNDLED.txt"),
      "This build has no bundled PostgreSQL; see apps/desktop/scripts/stage-postgres.js.\n",
    );
    return null;
  }

  const workDir = path.join(os.tmpdir(), `lifer-stage-postgres-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    if (ownDir && major(ownBuildVersion(path.resolve(ownDir))) !== major(POSTGRES_VERSION)) {
      throw new Error(
        `[stage-postgres] LIFER_POSTGRES_DIR holds PostgreSQL ${ownBuildVersion(path.resolve(ownDir))}, ` +
          `but this app bundles ${major(POSTGRES_VERSION)}`,
      );
    }
    const root = ownDir ? path.resolve(ownDir) : await fetchTheseus(POSTGRES_VERSION, triple, workDir);
    copyKept(root, dest, target.platform, KEEP.programs);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(
    `[stage-postgres] bundled PostgreSQL ${POSTGRES_VERSION} from ${ownDir || "theseus-rs/postgresql-binaries"} ` +
      `(${(dirSize(dest) / 1024 / 1024).toFixed(1)}MB)`,
  );
  return dest;
}
