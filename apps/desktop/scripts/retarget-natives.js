// For a cross-architecture macOS build (the Intel app built on Apple Silicon, see target.js):
// replaces the host's native binaries in the staged node_modules with the target's. `npm ci`
// only installed the build machine's, and each package picks its binary differently:
//
// - Prebuilt platform packages (sharp's @img/sharp-*, @node-rs/argon2-*): npm installs only
//   the optionalDependency whose os/cpu match. Installing the package that lists them (sharp,
//   @node-rs/argon2) with `npm install --os --cpu` picks the target's instead. (npm 10 applies
//   --os/--cpu only to optional dependencies, so the platform packages can't be named directly.)
// - onnxruntime-node ships every platform's binaries in one package, and prepare-resources.js
//   keeps the target's. But it stopped shipping Intel macOS binaries after 1.23, so an Intel
//   build bundles 1.23.2 (pinned below) in place of the repo's version. @huggingface/transformers
//   uses that same top-level copy (it pins the repo's version, so npm doesn't nest one). Its own
//   nested onnxruntime-common (a newer one) only builds the input tensors, which onnxruntime-node
//   1.23.2 reads by their type, dims and data, so the two work together.
//
// npm checks every downloaded package against the registry's integrity hash; the pinned
// onnxruntime packages are also checked against the hashes below. Afterwards,
// prepare-resources.js checks the architecture of every Mach-O file in the bundle, which also
// catches a native dependency added later that this file doesn't know about yet.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// The last onnxruntime-node release with darwin/x64 binaries (1.24 dropped them). Hashes are the
// registry's dist.integrity for each tarball.
const ORT_DARWIN_X64 = {
  version: "1.23.2",
  integrity: {
    "onnxruntime-node":
      "sha512-OBTsG0W8ddBVOeVVVychpVBS87A9YV5sa2hJ6lc025T97Le+J4v++PwSC4XFs1C62SWyNdof0Mh4KvnZgtt4aw==",
    "onnxruntime-common":
      "sha512-5LFsC9Dukzp2WV6kNHYLNzp8sT6V02IubLCbzw2Xd6X5GOlr65gAX6xiJwyi2URJol/s71gaQLC5F2C25AAR2w==",
  },
};

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}

// Every package directory directly under a node_modules (scoped ones included), by name.
function listPackages(nodeModulesDir) {
  const out = [];
  for (const name of readdirSync(nodeModulesDir)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(path.join(nodeModulesDir, name))) out.push(`${name}/${scoped}`);
    } else {
      out.push(name);
    }
  }
  return out;
}

// Runs `npm install` of exact versions into a scratch project, outside the repo, so the repo's
// own node_modules and lockfile are never touched.
function npmInstallScratch(label, specs, { target, ignoreScripts = false }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `lifer-retarget-${label}-`));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `lifer-retarget-${label}`, private: true }));
  const args = ["install", "--no-save", "--no-audit", "--no-fund", `--os=${target.platform}`, `--cpu=${target.arch}`];
  if (ignoreScripts) args.push("--ignore-scripts");
  console.log(`[retarget-natives] npm ${args.join(" ")} ${specs.join(" ")}`);
  const result = spawnSync("npm", [...args, ...specs], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // For any install script that builds or downloads a binary: node-pre-gyp reads
      // target_arch and target_platform, others arch and platform.
      npm_config_arch: target.arch,
      npm_config_target_arch: target.arch,
      npm_config_platform: target.platform,
      npm_config_target_platform: target.platform,
      // sharp's install script otherwise builds itself against a Homebrew libvips if the machine
      // has one, for the wrong CPU and missing from users' Macs, instead of using its prebuilt
      // @img packages.
      SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
    },
  });
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`[retarget-natives] npm install for ${label} failed`);
  }
  return dir;
}

function replaceDir(from, to) {
  if (!existsSync(from)) throw new Error(`[retarget-natives] expected ${from} after install`);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

// Platform packages (@img/sharp-darwin-arm64, @node-rs/argon2-darwin-arm64, ...): for every
// staged package that lists a host-specific optionalDependency, swap in the target's.
function retargetPlatformPackages(stagingNodeModules, host, target, scratchDirs) {
  const hostTag = `${host.platform}-${host.arch}`;
  const targetTag = `${target.platform}-${target.arch}`;
  const staged = new Set(listPackages(stagingNodeModules));
  const swaps = new Map(); // host package name -> the target's
  const parents = new Set(); // name@version of each package that chooses between them
  for (const name of staged) {
    // A platform package's own optional dependencies (@img/sharp-darwin-arm64 lists its libvips)
    // are listed again, for every platform, by the package that chooses between them (sharp).
    if (name.endsWith(hostTag)) continue;
    let optional;
    try {
      optional = readJson(path.join(stagingNodeModules, name, "package.json")).optionalDependencies;
    } catch {
      continue;
    }
    for (const dep of Object.keys(optional ?? {})) {
      if (!dep.endsWith(hostTag) || !staged.has(dep)) continue;
      const targetName = dep.slice(0, -hostTag.length) + targetTag;
      if (!(targetName in optional)) {
        throw new Error(`[retarget-natives] ${name} has no ${targetTag} build (no ${targetName} optional dependency)`);
      }
      swaps.set(dep, targetName);
      parents.add(`${name}@${readJson(path.join(stagingNodeModules, name, "package.json")).version}`);
    }
  }
  if (swaps.size === 0) return;
  const dir = npmInstallScratch("platform", [...parents], { target });
  scratchDirs.push(dir);
  for (const [hostName, name] of swaps) {
    rmSync(path.join(stagingNodeModules, hostName), { recursive: true, force: true });
    replaceDir(path.join(dir, "node_modules", name), path.join(stagingNodeModules, name));
    console.log(`[retarget-natives] ${hostName} -> ${name}`);
  }
}

// onnxruntime-node has no darwin/x64 binaries after 1.23: bundle 1.23.2 and its matching
// onnxruntime-common instead.
function retargetOnnxruntime(stagingNodeModules, target, scratchDirs) {
  const staged = path.join(stagingNodeModules, "onnxruntime-node");
  if (!existsSync(staged)) return;
  const binDir = path.join(staged, "bin");
  const hasTarget = readdirSync(binDir)
    .filter((n) => n.startsWith("napi-v"))
    .some((napi) => existsSync(path.join(binDir, napi, target.platform, target.arch)));
  if (hasTarget) return;
  if (target.platform !== "darwin" || target.arch !== "x64") {
    throw new Error(
      `[retarget-natives] onnxruntime-node has no ${target.platform}-${target.arch} binaries and no fallback is pinned`,
    );
  }
  const bundled = readJson(path.join(staged, "package.json")).version;
  // The install script only downloads Linux GPU libraries, so it's skipped.
  const dir = npmInstallScratch("onnxruntime", [`onnxruntime-node@${ORT_DARWIN_X64.version}`], {
    target,
    ignoreScripts: true,
  });
  scratchDirs.push(dir);
  const lock = readJson(path.join(dir, "node_modules", ".package-lock.json")).packages;
  for (const [name, integrity] of Object.entries(ORT_DARWIN_X64.integrity)) {
    const entry = lock[`node_modules/${name}`];
    if (entry?.version !== ORT_DARWIN_X64.version || entry?.integrity !== integrity) {
      throw new Error(
        `[retarget-natives] ${name} isn't the pinned ${ORT_DARWIN_X64.version} (got ${entry?.version} ${entry?.integrity})`,
      );
    }
    replaceDir(path.join(dir, "node_modules", name), path.join(stagingNodeModules, name));
  }
  console.warn(
    `[retarget-natives] onnxruntime-node ${bundled} has no Intel macOS build; bundling ${ORT_DARWIN_X64.version}, the last one that does`,
  );
}

export function retargetNatives(stagingNodeModules, target) {
  const host = { platform: process.platform, arch: process.arch };
  const scratchDirs = [];
  try {
    retargetPlatformPackages(stagingNodeModules, host, target, scratchDirs);
    retargetOnnxruntime(stagingNodeModules, target, scratchDirs);
  } finally {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  }
}
