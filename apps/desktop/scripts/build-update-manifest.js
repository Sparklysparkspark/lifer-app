// Builds the Tauri updater artifact + manifest for a release: tars the already-resigned
// Lifer.app (see resign-macos.js's own comment — its ad-hoc signature is only valid once that
// script has run, so this MUST run after it, never against the raw `tauri build` output),
// signs the tarball with the updater's private key, and writes a PARTIAL manifest — just this
// job's own architecture — in the shape tauri-plugin-updater expects (see tauri.conf.json's
// plugins.updater.endpoints). Two macOS matrix jobs (arm64 + x86_64) each run this and produce
// their own darwin-aarch64/darwin-x86_64 archive + partial manifest; a separate merge job
// (release.yml's merge-update-manifest) combines both into the single real latest.json the
// release actually ships, since uploading two same-named latest.json release assets would just
// have the second silently clobber the first. Run from apps/desktop with LIFER_RELEASE_VERSION
// set (the pushed git tag, without its "v" prefix) and TAURI_SIGNING_PRIVATE_KEY/
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD in the environment (GitHub Actions secrets — see
// .github/workflows/release.yml).
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_REPO = "Sparklysparkspark/lifer-app";

if (process.platform !== "darwin") {
  console.log("[build-update-manifest] not on macOS, skipping (no other platform is built yet)");
  process.exit(0);
}

const version = process.env.LIFER_RELEASE_VERSION;
if (!version) {
  console.error("[build-update-manifest] LIFER_RELEASE_VERSION is not set");
  process.exit(1);
}

const bundleDir = path.join(__dirname, "..", "src-tauri", "target", "release", "bundle", "macos");
const appPath = path.join(bundleDir, "Lifer.app");
if (!existsSync(appPath)) {
  console.error(`[build-update-manifest] ${appPath} doesn't exist — did tauri build + resign-macos actually run first?`);
  process.exit(1);
}

// Tauri's own target-triple naming: Apple Silicon is "aarch64", Intel is "x86_64" — matches
// process.arch's "arm64"/"x64" one-to-one, just spelled differently.
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const archiveName = `Lifer-${arch}.app.tar.gz`;

const archivePath = path.join(bundleDir, archiveName);
console.log(`[build-update-manifest] archiving ${appPath}`);
execSync(`tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(bundleDir)} Lifer.app`, { stdio: "inherit" });

console.log(`[build-update-manifest] signing ${archivePath}`);
execSync(`npx tauri signer sign ${JSON.stringify(archivePath)}`, { stdio: "inherit" });

const sigPath = `${archivePath}.sig`;
if (!existsSync(sigPath)) {
  console.error(`[build-update-manifest] ${sigPath} wasn't produced — signing must have failed`);
  process.exit(1);
}
const signature = readFileSync(sigPath, "utf8").trim();

// Partial manifest — just this job's one platform entry. merge-update-manifest.js combines
// the arm64 and x86_64 jobs' partial manifests into the single real latest.json the release
// ships (same `notes`/`pub_date`/`version` either way, so a naive last-write-wins merge of the
// `platforms` objects is all that's needed).
const manifest = {
  version,
  notes: `See https://github.com/${GITHUB_REPO}/releases/tag/v${version} for details.`,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${arch}`]: {
      signature,
      url: `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${archiveName}`,
    },
  },
};

const manifestPath = path.join(bundleDir, `latest-${arch}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[build-update-manifest] wrote ${manifestPath}`);
