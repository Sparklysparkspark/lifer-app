// Assembles apps/desktop/resources-staging/ — everything the packaged Tauri app needs bundled
// alongside the Rust binary: the (unmodified) API source run via tsx, the built web app, and a
// pruned copy of node_modules holding only what's actually needed at runtime.
import { mkdirSync, rmSync, cpSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    cpSync(path.join(src, name), path.join(dest, name), { recursive: true, dereference: true });
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
        cpSync(path.join(nested, name), path.join(dest, name), { recursive: true, dereference: true });
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

  console.log(`[prepare-resources] staged at ${STAGING}`);
}

main();
