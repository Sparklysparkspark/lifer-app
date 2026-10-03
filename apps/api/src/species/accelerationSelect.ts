// The hardware self-test: finds the GPU backends this machine has, checks each gives the same
// answers as the CPU, times them, and keeps the fastest for each model (acceleration.ts). Runs once
// per machine, remembered until the hardware, driver, runtime or model files change. Anything that
// fails or isn't faster leaves that model on the CPU, so a GPU can only help. Config-free, so the
// desktop's inference sidecar runs it too.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setPlan, type AccelerationPlan, type ModelFamily, type Placement } from "./acceleration.js";
import { ensureGpuRuntime, detectNvidiaGpu, installedGpuRuntime, type NvidiaGpu } from "./gpuRuntime.js";
import { probeModel, type ProbeResult, type ProviderSpec } from "./inference.js";

// A GPU result must match the CPU's full-precision one this closely (it's 1.0000 when right; a
// backend that mishandles a model lands far lower).
const MIN_AGREEMENT = 0.999;
// A GPU must beat the CPU by this much to be worth a separate process and memory.
const MIN_SPEEDUP = 1.15;
const PROBE_RUNS = 5;
const CACHE_VERSION = 1;

export interface AcceleratedModel {
  family: ModelFamily;
  /** The file the CPU runs (int8 for the encoders). */
  cpuPath: string;
  /** The full-precision copy a GPU runs; null when this model has none. */
  gpuPath: string | null;
  /** Fetches gpuPath when it's missing. */
  downloadGpuCopy: (onProgress: (done: number, total: number | null) => void) => Promise<void>;
  dims: number[];
}

export interface Backend {
  id: string;
  label: string;
  providers: ProviderSpec[];
  /** Needs a downloaded runtime first (NVIDIA on Linux). */
  cuda?: NvidiaGpu;
}

export interface AccelerationStatus {
  state: "idle" | "testing" | "downloading" | "done" | "failed";
  message: string | null;
  progress: { done: number; total: number | null } | null;
  /** Per model: where it runs and how fast, once tested. */
  models: Array<{ family: ModelFamily; backend: string; ms: number; cpuMs: number }>;
  device: string | null;
  testedAt: string | null;
}

let status: AccelerationStatus = { state: "idle", message: null, progress: null, models: [], device: null, testedAt: null };
let running: Promise<void> | null = null;

export function accelerationStatus(): AccelerationStatus {
  return status;
}

const update = (patch: Partial<AccelerationStatus>) => (status = { ...status, ...patch });

function renderNodes(): string[] {
  try {
    return readdirSync("/dev/dri").filter((d) => d.startsWith("renderD"));
  } catch {
    return [];
  }
}

async function candidateBackends(): Promise<Backend[]> {
  const out: Backend[] = [];
  if (process.platform === "darwin") {
    out.push({ id: "webgpu", label: "the Mac's GPU (WebGPU)", providers: ["webgpu"] });
    // ML Program: Core ML's format that covers far more of these models than the old one.
    out.push({ id: "coreml", label: "the Mac's GPU and Neural Engine (Core ML)", providers: [{ name: "coreml", coreMlFlags: 0x010 }] });
  } else if (process.platform === "win32") {
    out.push({ id: "dml", label: "the GPU (DirectML)", providers: ["dml"] });
    out.push({ id: "webgpu", label: "the GPU (WebGPU)", providers: ["webgpu"] });
  } else if (process.platform === "linux") {
    const nvidia = await detectNvidiaGpu();
    if (nvidia && nvidia.cudaMajor >= 12) out.push({ id: "cuda", label: nvidia.name, providers: ["cuda"], cuda: nvidia });
    // Intel and AMD (and NVIDIA without CUDA) through Vulkan, when a GPU is passed in.
    if (renderNodes().length > 0) out.push({ id: "webgpu", label: "the GPU (Vulkan)", providers: ["webgpu"] });
  }
  return out;
}

function fingerprint(models: AcceleratedModel[], backends: Backend[]): string {
  const ort = (createRequire(import.meta.url)("onnxruntime-node/package.json") as { version: string }).version;
  const size = (p: string | null) => (p && existsSync(p) ? statSync(p).size : 0);
  return JSON.stringify({
    v: CACHE_VERSION,
    // The OS release too: on macOS and Windows it brings the GPU drivers.
    platform: `${process.platform}-${process.arch}-${os.release()}`,
    cpu: os.cpus()[0]?.model ?? "",
    ort,
    backends: backends.map((b) => `${b.id}:${b.cuda ? `${b.cuda.name}/${b.cuda.driver}` : ""}`),
    models: models.map((m) => `${m.family}:${path.basename(m.cpuPath)}:${size(m.cpuPath)}:${m.gpuPath ? path.basename(m.gpuPath) : ""}`),
  });
}

interface Cache {
  fingerprint: string;
  plan: AccelerationPlan;
  status: AccelerationStatus;
}

function readCache(file: string): Cache | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Cache;
  } catch {
    return null;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d += a[i] * b[i];
  return d;
}

/** Runs the self-test unless a remembered result still fits this machine; `force` re-tests. */
export function selectAcceleration(opts: {
  cacheFile: string;
  gpuRuntimeRoot: string;
  models: AcceleratedModel[];
  force?: boolean;
  log?: (m: string) => void;
  /** In place of detecting this machine's backends (tests). */
  backends?: Backend[];
}): Promise<void> {
  // Reported straight away, so Settings shows a re-test as started.
  if (opts.force) update({ state: "testing", message: "Checking this computer's hardware", progress: null });
  // A re-test asked for mid-test runs once this one ends, rather than being dropped.
  if (running) {
    if (opts.force) rerun = opts;
    return running;
  }
  running = run(opts).finally(() => {
    running = null;
    const next = rerun;
    rerun = null;
    if (next) void selectAcceleration(next);
  });
  return running;
}

let rerun: Parameters<typeof selectAcceleration>[0] | null = null;
// Bumped to stop a running self-test (the models were offloaded): it then saves nothing.
let generation = 0;

/** Stops a running self-test and leaves everything on the CPU. */
export function cancelAcceleration(): void {
  generation++;
  rerun = null;
  setPlan({ device: null, runtime: null, placements: {} });
  status = { state: "idle", message: null, progress: null, models: [], device: null, testedAt: null };
}

async function run(opts: Parameters<typeof selectAcceleration>[0]): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[acceleration] ${m}`));
  const gen = generation;
  const cancelled = () => gen !== generation;
  const models = opts.models.filter((m) => existsSync(m.cpuPath));
  if (models.length === 0) {
    update({ state: "idle", message: null, progress: null });
    return;
  }
  const backends = opts.backends ?? (await candidateBackends());
  const print = fingerprint(models, backends);
  const cached = opts.force ? null : readCache(opts.cacheFile);
  // A remembered runtime whose files were removed is tested (and fetched) again.
  if (cached?.fingerprint === print && (!cached.plan.runtime || existsSync(cached.plan.runtime.ortModule))) {
    setPlan(cached.plan);
    status = cached.status;
    return;
  }
  const cpuOnly: AccelerationPlan = { device: null, runtime: null, placements: {} };
  if (backends.length === 0) {
    setPlan(cpuOnly);
    save(opts.cacheFile, print, cpuOnly, { ...status, state: "done", message: null, models: [], device: null, testedAt: new Date().toISOString() });
    return;
  }

  try {
    update({ state: "testing", message: "Checking this computer's hardware", progress: null });
    // The GPU copies first: a GPU is only tried with the full-precision files.
    for (const m of models) {
      if (!m.gpuPath || existsSync(m.gpuPath)) continue;
      update({ state: "downloading", message: "Downloading the GPU copy of the species-matching model", progress: { done: 0, total: null } });
      await m.downloadGpuCopy((done, total) => update({ progress: { done, total } }));
      if (cancelled()) return;
    }
    update({ state: "testing", message: "Timing species matching on the CPU", progress: null });

    // The CPU as it runs today, and its full-precision answer every GPU result is checked against.
    const cpu = new Map<ModelFamily, ProbeResult>();
    const reference = new Map<ModelFamily, ProbeResult>();
    for (const m of models) {
      cpu.set(m.family, await probeModel(m.cpuPath, ["cpu"], m.dims, PROBE_RUNS));
      const full = m.gpuPath ?? m.cpuPath;
      reference.set(m.family, full === m.cpuPath ? cpu.get(m.family)! : await probeModel(full, ["cpu"], m.dims, 1));
    }

    // Each backend: per model, the time when it agrees with the CPU, else nothing.
    const results: Array<{ backend: Backend; runtime: AccelerationPlan["runtime"]; times: Map<ModelFamily, number> }> = [];
    // A backend whose download failed isn't tried, and the result isn't remembered, so the next
    // start tries it again (offline, disk full).
    let incomplete = false;
    for (const backend of backends) {
      if (cancelled()) return;
      let runtime: AccelerationPlan["runtime"] = null;
      if (backend.cuda) {
        const major = backend.cuda.cudaMajor >= 13 ? 13 : 12;
        try {
          let rt = installedGpuRuntime(opts.gpuRuntimeRoot, major);
          if (!rt) {
            update({ state: "downloading", message: `Downloading NVIDIA's libraries for ${backend.label}`, progress: { done: 0, total: null } });
            rt = await ensureGpuRuntime(opts.gpuRuntimeRoot, major, { onProgress: (done, total) => update({ progress: { done, total } }) });
          }
          runtime = { id: `cuda${major}`, ortModule: rt.ortModule, libraryPath: rt.libraryPath };
        } catch (err) {
          log(`${backend.id}: couldn't download its libraries (${(err as Error).message})`);
          incomplete = true;
          continue;
        }
        if (cancelled()) return;
      }
      update({ state: "testing", message: `Testing species matching on ${backend.label}`, progress: null });
      // Probes for a downloaded runtime run in its own process (inference.ts).
      setPlan({ ...cpuOnly, runtime });
      const times = new Map<ModelFamily, number>();
      for (const m of models) {
        const file = m.gpuPath ?? m.cpuPath;
        try {
          const r = await probeModel(file, backend.providers, m.dims, PROBE_RUNS);
          const agreement = cosine(r.vector, reference.get(m.family)!.vector);
          if (agreement >= MIN_AGREEMENT) times.set(m.family, r.ms);
          else log(`${backend.id}: ${m.family} gave different answers (${agreement.toFixed(4)}), not used`);
        } catch (err) {
          log(`${backend.id}: ${m.family} couldn't run (${(err as Error).message.split("\n")[0]})`);
        }
      }
      results.push({ backend, runtime, times });
    }

    // One GPU backend for everything: the one that saves the most time overall.
    const saved = (r: (typeof results)[number]) =>
      models.reduce((sum, m) => {
        const ms = r.times.get(m.family);
        const base = cpu.get(m.family)!.ms;
        return sum + (ms !== undefined && ms * MIN_SPEEDUP <= base ? base - ms : 0);
      }, 0);
    const best = results.filter((r) => saved(r) > 0).sort((a, b) => saved(b) - saved(a))[0];
    const placements: Partial<Record<ModelFamily, Placement>> = {};
    const summary: AccelerationStatus["models"] = [];
    for (const m of models) {
      const ms = best?.times.get(m.family);
      const base = cpu.get(m.family)!.ms;
      if (best && ms !== undefined && ms * MIN_SPEEDUP <= base) {
        placements[m.family] = { backend: best.backend.id, modelPath: m.gpuPath ?? m.cpuPath, providers: best.backend.providers };
        summary.push({ family: m.family, backend: best.backend.id, ms, cpuMs: base });
      } else summary.push({ family: m.family, backend: "cpu", ms: base, cpuMs: base });
    }
    if (cancelled()) return;
    const plan: AccelerationPlan = best ? { device: best.backend.label, runtime: best.runtime, placements } : cpuOnly;
    setPlan(plan);
    const done: AccelerationStatus = { state: "done", message: null, progress: null, models: summary, device: plan.device, testedAt: new Date().toISOString() };
    if (incomplete) status = done;
    else save(opts.cacheFile, print, plan, done);
    log(best ? `using ${best.backend.label}: ${summary.map((s) => `${s.family} ${s.backend} ${Math.round(s.ms)} ms (CPU ${Math.round(s.cpuMs)})`).join(", ")}` : "the CPU is fastest here");
  } catch (err) {
    setPlan(cpuOnly);
    update({ state: "failed", message: `Couldn't set up GPU matching: ${(err as Error).message}`, progress: null });
    log(`failed, using the CPU: ${(err as Error).message}`);
  }
}

function save(file: string, print: string, plan: AccelerationPlan, s: AccelerationStatus): void {
  status = s;
  // Best effort: unremembered, the self-test just runs again next start.
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ fingerprint: print, plan, status: s } satisfies Cache));
  } catch {}
}

/** Forgets the remembered result, so the next selectAcceleration tests again. */
export function forgetAcceleration(cacheFile: string): void {
  rmSync(cacheFile, { force: true });
}
