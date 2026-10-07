// Works out which installed npm packages the compiled server can load, for the two places that
// ship it with its dependencies: the Docker image (docker/prune-node-modules.mjs, which deletes the
// rest in place) and the desktop app (apps/desktop/scripts/prepare-resources.js, which copies only
// these into its bundle).
//
// The server is bundled (apps/api/scripts/build.mjs) with npm packages left as imports, so the
// packages it needs are the bare imports in its dist files plus everything those depend on.
// Workspace package.json files list more than that (data-pipeline's duckdb and exceljs are only for
// its maintainer scripts), which is why this doesn't trust them.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";

// Static imports, import(), require() and createRequire(...)() with a bare, literal specifier.
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\d*\s*\(\s*|\(import\.meta\.url\)\s*\(\s*)["'](@?[a-z0-9][\w.-]*(?:\/[\w.-]+)*)["']/g;
const packageName = (spec) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Dependencies a package declares but never loads in Node. Transformers.js's Node build runs on
// onnxruntime-node (it bundles the little it needs of the web runtime), so onnxruntime-web and what
// only it needs (protobufjs, long, flatbuffers) stay out.
const NOT_LOADED_IN_NODE = { "@huggingface/transformers": ["onnxruntime-web"] };
// And ones it loads without declaring them itself: that Node build imports onnxruntime-common,
// which it only gets through onnxruntime-web. Kept, so it resolves to the same copy as before.
const UNDECLARED_IN_NODE = { "@huggingface/transformers": ["onnxruntime-common"] };

// The C library Node is linked against on Linux, which decides between sharp's glibc and musl
// builds. Elsewhere packages don't declare one, so it isn't checked.
export function hostLibc() {
  if (process.platform !== "linux") return null;
  return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
}

// Packages npm installed although they're for another platform (sharp's musl and wasm builds).
function wrongPlatform(pkg, { platform, arch, libc }) {
  const excluded = (list, value) =>
    Array.isArray(list) &&
    list.length > 0 &&
    (list.includes(`!${value}`) || !list.some((v) => v === value || v.startsWith("!")));
  return excluded(pkg.os, platform) || excluded(pkg.cpu, arch) || (libc !== null && excluded(pkg.libc, libc));
}

// Every package the .js files directly in `distDirs` import, and the folders of those packages and
// of everything they depend on (real paths, so npm's workspace links resolve to the workspace).
// `root` is the folder npm installed into; lookups never go above it. `platform`, `arch` and
// `libc` are those of the installed tree: packages declaring another one are left out.
export function traceRuntimePackages({
  root,
  distDirs,
  platform = process.platform,
  arch = process.arch,
  libc = hostLibc(),
}) {
  const target = { platform, arch, libc };

  // Node's lookup: node_modules/<name> in this folder or any parent, up to the root.
  function resolvePackage(name, fromDir) {
    for (let dir = fromDir; dir.startsWith(root); dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
      if (dir === root) break;
    }
    return null;
  }

  const entries = new Map(); // package name -> a dist file that imports it
  for (const dir of distDirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      for (const [, spec] of readFileSync(path.join(dir, file), "utf8").matchAll(IMPORT_RE)) {
        if (!isBuiltin(spec) && !entries.has(packageName(spec))) entries.set(packageName(spec), path.join(dir, file));
      }
    }
  }

  const keep = new Set();
  const queue = [];
  for (const [name, file] of [...entries]) {
    const dir = resolvePackage(name, path.dirname(file));
    if (dir) {
      queue.push(dir);
    } else {
      // Text in the bundle that only looks like an import, or a package npm didn't install anyway.
      console.warn(`[prune] ${path.relative(root, file)} seems to import ${name}, which isn't installed`);
      entries.delete(name);
    }
  }
  while (queue.length > 0) {
    const dir = queue.pop();
    if (keep.has(dir)) continue;
    const pkg = readJson(path.join(dir, "package.json"));
    if (wrongPlatform(pkg, target)) continue;
    keep.add(dir);
    const optional = { ...pkg.peerDependencies, ...pkg.optionalDependencies };
    const skipped = NOT_LOADED_IN_NODE[pkg.name] ?? [];
    const names = [
      ...Object.keys({ ...pkg.dependencies, ...optional }).filter((n) => !skipped.includes(n)),
      ...(UNDECLARED_IN_NODE[pkg.name] ?? []),
    ];
    for (const name of names) {
      const found = resolvePackage(name, dir);
      if (found) queue.push(found);
      else if (!(name in optional)) console.warn(`[prune] ${pkg.name} depends on ${name}, which isn't installed`);
    }
  }
  return { entries, keep };
}

// Removes the files inside a kept package that Node on `platform`-`arch` never loads, by calling
// `remove` on each. Only onnxruntime-node and Transformers.js have any.
export function slimPackage(dir, { platform, arch, remove }) {
  const pkg = readJson(path.join(dir, "package.json"));
  // onnxruntime-node ships prebuilt binaries for every OS and CPU in one package, laid out as
  // bin/napi-v<N>/<os>/<cpu>/.
  const binRoot = path.join(dir, "bin");
  if (pkg.name === "onnxruntime-node" && existsSync(binRoot)) {
    for (const napi of readdirSync(binRoot)) {
      for (const os of readdirSync(path.join(binRoot, napi))) {
        const osDir = path.join(binRoot, napi, os);
        if (os !== platform) remove(osDir);
        else for (const cpu of readdirSync(osDir)) if (cpu !== arch) remove(path.join(osDir, cpu));
      }
    }
    // Its GPU providers (CUDA, TensorRT, ROCm), which its install script fetches on linux/x64 unless
    // skipped (TensorRT's also needs libcublas, which breaks the desktop AppImage's linuxdeploy).
    // GPU matching downloads its own ONNX Runtime with the CUDA provider when a card is found
    // (apps/api/src/species/gpuRuntime.ts), so the server never loads these.
    const stripProviders = (d) => {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry);
        if (lstatSync(full).isDirectory()) stripProviders(full);
        else if (/providers_(cuda|tensorrt|rocm)/i.test(entry)) remove(full);
      }
    };
    stripProviders(binRoot);
  }
  // Transformers.js: Node loads dist/transformers.node.{mjs,cjs} (its "node" export and main); the
  // rest of dist/ is the browser build and minified copies. Only for the layout this was written
  // for, since a different one could load what's removed.
  if (pkg.name === "@huggingface/transformers" && existsSync(path.join(dir, "dist"))) {
    const node = pkg.exports?.node;
    if (
      pkg.main !== "./dist/transformers.node.cjs" ||
      node?.import?.default !== "./dist/transformers.node.mjs" ||
      node?.require?.default !== "./dist/transformers.node.cjs"
    ) {
      console.warn(`[prune] @huggingface/transformers ${pkg.version} has an unexpected layout, not slimming it`);
      return;
    }
    const nodeEntries = new Set(["transformers.node.mjs", "transformers.node.cjs"]);
    for (const file of readdirSync(path.join(dir, "dist"))) {
      if (/^transformers\..*js$/.test(file) && !nodeEntries.has(file)) remove(path.join(dir, "dist", file));
    }
  }
}

// Imports each package in `names` from a file in `fromDir`, the way the server does, and fails if
// any doesn't load. With `confineTo`, also fails if anything (each package's own imports and
// requires included) resolves to a file outside that folder: the desktop bundle is staged inside
// the repo, where Node's lookup would otherwise find a missing package in the repo's node_modules.
// With `resolveOnly`, finds each package without loading it, for a bundle whose native binaries
// are for another CPU.
export function assertPackagesLoad(names, { fromDir, confineTo = null, resolveOnly = false }) {
  const lines = [];
  if (confineTo) {
    // Windows paths compare case-insensitively (a drive letter can come back either way).
    const fold = process.platform === "win32" ? ".toLowerCase()" : "";
    const inside = JSON.stringify(realpathSync(confineTo) + path.sep);
    lines.push(
      `import { registerHooks } from "node:module";`,
      `import { fileURLToPath } from "node:url";`,
      `const check = (specifier, url) => {`,
      `  if (url.startsWith("file:") && !fileURLToPath(url)${fold}.startsWith(${inside}${fold})) throw new Error(\`\${specifier} resolved outside \${${inside}}, to \${url}\`);`,
      `  return url;`,
      `};`,
      `registerHooks({ resolve: (specifier, context, next) => { const result = next(specifier, context); check(specifier, result.url); return result; } });`,
    );
  }
  for (const name of names) {
    const spec = JSON.stringify(name);
    lines.push(
      resolveOnly
        ? confineTo
          ? `check(${spec}, import.meta.resolve(${spec}));`
          : `import.meta.resolve(${spec});`
        : `await import(${spec});`,
    );
  }
  const file = path.join(fromDir, `.prune-check-${process.pid}.mjs`);
  writeFileSync(file, lines.join("\n"));
  try {
    execFileSync(process.execPath, [file], { stdio: "inherit" });
  } finally {
    rmSync(file);
  }
}
