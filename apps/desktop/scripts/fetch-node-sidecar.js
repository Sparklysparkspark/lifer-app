// Downloads the official Node.js prebuilt binary for the current platform and vendors it as
// the Tauri sidecar (src-tauri/binaries/node-<target-triple>) that api.rs spawns. This session's
// local testing instead copied whatever Node happened to already be installed on the dev
// machine — fine for proving the architecture works, but a real release build needs the
// correct OFFICIAL binary for each platform being shipped, not whatever's on the build
// machine. Run once per target platform before `npm run dist`.
import { execSync } from "node:child_process";
import { createWriteStream, mkdirSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_VERSION = "22.22.1"; // keep in sync with root package.json's engines.node

const TARGETS = {
  "aarch64-apple-darwin": { platform: "darwin-arm64", ext: "tar.gz" },
  "x86_64-apple-darwin": { platform: "darwin-x64", ext: "tar.gz" },
  "x86_64-unknown-linux-gnu": { platform: "linux-x64", ext: "tar.gz" },
  "x86_64-pc-windows-msvc": { platform: "win-x64", ext: "zip" },
};

function currentTargetTriple() {
  return execSync("rustc -vV", { encoding: "utf-8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    .split(":")[1]
    .trim();
}

async function fetchAndExtract(targetTriple) {
  const spec = TARGETS[targetTriple];
  if (!spec) throw new Error(`No known Node download for target triple ${targetTriple} — add it to TARGETS.`);

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${spec.platform}.${spec.ext}`;
  const binariesDir = path.join(__dirname, "..", "src-tauri", "binaries");
  const tmpArchive = path.join(binariesDir, `node.${spec.ext}`);
  const extractDir = path.join(binariesDir, "_extract");
  mkdirSync(binariesDir, { recursive: true });

  console.log(`[fetch-node-sidecar] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tmpArchive));

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  // The official Windows build is a zip with node.exe at its own root; macOS/Linux tarballs
  // nest everything one level down under bin/node — `unzip` has no --strip-components
  // equivalent, so the Windows branch extracts flat and reads straight from extractDir instead.
  const isWindows = spec.ext === "zip";
  if (isWindows) {
    execSync(`unzip -q "${tmpArchive}" -d "${extractDir}"`);
  } else {
    execSync(`tar -xzf "${tmpArchive}" -C "${extractDir}" --strip-components=1`);
  }

  const dest = path.join(binariesDir, `node-${targetTriple}${isWindows ? ".exe" : ""}`);
  if (isWindows) {
    // The zip's own top-level folder is named node-v<version>-win-x64 — same "one level down"
    // shape as the tarballs, just not stripped by the extraction step above.
    const nested = path.join(extractDir, `node-v${NODE_VERSION}-${spec.platform}`, "node.exe");
    execSync(`cp "${nested}" "${dest}"`);
  } else {
    execSync(`cp "${path.join(extractDir, "bin", "node")}" "${dest}"`);
    chmodSync(dest, 0o755);
  }
  rmSync(tmpArchive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`[fetch-node-sidecar] vendored ${dest}`);
}

const target = process.argv[2] || currentTargetTriple();
await fetchAndExtract(target);
