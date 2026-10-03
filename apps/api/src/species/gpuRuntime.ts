// NVIDIA GPUs on Linux: finds the card and assembles the runtime species matching needs to use it,
// downloaded once into the app's data folder and only on machines with a card, so CPU-only
// installs and the Docker image carry none of it. The runtime is the ONNX Runtime Node package with
// its CUDA add-on plus NVIDIA's CUDA libraries (from NVIDIA's own PyPI packages). Which set depends
// on the driver: ONNX Runtime 1.27+ needs CUDA 13 (driver 580+); 1.26 is the newest on CUDA 12.
// Every file is pinned by sha256. Config-free.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { downloadResumable } from "../lib/resumableDownload.js";
import { extractZipEntries } from "./zipEntries.js";

const run = promisify(execFile);

export interface NvidiaGpu {
  name: string;
  driver: string;
  /** Highest CUDA major version the driver supports. */
  cudaMajor: number;
}

/** The newest CUDA major version a driver runs: 580+ runs 13, 525+ runs 12, older none (0). */
export function cudaMajorForDriver(driver: string): number {
  const major = Number(driver.split(".")[0]);
  return major >= 580 ? 13 : major >= 525 ? 12 : 0;
}

/** The first NVIDIA GPU and its driver, or null when there's none (or no driver). */
export async function detectNvidiaGpu(): Promise<NvidiaGpu | null> {
  if (process.platform !== "linux") return null;
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"], { timeout: 10_000 });
    const [name, driver] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
    if (!name || !driver) return null;
    return { name, driver, cudaMajor: cudaMajorForDriver(driver) };
  } catch {
    // No nvidia-smi: in Docker it's mounted only when the GPU is passed through.
    return existsSync("/dev/nvidia0") ? { name: "NVIDIA GPU", driver: "unknown", cudaMajor: 12 } : null;
  }
}

interface Pinned {
  url: string;
  sha256: string;
  bytes: number;
}

interface RuntimeSet {
  ortVersion: string;
  ortNode: Pinned;
  ortCommon: Pinned;
  /** NuGet package holding the CUDA add-on built for this ONNX Runtime version. */
  cudaAddon: Pinned;
  /** NVIDIA's libraries: cuda runtime, cuBLAS, cuDNN, cuFFT, cuRAND. */
  nvidia: Pinned[];
}

const npm = (pkg: string, v: string) => `https://registry.npmjs.org/${pkg}/-/${pkg}-${v}.tgz`;
const nuget = (v: string) => `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.gpu.linux/${v}/microsoft.ml.onnxruntime.gpu.linux.${v}.nupkg`;
const pypi = (p: string) => `https://files.pythonhosted.org/packages/${p}`;

export const RUNTIME_SETS: Record<12 | 13, RuntimeSet> = {
  12: {
    ortVersion: "1.26.0",
    ortNode: { url: npm("onnxruntime-node", "1.26.0"), sha256: "874e97b8840c16db3a3997a4cc75976ee46fb4828bc95dda909d8d4e134bed02", bytes: 99_542_882 },
    ortCommon: { url: npm("onnxruntime-common", "1.26.0"), sha256: "8832374e72762323b60cae78e11ef65a2323f04f6afb3db00a615bd3272b8adc", bytes: 66_044 },
    cudaAddon: { url: nuget("1.26.0"), sha256: "cf7943f58b9360fe1448c4baf40ac12ce4175978ecd3fe6f21a4c00976f63a59", bytes: 225_183_750 },
    // The CUDA 12.4 family, which runs on driver 550 and newer.
    nvidia: [
      { url: pypi("ea/27/1795d86fe88ef397885f2e580ac37628ed058a92ed2c39dc8eac3adf0619/nvidia_cuda_runtime_cu12-12.4.127-py3-none-manylinux2014_x86_64.whl"), sha256: "64403288fa2136ee8e467cdc9c9427e0434110899d07c779f25b5c068934faa5", bytes: 883_737 },
      { url: pypi("ae/71/1c91302526c45ab494c23f61c7a84aa568b8c1f9d196efa5993957faf906/nvidia_cublas_cu12-12.4.5.8-py3-none-manylinux2014_x86_64.whl"), sha256: "2fc8da60df463fdefa81e323eef2e36489e1c94335b5358bcb38360adf75ac9b", bytes: 363_438_805 },
      { url: pypi("9f/fd/713452cd72343f682b1c7b9321e23829f00b842ceaedcda96e742ea0b0b3/nvidia_cudnn_cu12-9.1.0.70-py3-none-manylinux2014_x86_64.whl"), sha256: "165764f44ef8c61fcdfdfdbe769d687e06374059fbb388b6c89ecb0e28793a6f", bytes: 664_752_741 },
      { url: pypi("27/94/3266821f65b92b3138631e9c8e7fe1fb513804ac934485a8d05776e1dd43/nvidia_cufft_cu12-11.2.1.3-py3-none-manylinux2014_x86_64.whl"), sha256: "f083fc24912aa410be21fa16d157fed2055dab1cc4b6934a0e03cba69eb242b9", bytes: 211_459_117 },
      { url: pypi("8a/6d/44ad094874c6f1b9c654f8ed939590bdc408349f137f9b98a3a23ccec411/nvidia_curand_cu12-10.3.5.147-py3-none-manylinux2014_x86_64.whl"), sha256: "a88f583d4e0bb643c49743469964103aa59f7f708d862c3ddb0fc07f851e3b8b", bytes: 56_305_206 },
    ],
  },
  13: {
    ortVersion: "1.29.0",
    ortNode: { url: npm("onnxruntime-node", "1.29.0"), sha256: "cfdfb45ec4044b1fdca43e5d2e180fb6817e649ff8ad1e0dfc90e18e51b67037", bytes: 111_735_068 },
    ortCommon: { url: npm("onnxruntime-common", "1.29.0"), sha256: "9b56a571348dc0e980f939b88989864946148d8500cbd0957534975389a1743b", bytes: 66_604 },
    cudaAddon: { url: nuget("1.29.0"), sha256: "ab4be2ce91e236f72f2b71f8866cd13e5bd8440667d9eb0ef1c3e0373c62034c", bytes: 191_730_792 },
    // CUDA 13.0, which runs on driver 580 and newer.
    nvidia: [
      { url: pypi("2e/24/d1558f3b68b1d26e706813b1d10aa1d785e4698c425af8db8edc3dced472/nvidia_cuda_runtime-13.0.96-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"), sha256: "7f82250d7782aa23b6cfe765ecc7db554bd3c2870c43f3d1821f1d18aebf0548", bytes: 2_243_632 },
      { url: pypi("28/d4/30e630055d8e0f7058cc0d39e562c965d692f4735537d3f02f45d579a280/nvidia_cublas-13.0.2.14-py3-none-manylinux_2_27_x86_64.whl"), sha256: "0cf238ffdbe46c00cb9aa98e7bca745c223a5ca5a53e686ac8b3e5a08fe80d6c", bytes: 420_882_912 },
      { url: pypi("2d/e6/2db04f0fbeefb8a26b3761894ff160d1561bff628c000190543411df7c47/nvidia_cudnn_cu13-9.13.1.26-py3-none-manylinux_2_27_x86_64.whl"), sha256: "a0f434a881ce8b35afe3a328634db1da4a3852fc6dfbe89577f3e78400ee10d0", bytes: 348_613_041 },
      { url: pypi("a8/2f/7b57e29836ea8714f81e9898409196f47d772d5ddedddf1592eadb8ab743/nvidia_cufft-12.0.0.61-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"), sha256: "6c44f692dce8fd5ffd3e3df134b6cdb9c2f72d99cf40b62c32dde45eea9ddad3", bytes: 214_085_489 },
      { url: pypi("a5/9f/be0a41ca4a4917abf5cb9ae0daff1a6060cc5de950aec0396de9f3b52bc5/nvidia_curand-10.4.0.35-py3-none-manylinux_2_27_x86_64.whl"), sha256: "1aee33a5da6e1db083fe2b90082def8915f30f3248d5896bcec36a579d941bfc", bytes: 59_544_258 },
    ],
  },
};

const LOCK_STALE_MS = 10 * 60_000;

/** How to start a process that uses an assembled runtime. */
export interface GpuRuntime {
  /** The ONNX Runtime package to load instead of the bundled one. */
  ortModule: string;
  /** Library folders for the dynamic linker, set when the process starts. */
  libraryPath: string;
}

const describe = (dir: string): GpuRuntime => ({
  ortModule: path.join(dir, "node_modules", "onnxruntime-node"),
  libraryPath: [path.join(dir, "lib"), path.join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64")].join(":"),
});

/** The runtime for this CUDA major version when it's assembled with every file it listed, else
 *  null (a damaged one is then assembled again). */
export function installedGpuRuntime(root: string, cudaMajor: 12 | 13): GpuRuntime | null {
  const dir = path.join(root, `cuda${cudaMajor}-ort${RUNTIME_SETS[cudaMajor].ortVersion}`);
  try {
    const ready = JSON.parse(readFileSync(path.join(dir, "ready"), "utf8")) as { files?: string[] };
    if (!ready.files?.length || !ready.files.every((f) => existsSync(path.join(dir, f)))) return null;
    return describe(dir);
  } catch {
    return null;
  }
}

/** Downloads and assembles the runtime for this CUDA major version, resuming where it stopped. */
export async function ensureGpuRuntime(
  root: string,
  cudaMajor: 12 | 13,
  opts: { onProgress?: (doneBytes: number, totalBytes: number) => void } = {},
): Promise<GpuRuntime> {
  const existing = installedGpuRuntime(root, cudaMajor);
  if (existing) return existing;
  const set = RUNTIME_SETS[cudaMajor];
  const dir = path.join(root, `cuda${cudaMajor}-ort${set.ortVersion}`);
  mkdirSync(root, { recursive: true });
  // One assembler at a time per folder (two installs can share a volume). The holder touches the
  // lock every minute, so one untouched for 10 minutes was left by a process that died.
  const lock = path.join(root, `cuda${cudaMajor}.lock`);
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age: number;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // Released in between.
      }
      if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 5000));
      const ready = installedGpuRuntime(root, cudaMajor);
      if (ready) return ready;
    }
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // Another process took it over as stale; nothing to keep alive.
    }
  }, 60_000);
  heartbeat.unref();
  try {
    return await assemble(root, dir, cudaMajor, set, opts);
  } finally {
    clearInterval(heartbeat);
    rmSync(lock, { recursive: true, force: true });
  }
}

async function assemble(
  root: string,
  dir: string,
  cudaMajor: 12 | 13,
  set: RuntimeSet,
  opts: { onProgress?: (doneBytes: number, totalBytes: number) => void },
): Promise<GpuRuntime> {
  const already = installedGpuRuntime(root, cudaMajor);
  if (already) return already;
  const downloads = path.join(root, "downloads");
  mkdirSync(downloads, { recursive: true });
  const all = [set.ortNode, set.ortCommon, set.cudaAddon, ...set.nvidia];
  const total = all.reduce((a, p) => a + p.bytes, 0);
  let done = 0;
  const fetchOne = async (p: Pinned): Promise<string> => {
    const file = path.join(downloads, path.basename(new URL(p.url).pathname));
    await downloadResumable(p.url, file, {
      expectedSha256: p.sha256,
      label: "the GPU libraries",
      onProgress: (bytes) => opts.onProgress?.(done + bytes, total),
    });
    done += p.bytes;
    opts.onProgress?.(done, total);
    return file;
  };

  // Assembled in a scratch folder and renamed into place, so a half-built runtime is never used.
  const work = `${dir}.part`;
  rmSync(work, { recursive: true, force: true });
  const nodeModules = path.join(work, "node_modules");
  for (const [pinned, name] of [[set.ortNode, "onnxruntime-node"], [set.ortCommon, "onnxruntime-common"]] as const) {
    const file = await fetchOne(pinned);
    const dest = path.join(nodeModules, name);
    mkdirSync(dest, { recursive: true });
    await tar.x({ file, cwd: dest, strip: 1 });
  }
  // The add-on sits beside the binding, where ONNX Runtime looks for it.
  const bindingDir = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v6", "linux", "x64");
  const files = [path.join(bindingDir, "onnxruntime_binding.node")];
  files.push(
    ...(await extractZipEntries(await fetchOne(set.cudaAddon), bindingDir, (p) =>
      /^runtimes\/linux-x64\/native\/libonnxruntime_providers_(cuda|shared)\.so$/.test(p) ? path.basename(p) : null,
    )),
  );
  if (files.length < 3) throw new Error("The CUDA add-on package is missing its libraries");
  // NVIDIA's packages keep their libraries under nvidia/<component>/lib; all go in one folder.
  const lib = path.join(work, "lib");
  for (const pinned of set.nvidia) {
    const got = await extractZipEntries(await fetchOne(pinned), lib, (p) => (/^nvidia\/[^/]+\/lib\/[^/]+\.so[.\d]*$/.test(p) ? path.basename(p) : null));
    if (got.length === 0) throw new Error(`${path.basename(pinned.url)} has no libraries`);
    files.push(...got);
  }
  // Only the other platforms' binaries the npm package carries are dropped; nothing else needs them.
  const bin = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v6");
  for (const platform of readdirSync(bin)) if (platform !== "linux") rmSync(path.join(bin, platform), { recursive: true, force: true });
  // Every file it relies on, checked before it's used (installedGpuRuntime).
  const listed = files.map((f) => path.relative(work, f));
  writeFileSync(path.join(work, "ready"), JSON.stringify({ cudaMajor, ortVersion: set.ortVersion, at: new Date().toISOString(), files: listed }));
  rmSync(dir, { recursive: true, force: true });
  renameSync(work, dir);
  rmSync(downloads, { recursive: true, force: true });
  return describe(dir);
}
