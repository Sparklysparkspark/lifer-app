// Assembles apps/desktop-tauri/resources-staging/ — the Tauri equivalent of the Electron
// build's extraResources + afterPack.js (see apps/desktop/package.json and
// apps/desktop/afterPack.js). Reuses the exact same node_modules dependency-closure filter
// electron-builder used (read live from apps/desktop/package.json rather than duplicated here,
// so the two builds can't silently drift while both exist during the migration) — that filter
// was computed from package-lock.json's real resolved dependency graph after two rounds of
// fixing misses (fs-minipass, the whole @fastify scope), not guessed.
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
// Staged INSIDE src-tauri (not apps/desktop-tauri directly) — a bundle resource path needs
// "../" to reach anywhere outside src-tauri, and Tauri mangles that into a literal "_up_"
// folder inside Resources/ rather than actually resolving upward, which broke the app's own
// runtime resource lookup (api.rs's resources_root() expects Resources/api, not
// Resources/_up_/resources-staging/api). Staying inside src-tauri avoids that entirely.
const STAGING = path.join(__dirname, "..", "src-tauri", "resources-staging");

function loadNodeModulesExcludeSet() {
  const desktopPkg = JSON.parse(readText(path.join(REPO_ROOT, "apps", "desktop", "package.json")));
  const entry = desktopPkg.build.extraResources.find((e) => e.to === "node_modules");
  const names = entry.filter.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
  // This app's OWN workspace symlink in root node_modules (npm names it after whatever
  // package.json "name" was at `npm install` time, "appsdesktop-tauri" from the original
  // scaffold) — dereference:true below follows symlinks, so leaving this in causes an
  // infinite self-copy (resources-staging copied into itself, forever) rather than a merely
  // wasteful one.
  names.push("appsdesktop-tauri", "appsdesktop-tauri-spike", "desktop-tauri");
  return new Set(names);
}

function readText(p) {
  return readFileSync(p, "utf-8");
}

function copyNodeModules(exclude) {
  const src = path.join(REPO_ROOT, "node_modules");
  const dest = path.join(STAGING, "node_modules");
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (exclude.has(name)) continue;
    cpSync(path.join(src, name), path.join(dest, name), { recursive: true, dereference: true });
  }
}

function main() {
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  cpSync(path.join(REPO_ROOT, "apps", "api", "src"), path.join(STAGING, "api", "src"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "apps", "api", "package.json"), path.join(STAGING, "api", "package.json"));

  cpSync(path.join(REPO_ROOT, "apps", "web", "dist"), path.join(STAGING, "web"), { recursive: true });

  // Copied DIRECTLY into node_modules (not a separate packages/ folder symlinked from there) —
  // the Electron build's afterPack.js used a symlink to recreate what npm workspace hoisting
  // normally provides in dev (apps/api/src/regions/routes.ts does a live
  // `import ... from "data-pipeline/..."` at request time), but Tauri's bundler silently drops
  // symlinks entirely when copying `resources` (they just don't show up in the built .app at
  // all) rather than preserving or resolving them, so a real copy in the right place is the
  // only option here.
  mkdirSync(path.join(STAGING, "node_modules", "@lifer"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "packages", "shared", "src"), path.join(STAGING, "node_modules", "@lifer", "shared", "src"), {
    recursive: true,
  });
  cpSync(
    path.join(REPO_ROOT, "packages", "shared", "package.json"),
    path.join(STAGING, "node_modules", "@lifer", "shared", "package.json"),
  );

  cpSync(
    path.join(REPO_ROOT, "packages", "data-pipeline", "src"),
    path.join(STAGING, "node_modules", "data-pipeline", "src"),
    { recursive: true },
  );
  if (existsSync(path.join(REPO_ROOT, "packages", "data-pipeline", "migrations"))) {
    cpSync(
      path.join(REPO_ROOT, "packages", "data-pipeline", "migrations"),
      path.join(STAGING, "node_modules", "data-pipeline", "migrations"),
      { recursive: true },
    );
  }
  cpSync(
    path.join(REPO_ROOT, "packages", "data-pipeline", "package.json"),
    path.join(STAGING, "node_modules", "data-pipeline", "package.json"),
  );

  const exclude = loadNodeModulesExcludeSet();
  copyNodeModules(exclude);

  console.log(`[prepare-resources] staged at ${STAGING}`);
}

main();
