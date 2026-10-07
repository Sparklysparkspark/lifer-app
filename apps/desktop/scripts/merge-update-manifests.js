// Combines each matrix job's partial manifest (latest-<platformKey>.json, from
// build-update-manifest.js) into the single latest.json the updater expects. Run from the repo
// root after downloading every job's artifacts into one directory:
//   node merge-update-manifests.js <dir> <outputPath> [notesFile]
// A missing platform (its build leg failed) only warns: the other platforms still get updates.
// notesFile, when given and non-empty, replaces the manifest's notes with the real changelog.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , inputDir, outputPath, notesFile] = process.argv;
const EXPECTED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"];
if (!inputDir || !outputPath) {
  console.error("Usage: node merge-update-manifests.js <dir-of-latest-*.json> <outputPath>");
  process.exit(1);
}

const manifestFiles = readdirSync(inputDir, { recursive: true }).filter(
  (f) => typeof f === "string" && /^latest-.+\.json$/.test(path.basename(f)),
);
if (manifestFiles.length === 0) {
  console.error(`[merge-update-manifests] no latest-*.json found under ${inputDir}`);
  process.exit(1);
}

let merged = null;
for (const file of manifestFiles) {
  const full = path.join(inputDir, file);
  const partial = JSON.parse(readFileSync(full, "utf8"));
  if (!merged) {
    merged = partial;
  } else {
    // version/notes/pub_date match across jobs; only `platforms` needs combining.
    merged.platforms = { ...merged.platforms, ...partial.platforms };
  }
  console.log(`[merge-update-manifests] merged ${full} (${Object.keys(partial.platforms).join(", ")})`);
}

const missing = EXPECTED_PLATFORMS.filter((p) => !(p in merged.platforms));
if (missing.length > 0) {
  console.warn(`::warning::[merge-update-manifests] no update entry for ${missing.join(", ")}; those users won't see this update`);
}

if (notesFile && existsSync(notesFile)) {
  const notes = readFileSync(notesFile, "utf8").trim();
  if (notes) merged.notes = notes;
}

writeFileSync(outputPath, JSON.stringify(merged, null, 2));
console.log(`[merge-update-manifests] wrote ${outputPath} with platforms: ${Object.keys(merged.platforms).join(", ")}`);
