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
  if (spec.ext !== "tar.gz") throw new Error(`${spec.ext} extraction not implemented yet — Windows needs a zip step.`);

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${spec.platform}.tar.gz`;
  const binariesDir = path.join(__dirname, "..", "src-tauri", "binaries");
  const tmpTar = path.join(binariesDir, "node.tar.gz");
  const extractDir = path.join(binariesDir, "_extract");
  mkdirSync(binariesDir, { recursive: true });

  console.log(`[fetch-node-sidecar] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tmpTar));

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xzf "${tmpTar}" -C "${extractDir}" --strip-components=1`);

  const dest = path.join(binariesDir, `node-${targetTriple}`);
  execSync(`cp "${path.join(extractDir, "bin", "node")}" "${dest}"`);
  chmodSync(dest, 0o755);
  rmSync(tmpTar, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`[fetch-node-sidecar] vendored ${dest}`);
}

const target = process.argv[2] || currentTargetTriple();
await fetchAndExtract(target);
