// Assembles apps/desktop/resources-staging/: the API source (run via tsx), the built web app,
// and a pruned node_modules holding only runtime dependencies.
import { mkdirSync, rmSync, cpSync, readFileSync, readdirSync, statSync, existsSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
// Staged inside src-tauri because Tauri turns a "../" resource path into a literal "_up_"
// folder, which breaks api.rs's resources_root() lookup.
const STAGING = path.join(__dirname, "..", "src-tauri", "resources-staging");

// Runtime dependency closure for apps/api, data-pipeline and shared, computed from
// package-lock.json (see node-modules-exclude.json). Everything else hoisted is dev tooling.
// "exceljs" is excluded by hand (only a one-off data script uses it); keep it there on regeneration.
function loadNodeModulesExcludeSet() {
  const names = JSON.parse(readText(path.join(__dirname, "node-modules-exclude.json")));
  // This app's own workspace symlinks: dereference:true would copy resources-staging into
  // itself forever. Includes past names in case a stale symlink lingers.
  names.push("desktop", "desktop-tauri", "appsdesktop-tauri", "appsdesktop-tauri-spike");
  return new Set(names);
}

function readText(p) {
  return readFileSync(p, "utf-8");
}

function copyNodeModules(exclude) {
  const dest = path.join(STAGING, "node_modules");
  mkdirSync(dest, { recursive: true });

  const src = path.join(REPO_ROOT, "node_modules");
  for (const name of readdirSync(src)) {
    if (exclude.has(name)) continue;
    cpSync(path.join(src, name), path.join(dest, name), {
      recursive: true,
      dereference: true,
      filter: (s) => !shouldSkipDuringCopy(s),
    });
  }

  // npm keeps a workspace's conflicting versions in its own nested node_modules (e.g. apps/api's
  // "tar"), which the root-only closure misses. Overlay each workspace's nested copy on top.
  for (const workspaceDir of ["apps/api", "packages/data-pipeline", "packages/shared"]) {
    const nested = path.join(REPO_ROOT, workspaceDir, "node_modules");
    try {
      for (const name of readdirSync(nested)) {
        cpSync(path.join(nested, name), path.join(dest, name), {
          recursive: true,
          dereference: true,
          filter: (s) => !shouldSkipDuringCopy(s),
        });
      }
    } catch {
      // No nested node_modules for this workspace; everything was hoisted.
    }
  }
}

// Strip onnxruntime-node's unused GPU provider .so files (TensorRT needs libcublas and breaks
// linuxdeploy). Covers every copy, including @xenova/transformers' nested one, which must ship.
const ONNX_NODE_DIRS = ["onnxruntime-node", path.join("@xenova", "transformers", "node_modules", "onnxruntime-node")];

function stripOnnxGpuProviders(stagingNodeModulesDir) {
  for (const dir of ONNX_NODE_DIRS) stripOnnxGpuProvidersIn(path.join(stagingNodeModulesDir, dir, "bin"));
}

function stripOnnxGpuProvidersIn(binDir) {
  let removed = 0;
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/providers_(cuda|tensorrt|rocm)/i.test(name)) {
        rmSync(full);
        removed++;
      }
    }
  }
  try {
    walk(binDir);
  } catch {
    // No onnxruntime-node/bin in this build (e.g. not in the dependency closure).
  }
  if (removed > 0) console.log(`[prepare-resources] stripped ${removed} onnxruntime GPU provider file(s)`);
}

// npm sometimes installs extra per-libc variants of native packages (sharp, lightningcss). A
// musl-linked binary makes linuxdeploy fail on a glibc host, and this app never targets musl,
// so strip every package with "musl" in its name.
function stripMuslVariants(stagingNodeModulesDir) {
  if (process.platform !== "linux") return; // musl is the one exotic case; nothing to strip on darwin/win32
  let removed = 0;
  for (const entry of readdirSync(stagingNodeModulesDir)) {
    const entryPath = path.join(stagingNodeModulesDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;
    if (entry.startsWith("@")) {
      for (const scopedEntry of readdirSync(entryPath)) {
        if (!/musl/i.test(scopedEntry)) continue;
        rmSync(path.join(entryPath, scopedEntry), { recursive: true, force: true });
        removed++;
      }
      continue;
    }
    if (!/musl/i.test(entry)) continue;
    rmSync(entryPath, { recursive: true, force: true });
    removed++;
  }
  if (removed > 0) console.log(`[prepare-resources] stripped ${removed} musl-linked package dir(s)`);
}

// onnxruntime-node ships native bindings for every platform (~283MB combined), but a build
// only needs its own host's.
function dirSizeBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    total += st.isDirectory() ? dirSizeBytes(full) : st.size;
  }
  return total;
}

// Removes every child dir of `dir` except `keep`, returning the bytes freed.
function removeSiblingDirs(dir, keep) {
  let freed = 0;
  for (const name of readdirSync(dir)) {
    if (name === keep) continue;
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    freed += dirSizeBytes(full);
    rmSync(full, { recursive: true, force: true });
  }
  return freed;
}

// Layout is bin/napi-v<N>/<platform>/<arch>/. Builds are native (no cross target), so keep only
// the host's platform and arch, same assumption stripNonHostPrebuilds makes.
function stripNonHostOnnxPlatforms(stagingNodeModulesDir) {
  let removedBytes = 0;
  for (const dir of ONNX_NODE_DIRS) {
    const binDir = path.join(stagingNodeModulesDir, dir, "bin");
    let napiDirs;
    try {
      napiDirs = readdirSync(binDir).filter((n) => n.startsWith("napi-v"));
    } catch {
      continue; // this copy isn't in the bundle
    }
    for (const napi of napiDirs) {
      const napiDir = path.join(binDir, napi);
      removedBytes += removeSiblingDirs(napiDir, process.platform);
      const hostPlatformDir = path.join(napiDir, process.platform);
      if (existsSync(hostPlatformDir)) removedBytes += removeSiblingDirs(hostPlatformDir, process.arch);
    }
  }
  if (removedBytes > 0) {
    console.log(`[prepare-resources] stripped ${(removedBytes / 1024 / 1024).toFixed(0)}MB of non-host onnxruntime platform binaries`);
  }
}

// onnxruntime-node's unversioned dylib name is a symlink that dereference:true turns into a
// second 42MB copy. Both names must exist, so replace the duplicate with a hard link, which
// survives Tauri's resource copy.
function dedupeIdenticalOnnxDylibs(stagingNodeModulesDir) {
  for (const dir of ONNX_NODE_DIRS) dedupeIdenticalDylibsIn(path.join(stagingNodeModulesDir, dir, "bin"));
}

function dedupeIdenticalDylibsIn(binDir) {
  const byHash = new Map();
  let savedBytes = 0;
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".dylib") && !name.endsWith(".so")) continue;
      const hash = createHash("md5").update(readFileSync(full)).digest("hex");
      const existing = byHash.get(hash);
      if (!existing) {
        byHash.set(hash, full);
        continue;
      }
      const size = statSync(full).size;
      rmSync(full);
      linkSync(existing, full);
      savedBytes += size;
    }
  }
  try {
    walk(binDir);
  } catch {
    // No onnxruntime-node/bin in this build, so nothing to dedupe.
  }
  if (savedBytes > 0) {
    console.log(`[prepare-resources] hard-linked ${(savedBytes / 1024 / 1024).toFixed(0)}MB of duplicate onnxruntime native library file(s)`);
  }
}

// @xenova/transformers imports onnxruntime-web, but in Node its wasm never loads, so the
// browser bundles and wasm can go.
function slimOnnxruntimeWeb(stagingNodeModulesDir) {
  const pkgDir = path.join(stagingNodeModulesDir, "onnxruntime-web");
  let main;
  try {
    main = JSON.parse(readText(path.join(pkgDir, "package.json"))).main;
  } catch {
    return; // not in the bundle
  }
  if (main !== "dist/ort-web.node.js") {
    console.warn(`[prepare-resources] onnxruntime-web main is ${main}, not slimming it`);
    return;
  }
  let freed = 0;
  const distDir = path.join(pkgDir, "dist");
  for (const name of readdirSync(distDir)) {
    if (name === "ort-web.node.js") continue;
    const full = path.join(distDir, name);
    const st = statSync(full);
    freed += st.isDirectory() ? dirSizeBytes(full) : st.size;
    rmSync(full, { recursive: true, force: true });
  }
  for (const name of ["lib", "types", "docs"]) {
    const full = path.join(pkgDir, name);
    if (!existsSync(full)) continue;
    freed += dirSizeBytes(full);
    rmSync(full, { recursive: true, force: true });
  }
  console.log(`[prepare-resources] slimmed onnxruntime-web by ${(freed / 1024 / 1024).toFixed(0)}MB`);
}

// Packages using the prebuildify convention (bare-path, bare-fs, bare-url via tar-fs) ship
// binaries for every platform under prebuilds/<platform>-<arch>/. Foreign ones (e.g. Android's
// bionic-linked .bare) make linuxdeploy fail the AppImage, so keep only the host's folder.
function stripNonHostPrebuilds(stagingNodeModulesDir) {
  const hostDir = `${process.platform}-${process.arch}`;
  let removed = 0;
  function stripIn(pkgDir) {
    const prebuildsDir = path.join(pkgDir, "prebuilds");
    let entries;
    try {
      entries = readdirSync(prebuildsDir);
    } catch {
      return; // no prebuilds/ dir in this package
    }
    for (const platformDir of entries) {
      if (platformDir === hostDir) continue;
      const full = path.join(prebuildsDir, platformDir);
      if (!statSync(full).isDirectory()) continue;
      rmSync(full, { recursive: true, force: true });
      removed++;
    }
  }
  for (const name of readdirSync(stagingNodeModulesDir)) {
    const entryPath = path.join(stagingNodeModulesDir, name);
    if (!statSync(entryPath).isDirectory()) continue;
    if (name.startsWith("@")) {
      for (const scopedName of readdirSync(entryPath)) {
        stripIn(path.join(entryPath, scopedName));
      }
      continue;
    }
    stripIn(entryPath);
  }
  if (removed > 0) {
    console.log(`[prepare-resources] stripped ${removed} non-host prebuilds/ platform dir(s)`);
  }
}

// data-pipeline ships at runtime, but its data/ (40GB+ of GBIF caches), packs/ and coverage/
// dirs are dev-only. Filtering them out during the copy avoids needing that much free disk.
const DATA_PIPELINE_DEV_ONLY_DIRS = ["data", "packs", "coverage"];

// Source maps (~80MB) are never read at runtime.
function shouldSkipDuringCopy(srcPath) {
  if (srcPath.endsWith(".map")) return true;
  const segments = srcPath.split(path.sep);
  const idx = segments.lastIndexOf("data-pipeline");
  if (idx === -1) return false;
  return DATA_PIPELINE_DEV_ONLY_DIRS.includes(segments[idx + 1]);
}

function main() {
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  cpSync(path.join(REPO_ROOT, "apps", "api", "src"), path.join(STAGING, "api", "src"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "apps", "api", "package.json"), path.join(STAGING, "api", "package.json"));

  cpSync(path.join(REPO_ROOT, "apps", "web", "dist"), path.join(STAGING, "web"), { recursive: true });

  // data-pipeline and @lifer/shared arrive via copyNodeModules (dereferenced, since Tauri's
  // bundler drops symlinks). Neither may appear in the exclude list.
  const exclude = loadNodeModulesExcludeSet();
  copyNodeModules(exclude);
  stripOnnxGpuProviders(path.join(STAGING, "node_modules"));
  stripMuslVariants(path.join(STAGING, "node_modules"));
  stripNonHostOnnxPlatforms(path.join(STAGING, "node_modules"));
  stripNonHostPrebuilds(path.join(STAGING, "node_modules"));
  dedupeIdenticalOnnxDylibs(path.join(STAGING, "node_modules"));
  slimOnnxruntimeWeb(path.join(STAGING, "node_modules"));

  console.log(`[prepare-resources] staged at ${STAGING}`);
}

main();
