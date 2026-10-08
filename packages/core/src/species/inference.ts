// Main-thread side of local inference: a priority queue in front of one worker thread
// (inferenceWorker.ts) that owns every model session, so the API thread stays responsive.
//
// Priorities: "interactive" (someone is waiting) > "commit" (a photo just imported) >
// "background" (backfills, warm-up).
//
// Timeouts cover only a model run, never queue time. A hung run gets the worker restarted; its job
// fails and the rest carry on. Config-free so the desktop inference sidecar can reuse it.
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import {
  WORKER_MARKER,
  type AnalyzeResult,
  type CardCrop,
  type EmbedTarget,
  type InferenceRequest,
  type InferenceResult,
  type ProbeResult,
  type ProviderSpec,
  type RunHooks,
  type SubjectPresence,
  type TextModelSpec,
  type WorkerMessage,
} from "./inferenceWorker.js";
import { currentPlan, onPlanChange, placementFor } from "./acceleration.js";
import { log } from "../lib/log.js";

export type { AnalyzeResult, CardCrop, EmbedTarget, ProbeResult, ProviderSpec, SubjectPresence, TextModelSpec };

export type Priority = "interactive" | "commit" | "background";
const PRIORITIES: Priority[] = ["interactive", "commit", "background"];

/** Bundled with the source, so it ships with Docker and the desktop app as is. */
export const DETECTOR_MODEL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "models", "yolov8n.onnx");

// One model run. Past this, something is wrong with the native call.
const RUN_TIMEOUT_MS = 20_000;
// Whole job after it reaches the worker, including a first model load: a last resort for a hang
// outside any run (a corrupt model file, a stuck decode).
const JOB_CEILING_MS = 180_000;
// Backfills stop instead of feeding more photos to a model that keeps timing out.
const MAX_CONSECUTIVE_TIMEOUTS = 2;

interface Job {
  id: number;
  request: InferenceRequest;
  priority: Priority;
  resolve: (result: InferenceResult) => void;
  reject: (err: Error) => void;
}

const queues: Record<Priority, Job[]> = { interactive: [], commit: [], background: [] };
let running: Job | null = null;
let nextId = 1;
let consecutiveTimeouts = 0;

let mode: "worker" | "in-process" = process.env.LIFER_INFERENCE_IN_PROCESS === "1" ? "in-process" : "worker";

// The models run in a worker thread, or in a child process when a downloaded GPU runtime needs
// its own library path, which only a new process can be given (acceleration.ts).
interface WorkerHandle {
  post(msg: unknown, transfer: ArrayBuffer[]): void;
  terminate(): void;
  ref(): void;
  unref(): void;
}
let worker: WorkerHandle | null = null;
let runtime = currentPlan().runtime;
let workerReady = false;
// The plan's runtime changed while a job ran: the worker is replaced once it's done.
let replaceAfterJob = false;
let runTimer: ReturnType<typeof setTimeout> | null = null;
let jobTimer: ReturnType<typeof setTimeout> | null = null;

function workerEntry(): { url: URL; execArgv: string[] } {
  const here = import.meta.url;
  // A worker thread starts with no TypeScript loader, so it gets tsx's explicitly.
  if (here.endsWith(".ts")) {
    const loader = pathToFileURL(createRequire(here).resolve("tsx")).href;
    return { url: new URL("./inferenceWorker.ts", here), execArgv: ["--import", loader] };
  }
  return { url: new URL("./inferenceWorker.js", here), execArgv: [] };
}

// Node ignores --import in a worker thread's execArgv, so under tsx the thread starts from a
// one-line module that registers tsx itself before loading the worker. Without it the worker's own
// ".js" imports of ".ts" files fail and inference silently falls back to running in-process.
function tsxThreadEntry(url: URL): URL {
  // The ESM build: tsx 4.23.15's CommonJS one resolves its loader one folder too deep on Node
  // versions without module.registerHooks (before 22.22.3).
  const tsxApi = import.meta.resolve("tsx/esm/api");
  const boot = `import { register } from ${JSON.stringify(tsxApi)}; register(); await import(${JSON.stringify(url.href)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(boot)}`);
}

function startWorker(): WorkerHandle {
  const { url, execArgv } = workerEntry();
  workerReady = false;
  replaceAfterJob = false;
  if (runtime) return startChild(url, execArgv, runtime);
  const t = new Worker(execArgv.length > 0 ? tsxThreadEntry(url) : url, { workerData: { marker: WORKER_MARKER } });
  const w: WorkerHandle = {
    post: (msg, transfer) => t.postMessage(msg, transfer),
    terminate: () => void t.terminate(),
    ref: () => t.ref(),
    unref: () => t.unref(),
  };
  t.on("message", (msg: WorkerMessage) => onWorkerMessage(w, msg));
  t.on("error", (err) => onWorkerGone(w, err));
  t.on("exit", (code) => onWorkerGone(w, new Error(`the inference worker exited (code ${code})`)));
  return w;
}

function startChild(url: URL, execArgv: string[], rt: NonNullable<typeof runtime>): WorkerHandle {
  const env = {
    ...process.env,
    LIFER_INFERENCE_CHILD: WORKER_MARKER,
    LIFER_ORT_MODULE: rt.ortModule,
    LD_LIBRARY_PATH: [rt.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const c: ChildProcess = fork(fileURLToPath(url), [], {
    execArgv,
    env,
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const w: WorkerHandle = {
    post: (msg) => c.send(msg as never),
    terminate: () => void c.kill(),
    ref: () => {
      c.ref();
      c.channel?.ref();
    },
    unref: () => {
      c.unref();
      c.channel?.unref();
    },
  };
  c.on("message", (msg: WorkerMessage) => onWorkerMessage(w, msg));
  c.on("error", (err) => onWorkerGone(w, err));
  c.on("exit", (code) => onWorkerGone(w, new Error(`the inference process exited (code ${code})`)));
  return w;
}

const MAX_RUNTIME_CRASHES = 3;
let runtimeCrashes = 0;

// A new GPU runtime takes effect from the next job: the current process is replaced once idle.
onPlanChange((plan) => {
  if (JSON.stringify(plan.runtime) === JSON.stringify(runtime)) return;
  runtime = plan.runtime;
  runtimeCrashes = 0;
  if (mode !== "worker") return;
  const w = worker;
  if (w && !running) {
    worker = null;
    w.terminate();
  } else if (w) replaceAfterJob = true;
});

function clearTimers(): void {
  if (runTimer) clearTimeout(runTimer);
  if (jobTimer) clearTimeout(jobTimer);
  runTimer = null;
  jobTimer = null;
}

function finish(job: Job, outcome: { result: InferenceResult } | { error: Error }): void {
  if (running !== job) return;
  clearTimers();
  running = null;
  if (replaceAfterJob && worker) {
    replaceAfterJob = false;
    const w = worker;
    worker = null;
    w.terminate();
  }
  if ("error" in outcome) job.reject(outcome.error);
  else {
    consecutiveTimeouts = 0;
    job.resolve(outcome.result);
  }
  pump();
}

function onWorkerMessage(w: WorkerHandle, msg: WorkerMessage): void {
  if (w !== worker) return;
  if (msg.type === "ready") {
    workerReady = true;
    return;
  }
  const job = running;
  if (!job || msg.id !== job.id) return;
  if (msg.type === "run-start") armRunTimer(job);
  else if (msg.type === "run-end") {
    if (runTimer) clearTimeout(runTimer);
    runTimer = null;
  } else if (msg.type === "result") finish(job, { result: msg.result });
  else finish(job, { error: new Error(msg.message) });
}

function onWorkerGone(w: WorkerHandle, err: Error): void {
  if (w !== worker) return; // already replaced (a timeout terminated it on purpose)
  worker = null;
  const job = running;
  if (!workerReady) {
    if (runtime) {
      // A GPU runtime's process never came up: a worker thread with the bundled runtime instead,
      // where GPU sessions fall back to the CPU. The job it was holding is retried there.
      log.warn(`[inference] Couldn't start the GPU inference process (${err.message}); using a worker thread`);
      runtime = null;
    } else {
      // The thread never came up (no tsx loader, an unsupported runtime): run in-process from now
      // on rather than failing every photo. The job it was holding is retried there.
      log.warn(`[inference] Couldn't start the inference worker (${err.message}); running models in-process`);
      mode = "in-process";
    }
    if (job) {
      clearTimers();
      running = null;
      queues[job.priority].unshift(job);
    }
    pump();
    return;
  }
  // A GPU runtime's process that keeps dying: the bundled runtime from here on.
  if (runtime && ++runtimeCrashes >= MAX_RUNTIME_CRASHES) {
    log.warn(`[inference] The GPU inference process keeps stopping (${err.message}); using a worker thread`);
    runtime = null;
  }
  if (job) finish(job, { error: new Error(`Species matching stopped unexpectedly: ${err.message}`) });
}

function timedOut(job: Job, what: string): void {
  if (running !== job) return;
  consecutiveTimeouts++;
  const err = new Error(`Species matching took too long on this photo (${what}), so it was stopped and restarted`);
  if (mode === "worker") {
    const w = worker;
    worker = null; // onWorkerGone ignores this one's exit
    w?.terminate();
    finish(job, { error: err });
  } else {
    // In-process a native call can't be stopped: fail the caller now, and keep the queue held
    // until the call really returns so nothing piles onto the same session.
    job.reject(err);
    job.resolve = () => {};
    job.reject = () => {};
  }
}

function armRunTimer(job: Job): void {
  if (runTimer) clearTimeout(runTimer);
  runTimer = setTimeout(() => timedOut(job, "a model run"), RUN_TIMEOUT_MS);
}

function nextJob(): Job | null {
  for (const p of PRIORITIES) {
    const job = queues[p].shift();
    if (job) return job;
  }
  return null;
}

/** Image bytes are copied once into their own buffer and handed over (not cloned again): a Node
 * Buffer often shares its memory with unrelated data, so it can't be transferred itself. */
function forTransfer(request: InferenceRequest): { request: InferenceRequest; transfer: ArrayBuffer[] } {
  if (request.op !== "analyze" || !("bytes" in request.image)) return { request, transfer: [] };
  const copy = new Uint8Array(request.image.bytes.byteLength);
  copy.set(request.image.bytes);
  return { request: { ...request, image: { bytes: copy } }, transfer: [copy.buffer] };
}

function pump(): void {
  if (running) return;
  const job = nextJob();
  if (!job) {
    worker?.unref(); // an idle worker never keeps the process alive
    return;
  }
  running = job;
  if (mode === "in-process") {
    void runInProcess(job);
    return;
  }
  try {
    worker ??= startWorker();
  } catch (err) {
    log.warn(`[inference] Couldn't start the inference worker (${(err as Error).message}); running models in-process`);
    mode = "in-process";
    void runInProcess(job);
    return;
  }
  worker.ref();
  jobTimer = setTimeout(() => timedOut(job, "the whole job"), JOB_CEILING_MS);
  const { request, transfer } = forTransfer(job.request);
  worker.post({ id: job.id, request }, transfer);
}

async function runInProcess(job: Job): Promise<void> {
  const hooks: RunHooks = {
    runStarted: () => armRunTimer(job),
    runEnded: () => {
      if (runTimer) clearTimeout(runTimer);
      runTimer = null;
    },
  };
  try {
    const core = await import("./inferenceWorker.js");
    const result = await core.handleRequest(job.request, hooks);
    finish(job, { result });
  } catch (err) {
    finish(job, { error: err instanceof Error ? err : new Error(String(err)) });
  }
}

function submit<T extends InferenceResult>(request: InferenceRequest, priority: Priority): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[priority].push({
      id: nextId++,
      request,
      priority,
      resolve: resolve as (r: InferenceResult) => void,
      reject,
    });
    pump();
  });
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

// The same Buffer is often hashed by several callers in one request; remember it per object.
const hashes = new WeakMap<Uint8Array, string>();

/** sha256 hex of a photo's bytes: the key every memo of per-photo results uses. */
export function contentHash(bytes: Uint8Array): string {
  let hash = hashes.get(bytes);
  if (!hash) {
    hash = createHash("sha256").update(bytes).digest("hex");
    hashes.set(bytes, hash);
  }
  return hash;
}

/** The image and model library versions that decide the exact floats a photo turns into. A
 * desktop app computing vectors for a server must match it, not just the pipeline version. */
export function inferenceRuntime(): string {
  const ort = (createRequire(import.meta.url)("onnxruntime-node/package.json") as { version: string }).version;
  return `sharp ${sharp.versions.sharp ?? "?"} vips ${sharp.versions.vips} jpeg ${sharp.versions.mozjpeg ?? "?"} ort ${ort}`;
}

/** A photo's bytes, or a path the worker reads itself (nothing big held while it waits). */
export type ImageSource = Buffer | Uint8Array | { path: string };

/** Everything wanted from one photo in one job, so it's decoded once: a vector per target,
 * the presence reading and a default card crop. `key` is the content hash. */
export function analyzeImage(
  image: ImageSource,
  opts: {
    targets: EmbedTarget[];
    key?: string | null;
    presence?: boolean;
    cardCrop?: boolean;
    subject?: boolean;
    priority: Priority;
  },
): Promise<AnalyzeResult> {
  return submit<AnalyzeResult>(
    {
      op: "analyze",
      image: "path" in image && typeof image.path === "string" ? { path: image.path } : { bytes: image as Uint8Array },
      key: opts.key ?? null,
      targets: opts.targets,
      ...detectorTarget(),
      presence: opts.presence ?? false,
      cardCrop: opts.cardCrop ?? false,
      subject: opts.subject ?? false,
    },
    opts.priority,
  );
}

/** L2-normalized text-encoder vectors, one per text, in one job. */
export function embedTexts(
  texts: string[],
  model: TextModelSpec,
  opts: { priority: Priority; allowDownload?: boolean },
): Promise<Float32Array[]> {
  return submit<Float32Array[]>(
    { op: "text", texts, model, allowDownload: opts.allowDownload ?? false },
    opts.priority,
  );
}

function detectorTarget(): { detectorPath: string; detectorProviders?: ProviderSpec[] } {
  const { modelPath, providers } = placementFor("detector", DETECTOR_MODEL_PATH);
  return { detectorPath: modelPath, detectorProviders: providers };
}

/** Starts the worker and loads the given models now, on the backends they run on, at background
 * priority. Best effort. */
export function warmModels(opts: {
  models: EmbedTarget[];
  detector?: boolean;
  text?: TextModelSpec | null;
}): Promise<void> {
  const detector = opts.detector ? detectorTarget() : null;
  return submit<null>(
    {
      op: "warm",
      models: opts.models.map((m) => ({ modelPath: m.modelPath, providers: m.providers })),
      detector: detector && { modelPath: detector.detectorPath, providers: detector.detectorProviders },
      text: opts.text ?? null,
    },
    "background",
  ).then(() => {});
}

/** Times one model on one backend and returns its output for a fixed input (the hardware
 *  self-test, accelerationSelect.ts). Rejects when the backend can't run it. */
export function probeModel(
  modelPath: string,
  providers: ProviderSpec[],
  dims: number[],
  runs = 5,
): Promise<ProbeResult> {
  return submit<ProbeResult>({ op: "probe", modelPath, providers, dims, runs }, "background");
}

/** Drops a loaded session (all of them when no path is given), e.g. after its file was deleted.
 * Queued ahead of other work, and never starts a worker just to release nothing. */
export function releaseModels(modelPath: string | null = null): void {
  if (mode === "worker" && !worker) return;
  submit({ op: "release", modelPath }, "interactive").catch(() => {});
}

/** Where models run: "worker" normally, "in-process" when asked to or when the thread couldn't start. */
export function inferenceMode(): "worker" | "in-process" {
  return mode;
}

/** Several runs in a row have timed out: backfills stop rather than keep feeding it photos. */
export function isInferenceStuck(): boolean {
  return consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS;
}

/** Jobs waiting per priority, plus whether one is running. */
export function inferenceQueueDepth(): Record<Priority, number> & { running: boolean } {
  return {
    interactive: queues.interactive.length,
    commit: queues.commit.length,
    background: queues.background.length,
    running: running !== null,
  };
}

/** For tests and shutdown: stops the worker; queued jobs fail. */
export async function stopInference(): Promise<void> {
  const w = worker;
  worker = null;
  const pending = [...(running ? [running] : []), ...PRIORITIES.flatMap((p) => queues[p].splice(0))];
  running = null;
  clearTimers();
  for (const job of pending) job.reject(new Error("Species matching was stopped"));
  await w?.terminate();
}
