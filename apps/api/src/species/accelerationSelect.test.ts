import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@lifer/core/species/inference.js", () => ({ probeModel: probe }));
// No test downloads anything: a runtime the CUDA backend needs is either assembled by the test
// beforehand or its download fails here.
const download = vi.hoisted(() => vi.fn());
vi.mock("@lifer/core/lib/resumableDownload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/lib/resumableDownload.js")>()),
  downloadResumable: download,
}));

const { selectAcceleration, accelerationStatus } = await import("./accelerationSelect.js");
const { currentPlan, setPlan } = await import("@lifer/core/species/acceleration.js");
const { RUNTIME_SETS } = await import("./gpuRuntime.js");

const unit = (...xs: number[]) => {
  const v = new Float32Array(xs);
  const n = Math.hypot(...xs);
  return v.map((x) => x / n);
};
const RIGHT = unit(1, 2, 3);
const WRONG = unit(3, -2, 1);

let dir: string;
let cpuPath: string;
let gpuPath: string;
const gpu = { id: "webgpu", label: "Test GPU", providers: ["webgpu"] };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-accel-"));
  cpuPath = path.join(dir, "model-int8.onnx");
  gpuPath = path.join(dir, "model-fp32.onnx");
  writeFileSync(cpuPath, "int8");
  writeFileSync(gpuPath, "fp32");
  probe.mockReset();
  download.mockReset();
  download.mockRejectedValue(new Error("offline"));
  setPlan({ device: null, runtime: null, placements: {} });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** probeModel answering per (file, backend). */
function answers(table: Record<string, { ms: number; vector: Float32Array } | Error>) {
  probe.mockImplementation(async (file: string, providers: string[]) => {
    const key = `${path.basename(file)}|${providers[0]}`;
    const a = table[key];
    if (!a) throw new Error(`unexpected probe ${key}`);
    if (a instanceof Error) throw a;
    return { probe: true, ...a };
  });
}

const run = (force = true) =>
  selectAcceleration({
    cacheFile: path.join(dir, "acceleration.json"),
    gpuRuntimeRoot: path.join(dir, "gpu"),
    force,
    log: () => {},
    backends: [gpu],
    models: [{ family: "id", cpuPath, gpuPath, downloadGpuCopy: async () => {}, dims: [1, 3, 224, 224] }],
  });

describe("selectAcceleration", () => {
  it("moves a model to a GPU that's faster and gives the same answers, and remembers it", async () => {
    answers({
      "model-int8.onnx|cpu": { ms: 500, vector: RIGHT },
      "model-fp32.onnx|cpu": { ms: 600, vector: RIGHT },
      "model-fp32.onnx|webgpu": { ms: 100, vector: RIGHT },
    });
    await run();
    expect(currentPlan().placements.id).toMatchObject({ backend: "webgpu", modelPath: gpuPath });
    expect(accelerationStatus()).toMatchObject({ state: "done", device: "Test GPU" });

    // Same machine and files: the remembered result, no new probes.
    probe.mockClear();
    setPlan({ device: null, runtime: null, placements: {} });
    await run(false);
    expect(probe).not.toHaveBeenCalled();
    expect(currentPlan().placements.id?.backend).toBe("webgpu");
  });

  it("tests again when a remembered GPU runtime's files are gone", async () => {
    answers({
      "model-int8.onnx|cpu": { ms: 500, vector: RIGHT },
      "model-fp32.onnx|cpu": { ms: 600, vector: RIGHT },
      "model-fp32.onnx|webgpu": { ms: 100, vector: RIGHT },
    });
    await run();
    const cacheFile = path.join(dir, "acceleration.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    cache.plan.runtime = { id: "cuda12", ortModule: path.join(dir, "gone"), libraryPath: "" };
    writeFileSync(cacheFile, JSON.stringify(cache));
    probe.mockClear();
    await run(false);
    expect(probe).toHaveBeenCalled();
    expect(currentPlan().runtime).toBeNull();
  });

  it("stays on the CPU when the GPU gives different answers", async () => {
    answers({
      "model-int8.onnx|cpu": { ms: 500, vector: RIGHT },
      "model-fp32.onnx|cpu": { ms: 600, vector: RIGHT },
      "model-fp32.onnx|webgpu": { ms: 50, vector: WRONG },
    });
    await run();
    expect(currentPlan().placements.id).toBeUndefined();
  });

  it("stays on the CPU when the GPU isn't clearly faster", async () => {
    answers({
      "model-int8.onnx|cpu": { ms: 500, vector: RIGHT },
      "model-fp32.onnx|cpu": { ms: 600, vector: RIGHT },
      "model-fp32.onnx|webgpu": { ms: 480, vector: RIGHT },
    });
    await run();
    expect(currentPlan().placements.id).toBeUndefined();
  });

  it("stays on the CPU when the GPU can't run the model", async () => {
    answers({
      "model-int8.onnx|cpu": { ms: 500, vector: RIGHT },
      "model-fp32.onnx|cpu": { ms: 600, vector: RIGHT },
      "model-fp32.onnx|webgpu": new Error("no adapter"),
    });
    await run();
    expect(currentPlan().placements.id).toBeUndefined();
    expect(accelerationStatus().state).toBe("done");
  });
});

describe("selectAcceleration on an NVIDIA GPU", () => {
  const nvidia = (driver: string, cudaMajor: number) => ({
    id: "cuda",
    label: "Test NVIDIA",
    providers: ["cuda"],
    cuda: { name: "Test NVIDIA", driver, cudaMajor },
  });

  /** A runtime as ensureGpuRuntime leaves it, with the CUDA provider beside the binding. */
  function assembled(root: string, major: 12 | 13): string {
    const dir = path.join(root, `cuda${major}-ort${RUNTIME_SETS[major].ortVersion}`);
    const binding = path.join("node_modules", "onnxruntime-node", "bin", "napi-v6", "linux", "x64");
    const files = [
      path.join(binding, "onnxruntime_binding.node"),
      path.join(binding, "libonnxruntime_providers_cuda.so"),
      path.join(binding, "libonnxruntime_providers_shared.so"),
      path.join("lib", `libcudart.so.${major}`),
    ];
    for (const f of files) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), "");
    }
    writeFileSync(path.join(dir, "ready"), JSON.stringify({ files }));
    return dir;
  }

  const runOn = (backend: ReturnType<typeof nvidia>, log: (m: string) => void = () => {}) =>
    selectAcceleration({
      cacheFile: path.join(dir, "acceleration.json"),
      gpuRuntimeRoot: path.join(dir, "gpu"),
      force: true,
      log,
      backends: [backend],
      models: [{ family: "id", cpuPath, gpuPath, downloadGpuCopy: async () => {}, dims: [1, 3, 224, 224] }],
    });

  it.each([
    ["550.127.05", 12],
    ["580.65.06", 13],
  ] as const)("runs CUDA (driver %s) on the downloaded CUDA %i runtime, not the bundled onnxruntime-node", async (driver, major) => {
    const runtimeDir = assembled(path.join(dir, "gpu"), major);
    // The runtime in force while CUDA is probed: probes for it run in a process that loads it.
    let probedWith: unknown = "not probed";
    probe.mockImplementation(async (file: string, providers: string[]) => {
      if (providers[0] === "cuda") probedWith = currentPlan().runtime;
      const ms = providers[0] === "cuda" ? 100 : path.basename(file) === "model-int8.onnx" ? 500 : 600;
      return { probe: true, ms, vector: RIGHT };
    });
    await runOn(nvidia(driver, major));

    const ortModule = path.join(runtimeDir, "node_modules", "onnxruntime-node");
    const providerDir = path.join(ortModule, "bin", "napi-v6", "linux", "x64");
    const expected = { id: `cuda${major}`, ortModule, libraryPath: `${path.join(runtimeDir, "lib")}:${providerDir}` };
    expect(probedWith).toEqual(expected);
    expect(currentPlan().runtime).toEqual(expected);
    expect(currentPlan().placements.id).toMatchObject({ backend: "cuda", providers: ["cuda"] });
    // The CUDA provider it loads is the downloaded one, on the library path.
    expect(existsSync(path.join(providerDir, "libonnxruntime_providers_cuda.so"))).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });

  it("falls back to the CPU with a log line when the download fails, and tries again next start", async () => {
    answers({
      "model-int8.onnx|cpu": { ms: 500, vector: RIGHT },
      "model-fp32.onnx|cpu": { ms: 600, vector: RIGHT },
    });
    const logs: string[] = [];
    await runOn(nvidia("550.127.05", 12), (m) => logs.push(m));

    expect(download).toHaveBeenCalled();
    // CUDA is never tried without its runtime.
    expect(probe.mock.calls.every(([, providers]) => providers[0] === "cpu")).toBe(true);
    expect(currentPlan()).toEqual({ device: null, runtime: null, placements: {} });
    expect(accelerationStatus()).toMatchObject({ state: "done", device: null });
    expect(logs.some((m) => /^cuda: couldn't download its libraries \(.*offline.*\), so Test NVIDIA isn't used/.test(m))).toBe(true);
    expect(logs.at(-1)).toBe("using the CPU: a GPU's libraries couldn't be downloaded");
    // Not remembered, so the next start downloads again.
    expect(existsSync(path.join(dir, "acceleration.json"))).toBe(false);
  });
});
