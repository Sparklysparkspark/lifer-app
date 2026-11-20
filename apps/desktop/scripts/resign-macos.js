// Tauri's ad-hoc signature is sealed before all staged resources are in place, so Finder flags
// the app as broken. Re-sign after the bundle is fully assembled. Still ad-hoc unless an
// identity is set (see below), so Gatekeeper rejecting it is expected for a local build.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import path from "node:path";
import { bundleRoot } from "./target.js";

if (process.platform !== "darwin") {
  console.log("[resign-macos] not on macOS, skipping");
  process.exit(0);
}

// target/release/bundle, or target/<triple>/release/bundle for a cross build (target.js).
const appPath = path.join(bundleRoot, "macos", "Lifer.app");

if (!existsSync(appPath)) {
  console.error(`[resign-macos] ${appPath} doesn't exist. Did tauri build actually produce a bundle?`);
  process.exit(1);
}

// Without these usage descriptions, macOS TCC silently denies Desktop/Documents/Downloads and
// removable-volume access (a bare EPERM, no prompt). Tauri can't set arbitrary Info.plist keys,
// so patch them here, before signing, since signing seals Info.plist.
const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
// Same TCC gap for Near Me's "use my location": without this key, geolocation fails
// immediately with no prompt.
const usageDescriptions = {
  NSDesktopFolderUsageDescription: "Lifer reads your photo library folder, which some users keep under Desktop.",
  NSDocumentsFolderUsageDescription: "Lifer reads your photo library folder, which some users keep under Documents.",
  NSDownloadsFolderUsageDescription: "Lifer reads your photo library folder, which some users keep under Downloads.",
  NSRemovableVolumesUsageDescription: "Lifer reads photo libraries and RAW imports stored on external drives.",
  NSLocationWhenInUseUsageDescription: "Lifer uses your location to find nearby species records and hotspots.",
};
// execFileSync with an argv array avoids shell quoting fighting PlistBuddy's own -c quoting.
for (const [key, value] of Object.entries(usageDescriptions)) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, infoPlistPath], { stdio: "pipe" });
  } catch {
    // "Add" fails if the key already exists (a re-run on a patched bundle), so fall back to Set.
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, infoPlistPath], { stdio: "inherit" });
  }
}
console.log("[resign-macos] patched Info.plist with folder-access usage descriptions");

// A stable identity (CI imports a certificate and sets MACOS_SIGNING_IDENTITY) keeps TCC grants
// and the updater's designated-requirement check stable across versions. Ad-hoc ("-") when unset,
// so a local `npm run dist` still works without any certificate.
const identity = process.env.MACOS_SIGNING_IDENTITY?.trim() || "-";
console.log(
  `[resign-macos] re-signing ${appPath} with identity ${identity === "-" ? "ad-hoc (-)" : JSON.stringify(identity)}`,
);
if (process.env.MACOS_NOTARIZE === "1") {
  signForNotarization(identity);
  notarize();
} else {
  execFileSync("codesign", ["--deep", "--force", "--sign", identity, appPath], { stdio: "inherit" });
}
execFileSync("codesign", ["-dv", appPath], { stdio: "inherit" });
console.log("[resign-macos] done");

// Notarization needs every Mach-O file signed with the hardened runtime and a timestamp, including
// the ones under Resources that `codesign --deep` never visits (PostgreSQL, FFmpeg, native modules).
function signForNotarization(id) {
  if (id === "-") throw new Error("[resign-macos] MACOS_NOTARIZE=1 needs a Developer ID identity");
  const entitlements = path.join(import.meta.dirname, "..", "src-tauri", "entitlements.plist");
  const sign = (file) =>
    execFileSync(
      "codesign",
      ["--force", "--options", "runtime", "--timestamp", "--entitlements", entitlements, "--sign", id, file],
      { stdio: "pipe" },
    );
  // Deepest first, so a file is never changed after whatever contains it was sealed.
  const files = machOFiles(path.join(appPath, "Contents")).sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const file of files) sign(file);
  console.log(`[resign-macos] signed ${files.length} binaries for notarization`);
  sign(appPath);
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
}

function machOFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...machOFiles(full));
    else if (entry.isFile() && isMachO(full)) found.push(full);
  }
  return found;
}

function isMachO(file) {
  const head = Buffer.alloc(8);
  const fd = openSync(file, "r");
  try {
    if (readSync(fd, head, 0, 8, 0) < 8) return false;
  } finally {
    closeSync(fd);
  }
  const magic = head.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  // A universal binary; Java class files share the magic but carry a version number here instead.
  return magic === 0xcafebabe && head.readUInt32BE(4) < 20;
}

// App Store Connect API key (MACOS_NOTARY_KEY_PATH, _KEY_ID, _ISSUER). Stapling lets the app open
// offline without Gatekeeper asking Apple.
function notarize() {
  const { MACOS_NOTARY_KEY_PATH: key, MACOS_NOTARY_KEY_ID: keyId, MACOS_NOTARY_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer)
    throw new Error("[resign-macos] MACOS_NOTARIZE=1 needs MACOS_NOTARY_KEY_PATH, _KEY_ID and _ISSUER");
  const zip = path.join(path.dirname(appPath), "Lifer-notarize.zip");
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zip], { stdio: "inherit" });
  try {
    execFileSync(
      "xcrun",
      ["notarytool", "submit", zip, "--key", key, "--key-id", keyId, "--issuer", issuer, "--wait", "--timeout", "1h"],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(zip, { force: true });
  }
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  execFileSync("spctl", ["--assess", "--type", "execute", "--verbose", appPath], { stdio: "inherit" });
}
