// Prints the CHANGELOG.md section for one version, used for the GitHub release body and the
// in-app updater's release notes. Falls back to the [Unreleased] section if the heading wasn't
// renamed to the version before tagging, so notes are never empty.
// Usage: node extract-changelog-section.js <version> [changelogPath]
import { readFileSync } from "node:fs";

const [, , version, changelogPath = "CHANGELOG.md"] = process.argv;
if (!version) {
  console.error("Usage: node extract-changelog-section.js <version> [changelogPath]");
  process.exit(1);
}

const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);

function section(matches) {
  const out = [];
  let found = false;
  for (const line of lines) {
    if (line.startsWith("## [")) {
      if (found) break;
      found = matches(line);
      continue;
    }
    if (found) out.push(line);
  }
  return out.join("\n").trim();
}

const text = section((l) => l.startsWith(`## [${version}]`)) || section((l) => l.startsWith("## [Unreleased]"));
process.stdout.write(text ? `${text}\n` : "");
