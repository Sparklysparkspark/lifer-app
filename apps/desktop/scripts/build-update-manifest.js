// Builds the Tauri updater artifact + manifest for a release, one platform key per matrix job:
// - macOS: tars the already-resigned Lifer.app (see resign-macos.js's own comment — its ad-hoc
//   signature is only valid once that script has run, so this MUST run after it, never against
//   the raw `tauri build` output) and signs the tarball.
// - Windows: signs the NSIS installer .exe directly — that's what tauri-plugin-updater expects
//   to download and silently run on Windows, no archiving step needed.
// - Linux: signs the AppImage directly (also just one file, no archiving). Deliberately does
//   NOT publish an update entry for the .deb build — Tauri's updater has no supported in-place
//   self-update path for a package-manager-installed app (its files live under a root-owned
//   prefix a regular user process can't overwrite), so .deb users stay on the existing
//   download-and-reinstall flow. AppImage is the only Linux format this can realistically cover.
//
// Each matrix job (macOS arm64, Windows x64, Linux x64) runs this and writes its own PARTIAL
// manifest — just this job's platform key — in the shape tauri-plugin-updater expects (see
// tauri.conf.json's plugins.updater.endpoints). merge-update-manifests.js (release.yml's
// merge-update-manifest job) combines all of them into the single real latest.json the release
// actually ships, since uploading several same-named latest.json release assets would just have
// the last one silently clobber the rest. Run from apps/desktop with LIFER_RELEASE_VERSION set
// (the pushed git tag, without its "v" prefix) and TAURI_SIGNING_PRIVATE_KEY/
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD in the environment (GitHub Actions secrets — see
// .github/workflows/release.yml).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_REPO = "Sparklysparkspark/lifer-app";
const BUNDLE_ROOT = path.join(__dirname, "..", "src-tauri", "target", "release", "bundle");

const version = process.env.LIFER_RELEASE_VERSION;
if (!version) {
  console.error("[build-update-manifest] LIFER_RELEASE_VERSION is not set");
  process.exit(1);
}

// Tauri's own target-triple naming: Apple Silicon is "aarch64", everything else this project
// builds on is "x86_64" — matches process.arch's "arm64"/"x64" one-to-one, just spelled
// differently.
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";

function findOne(dir, matcher) {
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(matcher);
  return match ? path.join(dir, match) : null;
}

function signAndDescribe(filePath, platformKey, downloadFileName) {
  console.log(`[build-update-manifest] signing ${filePath}`);
  execSync(`npx tauri signer sign ${JSON.stringify(filePath)}`, { stdio: "inherit" });
  const sigPath = `${filePath}.sig`;
  if (!existsSync(sigPath)) {
    console.error(`[build-update-manifest] ${sigPath} wasn't produced — signing must have failed`);
    process.exit(1);
  }
  return {
    [platformKey]: {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${downloadFileName}`,
    },
  };
}

let platforms;
if (process.platform === "darwin") {
  const bundleDir = path.join(BUNDLE_ROOT, "macos");
  const appPath = path.join(bundleDir, "Lifer.app");
  if (!existsSync(appPath)) {
    console.error(`[build-update-manifest] ${appPath} doesn't exist — did tauri build + resign-macos actually run first?`);
    process.exit(1);
  }
  const archiveName = `Lifer-${arch}.app.tar.gz`;
  const archivePath = path.join(bundleDir, archiveName);
  console.log(`[build-update-manifest] archiving ${appPath}`);
  execSync(`tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(bundleDir)} Lifer.app`, { stdio: "inherit" });
  platforms = signAndDescribe(archivePath, `darwin-${arch}`, archiveName);
} else if (process.platform === "win32") {
  const bundleDir = path.join(BUNDLE_ROOT, "nsis");
  const installerPath = findOne(bundleDir, (f) => f.endsWith(".exe"));
  if (!installerPath) {
    console.error(`[build-update-manifest] no .exe found under ${bundleDir} — did tauri build run first?`);
    process.exit(1);
  }
  platforms = signAndDescribe(installerPath, `windows-${arch}`, path.basename(installerPath));
} else if (process.platform === "linux") {
  const bundleDir = path.join(BUNDLE_ROOT, "appimage");
  const appImagePath = findOne(bundleDir, (f) => f.endsWith(".AppImage"));
  if (!appImagePath) {
    console.error(`[build-update-manifest] no .AppImage found under ${bundleDir} — did tauri build run first?`);
    process.exit(1);
  }
  platforms = signAndDescribe(appImagePath, `linux-${arch}`, path.basename(appImagePath));
} else {
  console.error(`[build-update-manifest] unrecognized platform ${process.platform}`);
  process.exit(1);
}

// Written into one fixed, OS-independent location (rather than each platform's own differently-
// named bundle subdir) so release.yml's "upload partial manifest" step needs only one glob that
// works the same for every matrix job.
const manifestDir = path.join(BUNDLE_ROOT, "update-manifest");
mkdirSync(manifestDir, { recursive: true });
const manifest = {
  version,
  notes: `See https://github.com/${GITHUB_REPO}/releases/tag/v${version} for details.`,
  pub_date: new Date().toISOString(),
  platforms,
};
const manifestPath = path.join(manifestDir, `latest-${Object.keys(platforms)[0]}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[build-update-manifest] wrote ${manifestPath}`);
