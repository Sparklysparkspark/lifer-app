import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => vi.fn());
vi.mock("./inference.js", () => ({ probeModel: probe }));

const { selectAcceleration, accelerationStatus } = await import("./accelerationSelect.js");
const { currentPlan, setPlan } = await import("./acceleration.js");

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
