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
import { execSync } from "node:child_process";
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

console.log(`[resign-macos] re-signing ${appPath}`);
execSync(`codesign --deep --force --sign - ${JSON.stringify(appPath)}`, { stdio: "inherit" });
execSync(`codesign -dv ${JSON.stringify(appPath)}`, { stdio: "inherit" });
console.log("[resign-macos] done");
