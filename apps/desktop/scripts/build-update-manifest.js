// Builds the Tauri updater artifact + manifest for a release: tars the already-resigned
// Lifer.app (see resign-macos.js's own comment — its ad-hoc signature is only valid once that
// script has run, so this MUST run after it, never against the raw `tauri build` output),
// signs the tarball with the updater's private key, and writes latest.json in the exact shape
// tauri-plugin-updater expects (see tauri.conf.json's plugins.updater.endpoints). Run from
// apps/desktop with LIFER_RELEASE_VERSION set (the pushed git tag, without its "v" prefix) and
// TAURI_SIGNING_PRIVATE_KEY/TAURI_SIGNING_PRIVATE_KEY_PASSWORD in the environment (GitHub
// Actions secrets — see .github/workflows/release.yml).
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

const archivePath = path.join(bundleDir, "Lifer.app.tar.gz");
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

const manifest = {
  version,
  notes: `See https://github.com/${GITHUB_REPO}/releases/tag/v${version} for details.`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature,
      url: `https://github.com/${GITHUB_REPO}/releases/download/v${version}/Lifer.app.tar.gz`,
    },
  },
};

const manifestPath = path.join(bundleDir, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[build-update-manifest] wrote ${manifestPath}`);
