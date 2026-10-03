// Downloads the official Node.js binary for this platform and vendors it as the Tauri sidecar
// (src-tauri/binaries/node-<target-triple>) that api.rs spawns. Run once per target before
// `npm run dist`.
import { execSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, chmodSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

// Checks the archive against the SHASUMS256.txt published in the same nodejs.org release dir.
async function verifyChecksum(archivePath, archiveName) {
  const sumsUrl = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
  const res = await fetch(sumsUrl);
  if (!res.ok) throw new Error(`Couldn't fetch ${sumsUrl}: HTTP ${res.status}`);
  const line = (await res.text()).split("\n").find((l) => l.trim().split(/\s+/)[1] === archiveName);
  if (!line) throw new Error(`${archiveName} is not listed in ${sumsUrl}`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    rmSync(archivePath, { force: true });
    throw new Error(`Checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}. Refusing to vendor it.`);
  }
  console.log(`[fetch-node-sidecar] sha256 verified (${actual})`);
}

async function fetchAndExtract(targetTriple) {
  const spec = TARGETS[targetTriple];
  if (!spec) throw new Error(`No known Node download for target triple ${targetTriple}. Add it to TARGETS.`);

  const archiveName = `node-v${NODE_VERSION}-${spec.platform}.${spec.ext}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
  const binariesDir = path.join(__dirname, "..", "src-tauri", "binaries");
  const tmpArchive = path.join(binariesDir, `node.${spec.ext}`);
  const extractDir = path.join(binariesDir, "_extract");
  mkdirSync(binariesDir, { recursive: true });

  console.log(`[fetch-node-sidecar] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tmpArchive));
  await verifyChecksum(tmpArchive, archiveName);

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  // The Windows zip has node.exe at its root while tarballs nest under bin/node. `unzip` can't
  // strip components, so the Windows branch extracts flat.
  const isWindows = spec.ext === "zip";
  if (isWindows) {
    execSync(`unzip -q "${tmpArchive}" -d "${extractDir}"`);
  } else {
    execSync(`tar -xzf "${tmpArchive}" -C "${extractDir}" --strip-components=1`);
  }

  const dest = path.join(binariesDir, `node-${targetTriple}${isWindows ? ".exe" : ""}`);
  if (isWindows) {
    // The zip's top-level folder is node-v<version>-win-x64, not stripped above.
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
