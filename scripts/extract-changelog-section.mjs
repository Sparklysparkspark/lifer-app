// Prints the CHANGELOG.md section for one version, used for the GitHub release body and the
// in-app updater's release notes. Fails when that version has no section (or an empty one), so a
// release can't go out with missing notes: rename [Unreleased] to the version before tagging.
// Usage: node scripts/extract-changelog-section.mjs <version> [changelogPath]
import { readFileSync } from "node:fs";

const [, , version, changelogPath = "CHANGELOG.md"] = process.argv;
if (!version) {
  console.error("Usage: node scripts/extract-changelog-section.mjs <version> [changelogPath]");
  process.exit(1);
}

const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
const out = [];
let found = false;
for (const line of lines) {
  if (line.startsWith("## [")) {
    if (found) break;
    found = line.startsWith(`## [${version}]`);
    continue;
  }
  if (found) out.push(line);
}

const text = out.join("\n").trim();
if (!text) {
  console.error(`${changelogPath} has no notes for ${version}. Add a "## [${version}] - YYYY-MM-DD" section.`);
  process.exit(1);
}
process.stdout.write(`${text}\n`);
