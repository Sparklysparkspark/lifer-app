// Tauri's ad-hoc signature is sealed before all staged resources are in place, so Finder flags
// the app as broken. Re-sign after the bundle is fully assembled. Still ad-hoc unless an
// identity is set (see below), so Gatekeeper rejecting it is expected for a local build.
import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin") {
  console.log("[resign-macos] not on macOS, skipping");
  process.exit(0);
}

const appPath = path.join(
  __dirname,
  "..",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Lifer.app",
);

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

// A stable identity (CI imports a self-signed "Lifer" cert and sets MACOS_SIGNING_IDENTITY) keeps
// TCC grants and the updater's designated-requirement check stable across versions. Ad-hoc ("-")
// when unset, so a local `npm run dist` still works without any certificate.
const identity = process.env.MACOS_SIGNING_IDENTITY?.trim() || "-";
console.log(`[resign-macos] re-signing ${appPath} with identity ${identity === "-" ? "ad-hoc (-)" : JSON.stringify(identity)}`);
execFileSync("codesign", ["--deep", "--force", "--sign", identity, appPath], { stdio: "inherit" });
execSync(`codesign -dv ${JSON.stringify(appPath)}`, { stdio: "inherit" });
console.log("[resign-macos] done");
