// Loads every native module the desktop app bundles, from the built app itself, and does one
// small real operation with each. Run it with the app's own Node sidecar, so it catches a binary
// built for the wrong CPU (or linked against something missing) before users do:
//
//   <node sidecar> apps/desktop/scripts/check-bundled-natives.js <resources dir>
//
// For a macOS build the resources dir is Lifer.app/Contents/Resources and the sidecar is
// Lifer.app/Contents/MacOS/node. release.yml runs it for both macOS architectures; the Intel
// one under Rosetta 2.
//
// Each check runs in its own process: a library one module loads (libvips, say) would otherwise
// satisfy another module's missing link and hide it.
import Module, { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [resources, only] = process.argv.slice(2);
if (!resources) {
  console.error("usage: check-bundled-natives.js <resources dir>");
  process.exit(2);
}
// The built app (and the staging dir) sit inside the repo, so Node's lookup would walk up into
// the repo's own node_modules and find what the bundle is missing. Refuse anything outside it.
const root = path.resolve(resources);
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const resolved = resolveFilename.apply(this, args);
  if (path.isAbsolute(resolved) && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${args[0]} resolved outside the bundle, to ${resolved}`);
  }
  return resolved;
};
// Resolves packages the way the bundled API does, from api/ up into the bundled node_modules.
const apiRequire = createRequire(path.join(root, "api", "package.json"));

// With no check named, runs each one in a child process of this same Node; in a child, runs
// only the named one.
const failures = [];
async function check(name, fn) {
  if (only !== undefined && only !== name) return;
  if (only === undefined) {
    const child = spawnSync(process.execPath, [process.argv[1], resources, name], { stdio: "inherit" });
    if (child.status !== 0) failures.push(name);
    return;
  }
  try {
    const detail = await fn();
    console.log(`[check-bundled-natives] ok   ${name}${detail ? `: ${detail}` : ""}`);
  } catch (err) {
    failures.push(name);
    console.error(`[check-bundled-natives] FAIL ${name}: ${err?.stack ?? err}`);
  }
}

// An empty model is rejected by onnxruntime's own parser, which only runs once the native
// binding has loaded. A binding that can't load fails earlier, with a different error.
async function checkOnnxruntime(req) {
  const ort = req("onnxruntime-node");
  const version = req("onnxruntime-node/package.json").version;
  try {
    await ort.InferenceSession.create(new Uint8Array(0));
  } catch (err) {
    if (/dlopen|cannot find module|incompatible architecture|not a valid|binding/i.test(String(err?.message)))
      throw err;
    return `${version}, binding loaded`;
  }
  throw new Error("an empty model was accepted");
}

if (only === undefined)
  console.log(`[check-bundled-natives] node ${process.version} ${process.platform}-${process.arch}`);

// sharp and argon2 fall back to a WebAssembly build when their native one is missing, which
// works but is slow, so the native package for this CPU must be there too.
const nativeTag = `${process.platform}-${process.arch}`;

const assertBundled = (dir) => {
  if (!existsSync(path.join(root, "node_modules", dir))) throw new Error(`no ${dir} in the bundle`);
};

await check("sharp", async () => {
  assertBundled(`@img/sharp-${nativeTag}`);
  const sharp = apiRequire("sharp");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#2a6" } })
    .png()
    .toBuffer();
  const { width } = await sharp(png).metadata();
  if (width !== 8) throw new Error(`round trip gave width ${width}`);
  return `${sharp.versions.sharp}, libvips ${sharp.versions.vips}`;
});
await check("@node-rs/argon2", async () => {
  assertBundled(`@node-rs/argon2-${nativeTag}`);
  const { hash, verify } = apiRequire("@node-rs/argon2");
  if (!(await verify(await hash("lifer"), "lifer"))) throw new Error("hash didn't verify");
});
await check("onnxruntime-node", () => checkOnnxruntime(apiRequire));
// The CLIP text encoder. Its Node build bundles everything but onnxruntime-node,
// onnxruntime-common and sharp, which it loads from the bundle like the API does. Loading its
// CommonJS build goes through the resolver above, so each of those must resolve inside the
// bundle; the ESM build the API imports must load too.
await check("@huggingface/transformers", async () => {
  // Its exports don't include package.json, so it's found through the CommonJS entry, dist/.
  const entry = apiRequire.resolve("@huggingface/transformers");
  const transformersRequire = createRequire(entry);
  const transformers = apiRequire("@huggingface/transformers");
  if (typeof transformers.AutoTokenizer?.from_pretrained !== "function") throw new Error("no AutoTokenizer");
  const esm = await import(pathToFileURL(path.join(path.dirname(entry), "transformers.node.mjs")).href);
  if (typeof esm.CLIPTextModelWithProjection?.from_pretrained !== "function")
    throw new Error("the ESM build has no CLIPTextModelWithProjection");
  const tensor = new transformers.Tensor("float32", new Float32Array([1, 2, 3]), [3]);
  if (tensor.dims[0] !== 3) throw new Error("couldn't make a tensor");
  // The onnxruntime-node it runs models with must be the API's, and its binding must load.
  const ortPath = transformersRequire.resolve("onnxruntime-node");
  if (ortPath !== apiRequire.resolve("onnxruntime-node"))
    throw new Error(`it loads onnxruntime-node from ${ortPath}, not the API's`);
  const ort = await checkOnnxruntime(transformersRequire);
  // Neither exports its package.json, so it's read from the package's own folder.
  const versionOf = (file, name) => {
    const dir = file.slice(0, file.lastIndexOf(`${path.sep}${name}${path.sep}`) + name.length + 1);
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")).version;
  };
  const common = versionOf(transformersRequire.resolve("onnxruntime-common"), "onnxruntime-common");
  return `${versionOf(entry, "transformers")}, onnxruntime-node ${ort}, onnxruntime-common ${common}`;
});
await check("ffmpeg", async () => {
  const ffmpeg = apiRequire("ffmpeg-static");
  const result = spawnSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.split("\n")[0];
});
// The embedded database's server (stage-postgres.js): its programs (the server, the three the app
// runs, and the backup and upgrade tools) run, and a throwaway cluster loads every extension
// Lifer's migrations create. Single-user mode, so no port opens.
await check("postgres", async () => {
  const exe = (name) => path.join(root, "postgres", "bin", process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(exe("postgres"))) throw new Error("no postgres/bin/postgres in the bundle");
  let version;
  for (const name of [
    "postgres",
    "initdb",
    "pg_ctl",
    "psql",
    "pg_dump",
    "pg_restore",
    "pg_dumpall",
    "pg_upgrade",
    "pg_controldata",
    "pg_resetwal",
    "vacuumdb",
  ]) {
    const result = spawnSync(exe(name), ["--version"], { encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`${name} --version failed: ${result.stderr || result.error}`);
    version ??= result.stdout.trim();
  }
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "lifer-check-postgres-"));
  try {
    const init = spawnSync(
      exe("initdb"),
      ["-D", dataDir, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-instructions"],
      {
        encoding: "utf-8",
      },
    );
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr || init.error}`);
    const sql = [
      "CREATE EXTENSION pg_trgm;",
      "CREATE EXTENSION unaccent;",
      "CREATE EXTENSION pgcrypto;",
      "SELECT unaccent('Hôtel'), similarity('heron', 'herons'), digest('lifer', 'sha256');",
      "",
    ].join("\n");
    const single = spawnSync(exe("postgres"), ["--single", "-D", dataDir, "postgres"], {
      input: sql,
      encoding: "utf-8",
    });
    const output = `${single.stdout}${single.stderr}`;
    if (single.status !== 0 || /\b(ERROR|FATAL)\b/.test(output) || !output.includes("Hotel")) {
      throw new Error(`the server couldn't load the extensions:\n${output}`);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return version;
});
// The previous major's server, in a release that bundles one for upgrading old data
// (stage-postgres.js's PREVIOUS_POSTGRES_VERSION): the programs pg_upgrade runs from it.
const previousDir = path.join(root, "postgres-previous");
const previousMajors = existsSync(previousDir) ? readdirSync(previousDir).filter((name) => /^\d+$/.test(name)) : [];
for (const previousMajor of previousMajors) {
  await check(`postgres ${previousMajor} (for upgrades)`, async () => {
    const exe = (name) =>
      path.join(previousDir, previousMajor, "bin", process.platform === "win32" ? `${name}.exe` : name);
    let version;
    for (const name of ["postgres", "pg_ctl", "pg_controldata", "pg_resetwal"]) {
      const result = spawnSync(exe(name), ["--version"], { encoding: "utf-8" });
      if (result.status !== 0) throw new Error(`${name} --version failed: ${result.stderr || result.error}`);
      if (!result.stdout.includes(` ${previousMajor}.`)) throw new Error(`${name} is ${result.stdout.trim()}`);
      version ??= result.stdout.trim();
    }
    return version;
  });
}

if (failures.length > 0) {
  if (only === undefined) console.error(`[check-bundled-natives] ${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
if (only === undefined) console.log("[check-bundled-natives] all native modules load");
