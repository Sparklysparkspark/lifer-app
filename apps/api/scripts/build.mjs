// Compiles the server to plain JavaScript for production (Docker and the desktop app), so they run
// `node dist/index.js` instead of TypeScript through tsx. Development still uses tsx.
//
// Lifer's own workspace code (apps/api, packages/core, packages/shared, packages/data-pipeline) is bundled; npm
// packages stay external and load from node_modules as before. Each output sits at the same depth
// as its source (apps/api/src -> apps/api/dist, packages/data-pipeline/src -> .../dist; packages/core/src is
// at that depth too), so code
// that finds files relative to the repo root keeps working. Code that finds files relative to its
// own module would point somewhere else once bundled, so the build fails if any bundled module does
// that outside the list of ones checked to be safe.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(API_DIR, "..", "..");
const WORKSPACE_PACKAGES = /^(@lifer\/(shared|core)|data-pipeline)(\/|$)/;

// Bundled modules that compute paths from import.meta.url, each checked to resolve the same from
// its output: repo-root paths (three levels up from a dist folder, like src), or a path the build
// copies next to the output (the detector model).
const SAFE_SELF_RELATIVE = new Set([
  "packages/core/src/config.ts",
  "packages/core/src/species/inference.ts",
  "packages/data-pipeline/src/embeddings.ts",
  "packages/core/src/rawCache.ts",
  "packages/data-pipeline/src/migrate.ts",
  // Its "started as a program" check compares itself with process.argv[1], which holds because it
  // is its own entry (the desktop app starts it), never bundled into index.js.
  "apps/api/src/species/localInferenceServer.ts",
]);

const externalPackages = {
  name: "external-packages",
  setup(b) {
    // Bare imports other than Lifer's own workspaces stay as imports of node_modules.
    b.onResolve({ filter: /^[^./]/ }, (args) => (WORKSPACE_PACKAGES.test(args.path) ? undefined : { path: args.path, external: true }));
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
  plugins: [externalPackages],
  // CommonJS packages bundled into ESM still call require(); give them one.
  banner: { js: 'import { createRequire as __liferCreateRequire } from "node:module"; const require = __liferCreateRequire(import.meta.url);' },
};

const apiDist = path.join(API_DIR, "dist");
const pipelineDist = path.join(REPO_ROOT, "packages", "data-pipeline", "dist");
rmSync(apiDist, { recursive: true, force: true });
rmSync(pipelineDist, { recursive: true, force: true });

const results = await Promise.all([
  // Flat, so every entry sits at the same depth as src/.
  build({
    ...common,
    entryPoints: {
      index: path.join(API_DIR, "src", "index.ts"),
      liferAdmin: path.join(API_DIR, "src", "admin", "liferAdmin.ts"),
      inferenceWorker: path.join(REPO_ROOT, "packages", "core", "src", "species", "inferenceWorker.ts"),
      localInferenceServer: path.join(API_DIR, "src", "species", "localInferenceServer.ts"),
    },
    outdir: apiDist,
  }),
  build({
    ...common,
    entryPoints: { migrate: path.join(REPO_ROOT, "packages", "data-pipeline", "src", "migrate.ts") },
    outdir: pipelineDist,
  }),
]);

// inference.ts loads the detector from models/ next to itself.
mkdirSync(path.join(apiDist, "models"), { recursive: true });
cpSync(path.join(REPO_ROOT, "packages", "core", "src", "species", "models"), path.join(apiDist, "models"), { recursive: true });

const { readFileSync } = await import("node:fs");
const unsafe = [];
for (const result of results) {
  for (const input of Object.keys(result.metafile.inputs)) {
    const rel = path.relative(REPO_ROOT, path.resolve(input)).split(path.sep).join("/");
    if (rel.startsWith("node_modules/") || SAFE_SELF_RELATIVE.has(rel)) continue;
    // createRequire(import.meta.url) only resolves npm packages, which Node finds through the same
    // node_modules folders from dist/ as from src/.
    const source = readFileSync(path.join(REPO_ROOT, rel), "utf8").replaceAll("createRequire(import.meta.url)", "");
    if (/import\.meta\.(url|dirname|filename)|__dirname|__filename/.test(source)) unsafe.push(rel);
  }
}
if (unsafe.length > 0) {
  console.error(
    "These bundled modules find files relative to themselves, which moves when bundled. Check each " +
      "resolves the same from dist/, then add it to SAFE_SELF_RELATIVE in apps/api/scripts/build.mjs:\n  " +
      [...new Set(unsafe)].join("\n  "),
  );
  process.exit(1);
}
console.log(`[build] api -> ${path.relative(REPO_ROOT, apiDist)}, migrate -> ${path.relative(REPO_ROOT, pipelineDist)}`);
