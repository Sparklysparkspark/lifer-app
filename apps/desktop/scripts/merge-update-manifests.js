// Combines the arm64 and x86_64 macOS jobs' partial updater manifests (see
// build-update-manifest.js) into the single real latest.json a release actually ships —
// tauri-plugin-updater expects ONE manifest with both platform keys present, and uploading two
// same-named latest.json release assets would just have the second job's upload silently
// clobber the first. Run from the repo root after downloading both jobs' `latest-*.json`
// artifacts into a single directory: node merge-update-manifests.js <dir> <outputPath>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , inputDir, outputPath] = process.argv;
if (!inputDir || !outputPath) {
  console.error("Usage: node merge-update-manifests.js <dir-of-latest-*.json> <outputPath>");
  process.exit(1);
}

const manifestFiles = readdirSync(inputDir, { recursive: true }).filter(
  (f) => typeof f === "string" && /^latest-(aarch64|x86_64)\.json$/.test(path.basename(f)),
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
    // version/notes/pub_date are identical across both jobs (same tag, same release) — only
    // `platforms` actually needs combining.
    merged.platforms = { ...merged.platforms, ...partial.platforms };
  }
  console.log(`[merge-update-manifests] merged ${full} (${Object.keys(partial.platforms).join(", ")})`);
}

writeFileSync(outputPath, JSON.stringify(merged, null, 2));
console.log(`[merge-update-manifests] wrote ${outputPath} with platforms: ${Object.keys(merged.platforms).join(", ")}`);
