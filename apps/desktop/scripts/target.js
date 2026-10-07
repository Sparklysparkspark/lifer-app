// The platform a desktop build is for. Normally the machine it runs on; LIFER_TARGET_TRIPLE
// (a Rust target triple such as x86_64-apple-darwin) builds for another one instead. The only
// cross build supported is Intel macOS on an Apple Silicon Mac, which is how release.yml builds
// the Intel app now that GitHub's Intel macOS runners are being retired.
//
// Every step of `npm run dist` reads this, so setting the variable once retargets the whole
// chain: prepare-resources.js (which native binaries to bundle), fetch-node-sidecar.js (which
// Node), tauri-build.js (`tauri build --target`), resign-macos.js and build-update-manifest.js
// (where the bundle lands: target/<triple>/release instead of target/release).
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Rust target triple -> Node's process.platform / process.arch names for it.
const TRIPLES = {
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64" },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64" },
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64" },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64" },
};

function resolveTarget() {
  const triple = process.env.LIFER_TARGET_TRIPLE?.trim() || null;
  if (!triple) {
    return { triple: null, platform: process.platform, arch: process.arch, cross: false };
  }
  const spec = TRIPLES[triple];
  if (!spec)
    throw new Error(`[target] unknown LIFER_TARGET_TRIPLE ${triple}; known: ${Object.keys(TRIPLES).join(", ")}`);
  const cross = spec.platform !== process.platform || spec.arch !== process.arch;
  if (cross && !(spec.platform === "darwin" && process.platform === "darwin")) {
    throw new Error(
      `[target] can't build ${triple} on ${process.platform}-${process.arch}; only macOS cross-arch builds are supported`,
    );
  }
  return { triple, ...spec, cross };
}

export const target = resolveTarget();

// Tauri's own name for the architecture, used in update manifest keys and update archive names.
export const tauriArch = target.arch === "arm64" ? "aarch64" : "x86_64";

// Where `tauri build` writes the installers: target/release/bundle for a host build,
// target/<triple>/release/bundle when --target is passed.
export const bundleRoot = path.join(
  __dirname,
  "..",
  "src-tauri",
  "target",
  ...(target.triple ? [target.triple] : []),
  "release",
  "bundle",
);
