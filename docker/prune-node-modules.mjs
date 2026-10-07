// Docker build step: removes every installed npm package the compiled server can't load, so the
// image only ships what runs. Which packages those are is worked out by scripts/runtime-deps.mjs,
// which the desktop app's bundle (apps/desktop/scripts/prepare-resources.js) shares.
//
// Usage: node prune-node-modules.mjs <app dir> <dist dir>...
// Then it imports each entry package again, so a package it wrongly removed fails the build.
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { assertPackagesLoad, slimPackage, traceRuntimePackages } from "../scripts/runtime-deps.mjs";

const [appDir, ...distDirs] = process.argv.slice(2).map((p) => path.resolve(p));
if (!appDir || distDirs.length === 0) throw new Error("Usage: prune-node-modules.mjs <app dir> <dist dir>...");

const { entries, keep } = traceRuntimePackages({ root: appDir, distDirs });

function sizeOf(target) {
  const st = lstatSync(target);
  if (!st.isDirectory()) return st.size;
  return readdirSync(target).reduce((sum, entry) => sum + sizeOf(path.join(target, entry)), 0);
}

let removedBytes = 0;
const removed = [];
function remove(target) {
  removedBytes += sizeOf(target);
  removed.push(path.relative(appDir, target));
  rmSync(target, { recursive: true, force: true });
}

// Every node_modules folder, including ones inside packages (protobufjs/cli/node_modules).
function prune(nodeModules) {
  for (const entry of readdirSync(nodeModules)) {
    const full = path.join(nodeModules, entry);
    if (entry === ".bin" || entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(full)) pruneOne(path.join(full, scoped));
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    } else {
      pruneOne(full);
    }
  }
}
function pruneOne(full) {
  if (lstatSync(full).isSymbolicLink()) {
    // npm's links to Lifer's own workspaces: the build bundled them into dist.
    if (!keep.has(realpathSync(full))) rmSync(full);
    return;
  }
  if (!keep.has(full)) return remove(full);
  walk(full);
}
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!lstatSync(full).isDirectory()) continue;
    if (entry === "node_modules") prune(full);
    else walk(full);
  }
}
for (const root of [
  appDir,
  ...["apps", "packages"].flatMap((d) =>
    existsSync(path.join(appDir, d)) ? readdirSync(path.join(appDir, d)).map((w) => path.join(appDir, d, w)) : [],
  ),
]) {
  if (existsSync(path.join(root, "node_modules"))) prune(path.join(root, "node_modules"));
}

// Files inside kept packages that Node on this platform never loads.
for (const dir of keep) slimPackage(dir, { platform: process.platform, arch: process.arch, remove });

// npm's command links that now point at nothing.
for (const binDir of [path.join(appDir, "node_modules", ".bin")]) {
  if (!existsSync(binDir)) continue;
  for (const link of readdirSync(binDir)) if (!existsSync(path.join(binDir, link))) rmSync(path.join(binDir, link));
}

const collapsed = new Map();
for (const label of removed) {
  const key = label.replace(/^(.*?node_modules\/(@[^/]+\/)?[^/]+).*$/, "$1");
  collapsed.set(key, (collapsed.get(key) ?? 0) + 1);
}
console.log(`[prune] kept ${keep.size} packages for: ${[...entries.keys()].sort().join(", ")}`);
console.log(`[prune] removed ${(removedBytes / 1048576).toFixed(0)} MB: ${[...collapsed.keys()].sort().join(", ")}`);

// Every package the server imports must still load, with what's left.
assertPackagesLoad([...entries.keys()], { fromDir: distDirs[0] });
console.log(`[prune] all ${entries.size} imported packages load`);
