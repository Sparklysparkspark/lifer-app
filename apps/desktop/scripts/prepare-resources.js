// Assembles apps/desktop/resources-staging/: the compiled API (apps/api/scripts/build.mjs), the built web app,
// a node_modules holding only the packages the compiled code loads, and the embedded database's
// PostgreSQL server (stage-postgres.js).
import {
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  linkSync,
  copyFileSync,
  chmodSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { target } from "./target.js";
import { retargetNatives } from "./retarget-natives.js";
import { stagePostgres } from "./stage-postgres.js";
import { assertPackagesLoad, slimPackage, traceRuntimePackages } from "../../../scripts/runtime-deps.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A real path, like the package folders traceRuntimePackages returns.
const REPO_ROOT = realpathSync(path.join(__dirname, "..", "..", ".."));
// Staged inside src-tauri because Tauri turns a "../" resource path into a literal "_up_"
// folder, which breaks api.rs's resources_root() lookup.
const STAGING = path.join(__dirname, "..", "src-tauri", "resources-staging");

// The compiled entry points the app launches: api/dist/index.js (api.rs), its
// localInferenceServer.js (local_inference.rs) and the workers they start, and data-pipeline's
// migrate.js (api.rs's run_migrations). The npm packages they import, plus everything those
// depend on, are what node_modules needs (scripts/runtime-deps.mjs, shared with the Docker image).
const API_DIST = path.join(REPO_ROOT, "apps", "api", "dist");
const PIPELINE_DIR = path.join(REPO_ROOT, "packages", "data-pipeline");

// Where each folder that holds a node_modules goes in the bundle, so Node's lookup finds the same
// copy of each package there as in the repo: from api/dist it walks api/node_modules, then
// node_modules; from node_modules/data-pipeline/dist, data-pipeline's own node_modules first.
const STAGED_ROOTS = {
  "": STAGING,
  "apps/api": path.join(STAGING, "api"),
  "packages/data-pipeline": path.join(STAGING, "node_modules", "data-pipeline"),
};

// What a workspace needs at runtime: its compiled code, its package.json ("type": "module") and,
// for data-pipeline, the SQL files migrate.js runs. Never its src, tests or coverage.
const WORKSPACE_RUNTIME_ENTRIES = ["package.json", "dist", "migrations"];

// Source maps are never read at runtime.
const notSourceMap = (p) => !p.endsWith(".map");

function stageWorkspace(dir, dest) {
  for (const entry of WORKSPACE_RUNTIME_ENTRIES) {
    const from = path.join(dir, entry);
    if (existsSync(from)) cpSync(from, path.join(dest, entry), { recursive: true, filter: notSourceMap });
  }
}

// Copies each traced package into the bundle, dereferencing symlinks since Tauri's bundler drops
// them. A package's own node_modules is skipped: the packages in it that are needed were traced
// too and are copied on their own. Returns the staged folder of each.
function copyRuntimePackages(keep) {
  const staged = [];
  for (const dir of keep) {
    const parts = path.relative(REPO_ROOT, dir).split(path.sep);
    const at = parts.indexOf("node_modules");
    if (at === -1) {
      // One of Lifer's own workspaces, imported by name rather than bundled into dist.
      const dest = path.join(STAGING, "node_modules", JSON.parse(readText(path.join(dir, "package.json"))).name);
      stageWorkspace(dir, dest);
      staged.push(dest);
      continue;
    }
    const base = STAGED_ROOTS[parts.slice(0, at).join("/")];
    if (base === undefined) throw new Error(`[prepare-resources] don't know where to bundle ${parts.join("/")}`);
    const dest = path.join(base, ...parts.slice(at));
    cpSync(dir, dest, {
      recursive: true,
      dereference: true,
      filter: (s) => notSourceMap(s) && !path.relative(dir, s).split(path.sep).includes("node_modules"),
    });
    staged.push(dest);
  }
  return staged;
}

function readText(p) {
  return readFileSync(p, "utf-8");
}

// npm sometimes installs extra per-libc variants of native packages (sharp). A musl-linked binary
// makes linuxdeploy fail on a glibc host, and this app never targets musl. Tracing already leaves
// out the ones that declare their libc; this also catches any that don't, by name.
function stripMuslVariants(stagingNodeModulesDir) {
  if (target.platform !== "linux") return; // musl is the one exotic case; nothing to strip on darwin/win32
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

function dirSizeBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    total += st.isDirectory() ? dirSizeBytes(full) : st.size;
  }
  return total;
}

// Removes what Node on the target never loads from each staged package: onnxruntime-node's
// binaries for other platforms (~283MB combined) and its GPU providers, and Transformers.js's
// browser builds. Runs after retargetNatives, so an Intel build slims the onnxruntime-node it
// swapped in (at the same path). The host platform packages it swapped out are gone, and the
// target's that replaced them have nothing to slim.
function slimStagedPackages(stagedDirs) {
  let freed = 0;
  const remove = (full) => {
    const st = statSync(full);
    freed += st.isDirectory() ? dirSizeBytes(full) : st.size;
    rmSync(full, { recursive: true, force: true });
  };
  for (const dir of stagedDirs) {
    if (existsSync(dir)) slimPackage(dir, { platform: target.platform, arch: target.arch, remove });
  }
  if (freed > 0)
    console.log(
      `[prepare-resources] stripped ${(freed / 1024 / 1024).toFixed(0)}MB that ${target.platform}-${target.arch} never loads`,
    );
}

// onnxruntime-node's unversioned dylib name is a symlink that dereference:true turns into a
// second 42MB copy. Both names must exist, so replace the duplicate with a hard link, which
// survives Tauri's resource copy.
function dedupeIdenticalOnnxDylibs(stagingNodeModulesDir) {
  dedupeIdenticalDylibsIn(path.join(stagingNodeModulesDir, "onnxruntime-node", "bin"));
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
    console.log(
      `[prepare-resources] hard-linked ${(savedBytes / 1024 / 1024).toFixed(0)}MB of duplicate onnxruntime native library file(s)`,
    );
  }
}

// Packages using the prebuildify convention (bare-path, bare-fs, bare-url via tar-fs) ship
// binaries for every platform under prebuilds/<platform>-<arch>/. Foreign ones (e.g. Android's
// bionic-linked .bare) make linuxdeploy fail the AppImage, so keep only the target's folder.
function stripNonHostPrebuilds(stagingNodeModulesDir) {
  const hostDir = `${target.platform}-${target.arch}`;
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

// ffmpeg-static's macOS binary is built with --enable-nonfree, which FFmpeg's license doesn't
// allow to be redistributed. Release builds point LIFER_FFMPEG_DIR at the output of
// build-ffmpeg-macos.sh, and its ffmpeg, ffmpeg.LICENSE and ffmpeg.README replace
// ffmpeg-static's in the bundle. The API still finds it through require("ffmpeg-static"), and the
// repo's own node_modules is untouched.
function substituteFfmpeg(stagingNodeModulesDir) {
  const dir = path.join(stagingNodeModulesDir, "ffmpeg-static");
  const binary = path.join(dir, target.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ownDir = process.env.LIFER_FFMPEG_DIR?.trim();
  // ffmpeg-static only downloaded the build machine's binary, so a cross build needs its own.
  if (target.cross && !ownDir) {
    throw new Error(
      `[prepare-resources] a ${target.triple} build needs LIFER_FFMPEG_DIR: build one with ` +
        `apps/desktop/scripts/build-ffmpeg-macos.sh <dir> ${target.arch === "x64" ? "x86_64" : target.arch}`,
    );
  }
  if (ownDir) {
    for (const name of ["ffmpeg", "ffmpeg.LICENSE", "ffmpeg.README"]) {
      if (!existsSync(path.join(ownDir, name))) throw new Error(`[prepare-resources] LIFER_FFMPEG_DIR has no ${name}`);
    }
    copyFileSync(path.join(ownDir, "ffmpeg"), binary);
    chmodSync(binary, 0o755);
    copyFileSync(path.join(ownDir, "ffmpeg.LICENSE"), path.join(dir, "ffmpeg.LICENSE"));
    copyFileSync(path.join(ownDir, "ffmpeg.README"), path.join(dir, "ffmpeg.README"));
    console.log(`[prepare-resources] using the ffmpeg from ${ownDir}`);
  }
  assertFfmpegRedistributable(binary);
}

// Whatever ends up bundled must not be a nonfree build. Fatal in CI, where installers are made
// for release; a warning locally, so `npm run dist` on a Mac still works without building ffmpeg.
function assertFfmpegRedistributable(binary) {
  if (!existsSync(binary)) {
    console.warn(`[prepare-resources] no ffmpeg at ${binary}; video imports won't work in this build`);
    return;
  }
  let buildconf;
  if (target.cross) {
    // An Intel binary can't run here without Rosetta. FFmpeg embeds its configure line as a
    // plain string, so read it from the file instead.
    buildconf = readFileSync(binary).toString("latin1");
  } else {
    const result = spawnSync(binary, ["-hide_banner", "-buildconf"], { encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(`[prepare-resources] ${binary} -buildconf failed: ${result.stderr || result.error}`);
    }
    buildconf = `${result.stdout}${result.stderr}`;
  }
  if (!buildconf.includes("--enable-nonfree")) return;
  const message =
    "[prepare-resources] the bundled ffmpeg is built with --enable-nonfree and can't be redistributed. " +
    "On macOS, build one with apps/desktop/scripts/build-ffmpeg-macos.sh and set LIFER_FFMPEG_DIR.";
  if (process.env.CI) throw new Error(message);
  console.warn(`${message} Continuing, since this isn't CI.`);
}

// Mach-O CPU types (mach/machine.h): CPU_TYPE_X86_64 and CPU_TYPE_ARM64.
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
// Load commands that declare the oldest macOS a Mach-O file runs on (mach-o/loader.h).
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

// The app's macOS floor: macOS refuses to open the app on anything older, and every native file
// in the bundle must run there too. Versions are packed as macOS does: major << 16 | minor << 8.
const MACOS_FLOOR = (() => {
  const conf = JSON.parse(readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf-8"));
  const version = conf.bundle?.macOS?.minimumSystemVersion;
  if (!/^\d+\.\d+$/.test(version ?? ""))
    throw new Error("[prepare-resources] tauri.conf.json needs bundle.macOS.minimumSystemVersion (major.minor)");
  const [major, minor] = version.split(".").map(Number);
  return { version, packed: (major << 16) | (minor << 8) };
})();
const formatMacosVersion = (v) => `${v >>> 16}.${(v >>> 8) & 0xff}${v & 0xff ? `.${v & 0xff}` : ""}`;

// The slices of a Mach-O file, each with its CPU type and the oldest macOS it declares (null if
// it declares none), or null if the file isn't one. A thin 64-bit file (magic 0xfeedfacf,
// little-endian on both Apple architectures) is one slice; a fat (universal) file (0xcafebabe,
// big-endian) lists each slice's offset in its header.
function machoSlices(file) {
  const fd = openSync(file, "r");
  const read = (position, length) => {
    const buf = Buffer.alloc(length);
    return buf.subarray(0, readSync(fd, buf, 0, length, position));
  };
  // One thin slice at `offset`: its CPU type, and minos from its load commands.
  const thin = (offset) => {
    const header = read(offset, 32);
    if (header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf) return null;
    // MH_OBJECT (1): a leftover .o from a node-gyp compile, never loaded at runtime.
    if (header.readUInt32LE(12) === 1) return null;
    const count = header.readUInt32LE(16);
    const commands = read(offset + 32, header.readUInt32LE(20));
    let minos = null;
    for (let i = 0, p = 0; i < count && p + 16 <= commands.length; i++) {
      const cmd = commands.readUInt32LE(p);
      if (cmd === LC_BUILD_VERSION && commands.readUInt32LE(p + 8) === PLATFORM_MACOS)
        minos = commands.readUInt32LE(p + 12);
      if (cmd === LC_VERSION_MIN_MACOSX) minos = commands.readUInt32LE(p + 8);
      const size = commands.readUInt32LE(p + 4);
      if (size === 0) break;
      p += size;
    }
    return { cpu: header.readUInt32LE(4), minos };
  };
  try {
    const header = read(0, 8 + 20 * 8);
    if (header.length < 16) return null;
    if (header.readUInt32LE(0) === 0xfeedfacf) {
      const slice = thin(0);
      return slice ? [slice] : null;
    }
    if (header.readUInt32BE(0) === 0xcafebabe) {
      // Java class files share this magic; their next field (a version) is far above any real
      // slice count.
      const count = header.readUInt32BE(4);
      if (count === 0 || count > 8 || header.length < 8 + 20 * count) return null;
      const slices = Array.from({ length: count }, (_, i) => thin(header.readUInt32BE(8 + 20 * i + 8))).filter(Boolean);
      return slices.length > 0 ? slices : null;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

// Every native binary in a macOS bundle must run on the target's CPU and on the app's oldest
// supported macOS. A binary that fails either loads fine on the build machine and fails on
// users' Macs, so check them all, in every build.
function assertMachoFiles(dir) {
  if (target.platform !== "darwin") return;
  const want = MACHO_CPU[target.arch];
  const wrongCpu = [];
  const tooNew = [];
  let checked = 0;
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const slices = machoSlices(full);
      if (!slices) continue;
      checked++;
      const slice = slices.find((s) => s.cpu === want);
      if (!slice) {
        wrongCpu.push(path.relative(dir, full));
        continue;
      }
      // A file with no version load command predates them (macOS 10.13 and older), so is fine.
      if (slice.minos !== null && slice.minos > MACOS_FLOOR.packed) {
        tooNew.push(`${path.relative(dir, full)} (macOS ${formatMacosVersion(slice.minos)})`);
      }
    }
  }
  walk(dir);
  const problems = [];
  if (wrongCpu.length > 0) {
    problems.push(`these native files aren't built for ${target.platform}-${target.arch}:\n  ${wrongCpu.join("\n  ")}`);
  }
  if (tooNew.length > 0) {
    problems.push(
      `these native files need a newer macOS than the app's minimum, ${MACOS_FLOOR.version} ` +
        `(tauri.conf.json bundle.macOS.minimumSystemVersion):\n  ${tooNew.join("\n  ")}`,
    );
  }
  if (problems.length > 0) throw new Error(`[prepare-resources] ${problems.join("\n")}`);
  console.log(
    `[prepare-resources] all ${checked} Mach-O files run on ${target.platform}-${target.arch}, macOS ${MACOS_FLOOR.version} or later`,
  );
}

async function main() {
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  // The compiled server; `npm run dist -w desktop` builds it first.
  if (!existsSync(path.join(API_DIST, "index.js")) || !existsSync(path.join(PIPELINE_DIR, "dist", "migrate.js"))) {
    throw new Error("apps/api/dist is missing: run `npm run build -w api` first");
  }
  cpSync(API_DIST, path.join(STAGING, "api", "dist"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "apps", "api", "package.json"), path.join(STAGING, "api", "package.json"));
  // migrate.js runs from node_modules/data-pipeline/dist (api.rs) and reads ../migrations.
  stageWorkspace(PIPELINE_DIR, path.join(STAGING, "node_modules", "data-pipeline"));

  cpSync(path.join(REPO_ROOT, "apps", "web", "dist"), path.join(STAGING, "web"), { recursive: true });

  // Traced against the installed tree, which is the build machine's: in a cross build it has the
  // host's native packages, which retargetNatives then swaps for the target's.
  const { entries, keep } = traceRuntimePackages({
    root: REPO_ROOT,
    distDirs: [API_DIST, path.join(PIPELINE_DIR, "dist")],
  });
  const staged = copyRuntimePackages(keep);
  console.log(`[prepare-resources] bundled ${keep.size} packages for: ${[...entries.keys()].sort().join(", ")}`);

  const stagedNodeModules = path.join(STAGING, "node_modules");
  if (target.cross) retargetNatives(stagedNodeModules, target);
  substituteFfmpeg(stagedNodeModules);
  slimStagedPackages(staged);
  stripMuslVariants(stagedNodeModules);
  stripNonHostPrebuilds(stagedNodeModules);
  dedupeIdenticalOnnxDylibs(stagedNodeModules);
  // The embedded database's server, so the app never downloads it (stage-postgres.js).
  await stagePostgres(STAGING, target);
  assertMachoFiles(STAGING);

  // Every package the server imports must load from the bundle alone, the way api.rs starts it.
  // A cross build's native binaries can't load here, so it only checks they're all found;
  // check-bundled-natives.js loads them under the target's Node.
  assertPackagesLoad([...entries.keys()], {
    fromDir: path.join(STAGING, "api", "dist"),
    confineTo: STAGING,
    resolveOnly: target.cross,
  });
  console.log(
    `[prepare-resources] all ${entries.size} imported packages ${target.cross ? "resolve" : "load"} from the bundle`,
  );

  console.log(`[prepare-resources] staged at ${STAGING}`);
}

await main();
