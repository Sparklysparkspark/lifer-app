// Assembles apps/desktop/resources-staging/ — everything the packaged Tauri app needs bundled
// alongside the Rust binary: the (unmodified) API source run via tsx, the built web app, and a
// pruned copy of node_modules holding only what's actually needed at runtime.
import { mkdirSync, rmSync, cpSync, readFileSync, readdirSync, statSync, existsSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
// Staged INSIDE src-tauri (not apps/desktop directly) — a bundle resource path needs "../" to
// reach anywhere outside src-tauri, and Tauri mangles that into a literal "_up_" folder inside
// Resources/ rather than actually resolving upward, which broke the app's own runtime resource
// lookup (api.rs's resources_root() expects Resources/api, not
// Resources/_up_/resources-staging/api). Staying inside src-tauri avoids that entirely.
const STAGING = path.join(__dirname, "..", "src-tauri", "resources-staging");

// The runtime dependency closure for apps/api (+ data-pipeline + shared) computed from
// package-lock.json's real resolved dependency graph, not guessed — everything else in the
// hoisted root node_modules is dev/build-only tooling (electron-builder... err, now just
// vite/typescript/etc.) with no business in a shipped app. See node-modules-exclude.json's own
// generation: same lockfile-closure approach used for the old Electron build, after two rounds
// of fixing real misses there (fs-minipass, the whole @fastify scope) — kept as a separate,
// regeneratable data file now that there's no sibling Electron config left to read it from.
//
// One hand-added carve-out beyond the lockfile closure: "exceljs" (~25MB) is a real dependency
// edge (data-pipeline/src/fetch/fetch-avonet.ts imports it) but that file is only ever run
// directly as a one-off data-enrichment script (via build-seed.ts/build-seed-test.ts, both
// dev/build tooling) — no route the shipped app actually serves imports it, so it's excluded
// here even though a pure lockfile-closure walk would keep it. If a future regeneration of this
// file drops this entry, re-add it (or re-verify fetch-avonet.ts really is still unreachable at
// runtime and remove this comment instead).
function loadNodeModulesExcludeSet() {
  const names = JSON.parse(readText(path.join(__dirname, "node-modules-exclude.json")));
  // This app's OWN workspace symlink in root node_modules (npm names it after whatever
  // package.json "name" is at `npm install` time) — dereference:true below follows symlinks,
  // so leaving this in causes an infinite self-copy (resources-staging copied into itself,
  // forever) rather than a merely wasteful one. Covers current and past names from this app's
  // own history in case a stale symlink from an earlier rename lingers in node_modules.
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

  // npm doesn't always hoist every package to the root — a workspace whose own required
  // version range conflicts with what something else at the root wants keeps its own nested
  // node_modules instead (confirmed case: apps/api's "tar" — root has none at all, only a
  // copy nested here and under packages/data-pipeline). Anything root-only closure
  // computation naturally misses those, since it only ever looks at root node_modules — a
  // real crash this caused once already (ERR_MODULE_NOT_FOUND for "tar" at runtime, not a
  // build-time error, since nothing checks these files actually exist until the app tries to
  // import them). Overlaying each workspace's own nested node_modules on top of the root copy
  // catches whatever the root-only pass missed; not exclude-filtered since these folders are
  // already small and workspace-specific by construction, not the sprawling hoisted root tree.
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
      // No nested node_modules for this workspace — everything it needs was hoisted. Fine.
    }
  }
}

// onnxruntime-node ships GPU execution provider .so files (CUDA/TensorRT/ROCm) alongside the
// CPU one it actually needs — species/embeddings.ts only ever asks for the CPU provider (see
// that file's own comment: no Python runtime, CPU inference by design), so these are pure dead
// weight. Worse than dead weight on Linux specifically: linuxdeploy resolves every ELF's shared
// library dependencies as it bundles the AppImage, and libonnxruntime_providers_tensorrt.so
// needs libcublas.so.13 (an NVIDIA CUDA library no CI runner or most end-user Linux desktops
// have installed) — linuxdeploy can't find it and hard-fails the whole bundle rather than just
// warning. Stripping these before staging fixes the Linux build and trims real bytes off every
// platform's shipped app for a feature (GPU inference) this app never uses.
function stripOnnxGpuProviders(stagingNodeModulesDir) {
  const binDir = path.join(stagingNodeModulesDir, "onnxruntime-node", "bin");
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
    // No onnxruntime-node/bin in this build (e.g. it wasn't in the dependency closure) — fine.
  }
  if (removed > 0) console.log(`[prepare-resources] stripped ${removed} onnxruntime GPU provider file(s)`);
}

// Several native packages (sharp, lightningcss, and presumably others we haven't hit yet) ship
// a separate optionalDependency per platform/libc combo (linux-x64-gnu, linux-x64-musl,
// darwin-arm64, ...) — npm is supposed to install only the one matching the current host, but
// this has a known history of installing extra variants anyway in some npm-version/lockfile
// combos (confirmed here for both sharp and lightningcss). Harmless on its own, except
// linuxdeploy hard-fails the WHOLE AppImage bundle on the first native binary it can't resolve
// every shared-library dependency for, and a musl-linked .node/.so pulls in musl's own libc
// (libc.musl-x86_64.so.1), which a glibc-based Ubuntu runner doesn't have. Rather than
// allowlisting mismatched variants one package at a time as each one surfaces a new CI failure,
// sweep every package directory (including scoped ones) for "musl" in its name and strip it —
// this app never targets an Alpine/musl host, so a musl-named package is always safe to drop.
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

// onnxruntime-node ships prebuilt native bindings for EVERY platform it supports
// (bin/napi-v6/{darwin,linux,win32}/...) inside the single npm package — normal for a package
// meant to be installed once and run cross-platform, but a build FOR one specific host only
// ever needs its own platform's subfolder. Confirmed via `du -sh`: darwin/linux/win32 sum to
// ~283MB combined in a real install, so shipping the other two platforms' binaries alongside
// the one this build actually runs on is real, substantial dead weight — not the ~1-2MB a naive
// glance at file COUNT would suggest.
function stripNonHostOnnxPlatforms(stagingNodeModulesDir) {
  const napiDir = path.join(stagingNodeModulesDir, "onnxruntime-node", "bin", "napi-v6");
  let removedBytes = 0;
  function dirSizeBytes(dir) {
    let total = 0;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      total += st.isDirectory() ? dirSizeBytes(full) : st.size;
    }
    return total;
  }
  try {
    for (const platformDir of readdirSync(napiDir)) {
      if (platformDir === process.platform) continue;
      const full = path.join(napiDir, platformDir);
      if (!statSync(full).isDirectory()) continue;
      removedBytes += dirSizeBytes(full);
      rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // No onnxruntime-node/bin/napi-v6 in this build (e.g. excluded from the dependency
    // closure entirely) — fine, nothing to strip.
  }
  if (removedBytes > 0) {
    console.log(`[prepare-resources] stripped ${(removedBytes / 1024 / 1024).toFixed(0)}MB of non-host onnxruntime platform binaries`);
  }
}

// onnxruntime-node's own package ships BOTH the fully-versioned dylib (e.g.
// libonnxruntime.1.29.0.dylib, the real file) and an unversioned/major-version-only name
// (libonnxruntime.1.dylib) that's a symlink to it, following normal shared-library versioning
// convention — but copyNodeModules above uses `dereference: true` (needed elsewhere so Tauri's
// resource bundler doesn't just silently drop symlinks — see its own comment), which turns that
// symlink into a second, byte-identical real file copy (confirmed via MD5: 42MB duplicated in a
// real build). Both filenames still need to actually exist on disk (the loader may reference
// either), so this can't just delete one — replacing the duplicate with a hard link to the
// first copy keeps both names resolvable while sharing the same on-disk bytes. Hard links (not
// symlinks) survive Tauri's resource-copy step because they're indistinguishable from a normal
// file to anything that isn't specifically checking inode counts.
function dedupeIdenticalOnnxDylibs(stagingNodeModulesDir) {
  const binDir = path.join(stagingNodeModulesDir, "onnxruntime-node", "bin");
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
    // No onnxruntime-node/bin in this build — fine, nothing to dedupe.
  }
  if (savedBytes > 0) {
    console.log(`[prepare-resources] hard-linked ${(savedBytes / 1024 / 1024).toFixed(0)}MB of duplicate onnxruntime native library file(s)`);
  }
}

// data-pipeline is a real workspace package the packaged app imports from at runtime (see
// main()'s own comment on copyNodeModules resolving its symlink into a real file copy) — but
// its package directory ALSO holds dev/build-only artifacts that have no business shipping:
// data/ (raw + cached GBIF downloads, e.g. gbif-country-cache/ — 40GB+ locally, confirmed the
// single largest thing in the entire staged app by two orders of magnitude), packs/ (built pack
// tarballs — these get published to a GitHub Release and downloaded on demand by the running
// app, never read from the local package directory), and coverage/ (vitest coverage reports).
// None of these are ever imported by any runtime code path (only src/, migrations/, and
// package.json are). Confirmed this exact bug live TWICE: a built .app measured 43GB, of which
// 42GB was this one package directory's dev artifacts, not actual app code — and a first fix
// attempt that copied everything and then deleted these dirs afterward still needed enough free
// disk to hold the full 41GB+ copy at its peak, which exhausted this machine's disk entirely
// (ENOSPC mid-copy) before the delete step ever ran. Filtering these paths OUT during the copy
// itself (cpSync's own `filter` option, below) avoids that peak entirely — the bytes are never
// written in the first place, not written then removed.
const DATA_PIPELINE_DEV_ONLY_DIRS = ["data", "packs", "coverage"];

// Source maps (1,300+ files, ~80MB across the staged node_modules in a real measured build) are
// purely a debugging aid for whoever authored the package — nothing in this app's own runtime
// ever reads a .js.map file, so they're dead weight in every shipped build.
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

  // data-pipeline and @lifer/shared (apps/api/src/regions/routes.ts does a live
  // `import ... from "data-pipeline/..."` at request time) both come along for free below, via
  // copyNodeModules's normal exclude-list-driven copy: npm workspaces already links them into
  // root node_modules as real symlinks, and dereference:true there resolves those into real
  // file copies — exactly what's needed, since Tauri's bundler silently drops symlinks
  // entirely when copying `resources` (they just don't show up in the built .app at all)
  // rather than preserving or resolving them. No special-casing needed as long as neither name
  // is in the exclude list (both are real `dependencies`, so the lockfile-closure computation
  // that generated node-modules-exclude.json already keeps them).
  const exclude = loadNodeModulesExcludeSet();
  copyNodeModules(exclude);
  stripOnnxGpuProviders(path.join(STAGING, "node_modules"));
  stripMuslVariants(path.join(STAGING, "node_modules"));
  stripNonHostOnnxPlatforms(path.join(STAGING, "node_modules"));
  dedupeIdenticalOnnxDylibs(path.join(STAGING, "node_modules"));

  console.log(`[prepare-resources] staged at ${STAGING}`);
}

main();
