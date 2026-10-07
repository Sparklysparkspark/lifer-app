// Builds the Tauri updater artifact and a partial manifest for one matrix job's platform:
// - macOS: tars and signs the Lifer.app, so it must run after resign-macos.js.
// - Windows: signs the NSIS installer .exe, which the updater runs directly.
// - Linux: signs the AppImage. No .deb entry, since the updater can't self-update a
//   package-manager install.
//
// merge-update-manifests.js combines the partial manifests into one latest.json. Needs
// LIFER_RELEASE_VERSION (tag without "v") and TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] (see release.yml).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// bundleRoot is target/release/bundle, or target/<triple>/release/bundle for a cross build.
import { target, tauriArch, bundleRoot } from "./target.js";

// The Tauri CLI's own entry point, run with this Node: no shell, so paths are passed as-is.
const tauriCli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");

const GITHUB_REPO = "Sparklysparkspark/lifer-app";

const version = process.env.LIFER_RELEASE_VERSION;
if (!version) {
  console.error("[build-update-manifest] LIFER_RELEASE_VERSION is not set");
  process.exit(1);
}

// Tauri's target naming: "aarch64" for Apple Silicon, "x86_64" otherwise. From the build's
// target, not this machine: the Intel macOS app is cross-built on Apple Silicon and must be
// listed as darwin-x86_64.
const arch = tauriArch;

function findOne(dir, matcher) {
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(matcher);
  return match ? path.join(dir, match) : null;
}

function signAndDescribe(filePath, platformKey, downloadFileName) {
  console.log(`[build-update-manifest] signing ${filePath}`);
  execFileSync(process.execPath, [tauriCli, "signer", "sign", filePath], { stdio: "inherit" });
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
if (target.platform === "darwin") {
  const bundleDir = path.join(bundleRoot, "macos");
  const appPath = path.join(bundleDir, "Lifer.app");
  if (!existsSync(appPath)) {
    console.error(
      `[build-update-manifest] ${appPath} doesn't exist. Did tauri build + resign-macos actually run first?`,
    );
    process.exit(1);
  }
  const archiveName = `Lifer-${arch}.app.tar.gz`;
  const archivePath = path.join(bundleDir, archiveName);
  console.log(`[build-update-manifest] archiving ${appPath}`);
  execFileSync("tar", ["-czf", archivePath, "-C", bundleDir, "Lifer.app"], { stdio: "inherit" });
  platforms = signAndDescribe(archivePath, `darwin-${arch}`, archiveName);
} else if (target.platform === "win32") {
  const bundleDir = path.join(bundleRoot, "nsis");
  const installerPath = findOne(bundleDir, (f) => f.endsWith(".exe"));
  if (!installerPath) {
    console.error(`[build-update-manifest] no .exe found under ${bundleDir}. Did tauri build run first?`);
    process.exit(1);
  }
  platforms = signAndDescribe(installerPath, `windows-${arch}`, path.basename(installerPath));
} else if (target.platform === "linux") {
  const bundleDir = path.join(bundleRoot, "appimage");
  const appImagePath = findOne(bundleDir, (f) => f.endsWith(".AppImage"));
  if (!appImagePath) {
    console.error(`[build-update-manifest] no .AppImage found under ${bundleDir}. Did tauri build run first?`);
    process.exit(1);
  }
  platforms = signAndDescribe(appImagePath, `linux-${arch}`, path.basename(appImagePath));
} else {
  console.error(`[build-update-manifest] unrecognized platform ${target.platform}`);
  process.exit(1);
}

// One fixed output location so release.yml's upload step needs a single glob.
const manifestDir = path.join(bundleRoot, "update-manifest");
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
