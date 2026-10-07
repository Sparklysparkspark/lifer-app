import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RUNTIME_SETS, cudaMajorForDriver, installedGpuRuntime } from "./gpuRuntime.js";
import { extractZipEntries } from "./zipEntries.js";

describe("cudaMajorForDriver", () => {
  it("picks CUDA 12 for drivers 525 to 579, CUDA 13 from 580, none before", () => {
    expect(cudaMajorForDriver("550.127.05")).toBe(12);
    expect(cudaMajorForDriver("525.60.11")).toBe(12);
    expect(cudaMajorForDriver("580.65.06")).toBe(13);
    expect(cudaMajorForDriver("470.256.02")).toBe(0);
  });
});

describe("RUNTIME_SETS", () => {
  it("pins every file by https URL, sha256 and size, with all five NVIDIA libraries", () => {
    for (const set of Object.values(RUNTIME_SETS)) {
      const files = [set.ortNode, set.ortCommon, set.cudaAddon, ...set.nvidia];
      for (const f of files) {
        expect(f.url).toMatch(/^https:\/\//);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
      }
      const libs = set.nvidia.map((p) => path.basename(p.url));
      for (const lib of ["cuda_runtime", "cublas", "cudnn", "cufft", "curand"]) expect(libs.some((l) => l.includes(lib))).toBe(true);
      expect(set.ortNode.url).toContain(set.ortVersion);
      expect(set.cudaAddon.url).toContain(set.ortVersion);
    }
  });
});

describe("installedGpuRuntime", () => {
  const binding = path.join("node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64");
  const files = [
    path.join(binding, "onnxruntime_binding.node"),
    path.join(binding, "libonnxruntime_providers_cuda.so"),
    path.join(binding, "libonnxruntime_providers_shared.so"),
    path.join("lib", "libcudart.so.12"),
  ];
  function assemble(root: string): string {
    const dir = path.join(root, `cuda12-ort${RUNTIME_SETS[12].ortVersion}`);
    for (const f of files) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), "");
    }
    writeFileSync(path.join(dir, "ready"), JSON.stringify({ files }));
    return dir;
  }

  it("loads ONNX Runtime from the download, with its CUDA provider's folder on the library path", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lifer-gpu-"));
    try {
      const dir = assemble(root);
      const rt = installedGpuRuntime(root, 12);
      expect(rt?.ortModule).toBe(path.join(dir, "node_modules", "onnxruntime-node"));
      expect(rt?.libraryPath.split(":")).toEqual([path.join(dir, "lib"), path.join(dir, binding)]);
      expect(installedGpuRuntime(root, 13)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is missing when the downloaded CUDA provider is gone, or the runtime was never finished", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lifer-gpu-"));
    try {
      const dir = assemble(root);
      rmSync(path.join(dir, binding, "libonnxruntime_providers_cuda.so"));
      expect(installedGpuRuntime(root, 12)).toBeNull();
      rmSync(path.join(dir, "ready"));
      expect(installedGpuRuntime(root, 12)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A zip of the given files, stored or deflated, written by hand. */
function makeZip(files: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("extractZipEntries", () => {
  it("extracts only the picked files, stored or deflated", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-zip-"));
    try {
      const big = Buffer.from("libcublas ".repeat(5000));
      const zip = path.join(dir, "test.whl");
      writeFileSync(
        zip,
        makeZip([
          { name: "nvidia/cublas/lib/libcublas.so.12", data: big, deflate: true },
          { name: "nvidia/cublas/lib/libcublasLt.so.12", data: Buffer.from("lt"), deflate: false },
          { name: "nvidia/cublas/include/cublas.h", data: Buffer.from("header"), deflate: true },
        ]),
      );
      const out = path.join(dir, "lib");
      const written = await extractZipEntries(zip, out, (p) => (p.includes("/lib/") ? path.basename(p) : null));
      expect(written.map((f) => path.basename(f)).sort()).toEqual(["libcublas.so.12", "libcublasLt.so.12"]);
      expect(readFileSync(path.join(out, "libcublas.so.12"))).toEqual(big);
      expect(readFileSync(path.join(out, "libcublasLt.so.12"), "utf8")).toBe("lt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
