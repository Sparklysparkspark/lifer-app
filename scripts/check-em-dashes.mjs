#!/usr/bin/env node
// Fails when a tracked source file contains an em dash (U+2014). House style for Lifer's copy,
// docs and comments (see the code standards page): use a comma, colon, period or parentheses.
// Released migrations are history and never edited, so they're skipped.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_PATHS = [
  "apps",
  "e2e",
  "packages",
  "docs/docs",
  "docker",
  "scripts",
  ".github",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  ".env.example",
  "docker-compose.yml",
  "hwaccel.yml",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
];
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", "target", "resources-staging", "migrations"]);
const EXCLUDED_FILES = new Set(["package-lock.json"]);
const EM_DASH = String.fromCharCode(0x2014);

function isExcluded(file) {
  const parts = file.split("/");
  if (EXCLUDED_FILES.has(parts[parts.length - 1])) return true;
  return parts.slice(0, -1).some((part) => EXCLUDED_DIRS.has(part));
}

const files = execFileSync("git", ["ls-files", "-z", "--", ...SCAN_PATHS], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);
let hits = 0;
let offendingFiles = 0;

for (const file of files) {
  if (isExcluded(file)) continue;
  const fullPath = join(root, file);
  if (!existsSync(fullPath)) continue; // deleted in the working tree
  const buffer = readFileSync(fullPath);
  // A NUL byte near the start means a binary file.
  if (buffer.subarray(0, 8000).includes(0)) continue;
  const text = buffer.toString("utf8");
  if (!text.includes(EM_DASH)) continue;
  offendingFiles++;
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) {
      console.log(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      hits++;
    }
  });
}

if (hits > 0) {
  console.error(
    `\nFound ${hits} em dash(es) in ${offendingFiles} file(s). Use a comma, colon, period or parentheses instead.`,
  );
  process.exit(1);
}
console.log("No em dashes found.");
