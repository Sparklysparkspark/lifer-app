#!/usr/bin/env node
// Fails when a dependency (npm lockfile or the desktop app's cargo graph) has a licence outside
// the allowlist, or when the committed ledger (scripts/licences-ledger.txt) is out of date.
// A new dependency or a changed licence shows up as a ledger diff to review. Run with --update
// to rewrite the ledger. The cargo graph is read offline from the crates cargo already fetched;
// set LICENCES_CARGO_ONLINE=1 (CI does) to let cargo fetch them.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(root, "scripts", "licences-ledger.txt");

// Permissive licences, plus MPL-2.0 (file-level copyleft) and the LGPL/GPL family, which are
// compatible with Lifer's AGPL-3.0 when used as separate libraries or binaries.
const ALLOWED = new Set(
  [
    "0BSD",
    "AGPL-3.0-only",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD",
    "BSL-1.0",
    "CC-BY-4.0",
    "CC0-1.0",
    "CDLA-Permissive-2.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MIT/X11",
    "MPL-2.0",
    "PostgreSQL",
    "Python-2.0",
    "Unicode-3.0",
    "Unlicense",
    "Zlib",
  ].map((s) => s.toLowerCase()),
);

// Packages whose licence the allowlist would not accept, each with the reason it is fine.
const EXCEPTIONS = {
  "ffmpeg-static": "GPL-3.0-or-later: downloads an ffmpeg binary that Lifer runs as a separate process",
  "libheif-js": "LGPL-3.0: unmodified library, replaceable",
  "@img/sharp-libvips-*": "LGPL-3.0-or-later: sharp's prebuilt libvips, dynamically linked and replaceable",
  "@img/sharp-*": "contains LGPL-3.0-or-later libvips binaries, as above",
  buffers: "no licence field published; check the upstream repository before relying on it",
  "combine-errors": "no licence field published; check the upstream repository before relying on it",
  "parse-cache-control": "legacy `licenses` field only (BSD)",
};

/** Whether an SPDX expression is acceptable: an OR needs one allowed side, an AND needs both. */
function accepted(expr) {
  const tokens = expr.replace(/[()]/g, " $& ").split(/\s+/).filter(Boolean);
  let i = 0;
  const atom = () => {
    if (tokens[i] === "(") {
      i++;
      const ok = or();
      i++; // ")"
      return ok;
    }
    const id = tokens[i++].toLowerCase();
    if (tokens[i]?.toUpperCase() === "WITH") i += 2; // an exception clause only widens the licence
    return ALLOWED.has(id);
  };
  const and = () => {
    let ok = atom();
    while (tokens[i]?.toUpperCase() === "AND") {
      i++;
      ok = atom() && ok;
    }
    return ok;
  };
  const or = () => {
    let ok = and();
    while (tokens[i]?.toUpperCase() === "OR") {
      i++;
      ok = and() || ok;
    }
    return ok;
  };
  // Cargo's older "MIT/Apache-2.0" and "A / B" spellings mean OR.
  const normalised = expr.replace(/\s*\/\s*/g, " OR ");
  if (normalised !== expr) return accepted(normalised);
  return or();
}

const exceptionFor = (name) =>
  Object.entries(EXCEPTIONS).find(([k]) => (k.endsWith("*") ? name.startsWith(k.slice(0, -1)) : k === name));

/** "ecosystem\tname\tlicence" for every distinct package name; versions of one name merge. */
function collect() {
  const rows = new Map();
  const add = (eco, name, licence) => {
    const key = `${eco}\t${name}`;
    const set = rows.get(key) ?? new Set();
    set.add(licence);
    rows.set(key, set);
  };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (!key.includes("node_modules/") || pkg.link) continue;
    const licence = typeof pkg.license === "string" ? pkg.license : "UNKNOWN";
    add("npm", key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length), licence);
  }
  const cargoDir = join(root, "apps", "desktop", "src-tauri");
  if (existsSync(join(cargoDir, "Cargo.lock"))) {
    const args = [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      ...(process.env.LICENCES_CARGO_ONLINE ? [] : ["--offline"]),
    ];
    const meta = JSON.parse(
      execFileSync("cargo", args, { cwd: cargoDir, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] }),
    );
    for (const pkg of meta.packages) if (pkg.source) add("cargo", pkg.name, pkg.license ?? "UNKNOWN");
  }
  return [...rows].map(([k, v]) => `${k}\t${[...v].sort().join(" ; ")}`).sort();
}

const lines = collect();
const problems = [];
for (const line of lines) {
  const [eco, name, licence] = line.split("\t");
  if (licence.split(" ; ").every((l) => l !== "UNKNOWN" && accepted(l)) || exceptionFor(name)) continue;
  problems.push(`${eco} ${name}: ${licence} is not in the allowlist (scripts/check-licences.mjs)`);
}

const ledger = `${lines.join("\n")}\n`;
if (process.argv.includes("--update")) {
  writeFileSync(LEDGER, ledger);
  console.log(`Wrote ${lines.length} entries to scripts/licences-ledger.txt`);
} else if (!existsSync(LEDGER) || readFileSync(LEDGER, "utf8") !== ledger) {
  const old = new Set(existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n") : []);
  const now = new Set(lines);
  for (const l of lines) if (!old.has(l)) problems.push(`ledger: new or changed: ${l.replaceAll("\t", " ")}`);
  for (const l of old) if (l && !now.has(l)) problems.push(`ledger: gone or changed: ${l.replaceAll("\t", " ")}`);
  problems.push("Review the changes above, then run: npm run check:licences -- --update");
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Licences: ${lines.length} dependencies, all allowed, ledger current.`);
