// Tauri's own bundler ad-hoc signs Lifer.app during `tauri build`, but that signature has
// come back broken every time in practice — `spctl -a -vv` reports "code has no resources but
// signature indicates they must be present," which is exactly what macOS's Launch Services
// flags apps for in Finder (shown as a crossed-out-circle badge over the app icon). Likely
// cause: the signing step runs before the ~10,000+ files staged under resources-staging/
// node_modules are all in place, so the seal Tauri computes doesn't match the bundle's final
// contents. Re-signing from scratch after the bundle is fully assembled produces a seal that
// actually matches what's on disk. This is still only an ad-hoc signature (no paid Apple
// Developer ID here), so Gatekeeper's spctl assessment will still say "rejected" for an
// unidentified developer — that's expected for a local dev build and unrelated to the Finder
// icon bug this fixes; a real release would need a genuine signing identity instead.
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
  console.error(`[resign-macos] ${appPath} doesn't exist — did tauri build actually produce a bundle?`);
  process.exit(1);
}

// macOS gates access to a user's Desktop/Documents/Downloads folders (and removable volumes —
// see the multi-drive feature) behind its own TCC consent system, entirely separate from normal
// Unix file permissions: without the matching NSXxxUsageDescription key in Info.plist, macOS
// doesn't just skip showing a consent prompt, it can silently deny access outright, and that
// looks IDENTICAL to a real permissions bug from the app's side (a plain EPERM on scandir/open,
// no dialog ever shown) — confirmed live: a real user's own "Lifer Photos" folder under Desktop
// hit exactly this once the app started scanning it directly rather than going through the
// folder picker (which itself grants scoped access regardless of these keys, masking the gap
// until reimport/rescan tried to walk the tree unprompted). Tauri's own config has no field for
// arbitrary Info.plist keys (bundle.macOS here is only entitlements, currently null), so these
// have to be patched in after Tauri's own bundling step, same as the codesign step below —
// PlistBuddy must run BEFORE signing, since signing reseals the bundle against whatever
// Info.plist contains at that moment; patching after would invalidate the signature.
const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
// Same TCC gap as the folder-access keys above, for the Near Me feature's "use my current
// location" button: without NSLocationWhenInUseUsageDescription, WKWebView's own
// navigator.geolocation doesn't just skip the system permission prompt, it never shows one at
// all and getCurrentPosition's error callback fires immediately — indistinguishable from a real
// permission DENIAL from the app's own side, confirmed live (the button just silently failed,
// with no prompt ever appearing for the user to grant or deny in the first place).
const usageDescriptions = {
  NSDesktopFolderUsageDescription: "Lifer reads your photo library folder, which some users keep under Desktop.",
  NSDocumentsFolderUsageDescription: "Lifer reads your photo library folder, which some users keep under Documents.",
  NSDownloadsFolderUsageDescription: "Lifer reads your photo library folder, which some users keep under Downloads.",
  NSRemovableVolumesUsageDescription: "Lifer reads photo libraries and RAW imports stored on external drives.",
  NSLocationWhenInUseUsageDescription: "Lifer uses your location to find nearby species records and hotspots.",
};
// execFileSync (argv array, no shell) rather than execSync's shell-string form — PlistBuddy's
// own "-c" command language has its own tiny quoting/tokenizing rules, and going through a
// shell on top of that meant two layers of quoting fighting each other (a value with spaces,
// wrapped in shell double-quotes, wrapped again in PlistBuddy's own command string, broke
// outright — confirmed live). One argv element per PlistBuddy argument sidesteps the shell
// entirely; PlistBuddy itself is fine with a plain unquoted multi-word value in "Add"/"Set".
for (const [key, value] of Object.entries(usageDescriptions)) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, infoPlistPath], { stdio: "pipe" });
  } catch {
    // "Add" fails if the key already exists (e.g. re-running this script against an
    // already-patched bundle without a clean rebuild) — Set instead in that case.
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, infoPlistPath], { stdio: "inherit" });
  }
}
console.log("[resign-macos] patched Info.plist with folder-access usage descriptions");

console.log(`[resign-macos] re-signing ${appPath}`);
execSync(`codesign --deep --force --sign - ${JSON.stringify(appPath)}`, { stdio: "inherit" });
execSync(`codesign -dv ${JSON.stringify(appPath)}`, { stdio: "inherit" });
console.log("[resign-macos] done");
