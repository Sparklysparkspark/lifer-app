// Builds the Tauri updater artifact and a partial manifest for one matrix job's platform:
// - macOS: tars and signs the Lifer.app, so it must run after resign-macos.js.
// - Windows: signs the NSIS installer .exe, which the updater runs directly.
// - Linux: signs the AppImage. No .deb entry, since the updater can't self-update a
//   package-manager install.
//
// merge-update-manifests.js combines the partial manifests into one latest.json. Needs
// LIFER_RELEASE_VERSION (tag without "v") and TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] (see release.yml).
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

// Tauri's target naming: "aarch64" for Apple Silicon, "x86_64" otherwise.
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
    console.error(`[build-update-manifest] ${sigPath} wasn't produced; signing must have failed`);
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
    console.error(`[build-update-manifest] ${appPath} doesn't exist. Did tauri build + resign-macos actually run first?`);
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
    console.error(`[build-update-manifest] no .exe found under ${bundleDir}. Did tauri build run first?`);
    process.exit(1);
  }
  platforms = signAndDescribe(installerPath, `windows-${arch}`, path.basename(installerPath));
} else if (process.platform === "linux") {
  const bundleDir = path.join(BUNDLE_ROOT, "appimage");
  const appImagePath = findOne(bundleDir, (f) => f.endsWith(".AppImage"));
  if (!appImagePath) {
    console.error(`[build-update-manifest] no .AppImage found under ${bundleDir}. Did tauri build run first?`);
    process.exit(1);
  }
  platforms = signAndDescribe(appImagePath, `linux-${arch}`, path.basename(appImagePath));
} else {
  console.error(`[build-update-manifest] unrecognized platform ${process.platform}`);
  process.exit(1);
}

// One fixed output location so release.yml's upload step needs a single glob.
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
