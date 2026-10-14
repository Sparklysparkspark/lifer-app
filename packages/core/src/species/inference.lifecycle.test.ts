// The queue's handling of a worker that crashes, hangs or is replaced, driven through a fake
// thread or process so every path runs without a model.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerEvents, WorkerHandle } from "./inference.js";

type Runtime = { id: string; ortModule: string; libraryPath: string } | null;
const GPU: Runtime = { id: "cuda", ortModule: "/gpu/ort", libraryPath: "/gpu/lib" };

interface FakeWorker extends WorkerHandle {
  runtime: Runtime;
  on: WorkerEvents;
  posts: Array<{ id: number }>;
  terminated: boolean;
}

async function load(initialRuntime: Runtime) {
  vi.resetModules();
  delete process.env.LIFER_INFERENCE_IN_PROCESS;
  let planListener: ((plan: unknown) => void) | null = null;
  vi.doMock("./acceleration.js", () => ({
    currentPlan: () => ({ device: null, runtime: initialRuntime, placements: {} }),
    onPlanChange: (l: (plan: unknown) => void) => {
      planListener = l;
      return () => {};
    },
    placementFor: (_kind: string, modelPath: string) => ({ modelPath, providers: undefined }),
  }));
  vi.doMock("./inferenceWorker.js", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    handleRequest: vi.fn(async () => ({ ms: 1, output: [], inProcess: true })),
  }));
  const mod = await import("./inference.js");
  const started: FakeWorker[] = [];
  mod.setWorkerStarterForTests((runtime, on) => {
    const w: FakeWorker = {
      runtime,
      on,
      posts: [],
      terminated: false,
      post: (msg) => void w.posts.push(msg as { id: number }),
      terminate: async () => {
        w.terminated = true;
      },
      ref: () => {},
      unref: () => {},
    };
    started.push(w);
    return w;
  });
  const job = () => mod.probeModel("model.onnx", [], [1]);
  const lastId = (w: FakeWorker) => w.posts[w.posts.length - 1].id;
  const reply = (w: FakeWorker, result: unknown = { ms: 1, output: [] }) =>
    w.on.message({ type: "result", id: lastId(w), result } as never);
  const changePlan = (runtime: Runtime) => planListener!({ device: null, runtime, placements: {} });
  return { mod, started, job, reply, lastId, changePlan };
}

// Starts a job on a ready worker and kills the worker under it.
async function crashOnce(t: Awaited<ReturnType<typeof load>>) {
  const p = t.job();
  const w = t.started[t.started.length - 1];
  w.on.message({ type: "ready" });
  w.on.gone(new Error("segfault"));
  await expect(p).rejects.toThrow(/stopped unexpectedly: segfault/);
  return w;
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("./acceleration.js");
  vi.doUnmock("./inferenceWorker.js");
});

describe("inference worker lifecycle", () => {
  it("runs models in-process when the thread never comes up, retrying the job it held", async () => {
    const t = await load(null);
    const p = t.job();
    expect(t.started).toHaveLength(1);
    t.started[0].on.gone(new Error("no loader"));
    await expect(p).resolves.toMatchObject({ inProcess: true });
    expect(t.mod.inferenceMode()).toBe("in-process");
    expect(t.started).toHaveLength(1);
  });

  it("moves to a worker thread when the GPU process never comes up, requeuing the job", async () => {
    const t = await load(GPU);
    const p = t.job();
    expect(t.started[0].runtime).toEqual(GPU);
    t.started[0].on.gone(new Error("libcudart missing"));
    expect(t.started).toHaveLength(2);
    expect(t.started[1].runtime).toBeNull();
    expect(t.lastId(t.started[1])).toBe(t.lastId(t.started[0]));
    t.started[1].on.message({ type: "ready" });
    t.reply(t.started[1], { ms: 2, output: [7] });
    await expect(p).resolves.toEqual({ ms: 2, output: [7] });
    expect(t.mod.inferenceMode()).toBe("worker");
  });

  it("fails the running job when a ready worker crashes, and starts a new one for the next", async () => {
    const t = await load(GPU);
    await crashOnce(t);
    const next = t.job();
    expect(t.started).toHaveLength(2);
    expect(t.started[1].runtime).toEqual(GPU);
    t.reply(t.started[1]);
    await expect(next).resolves.toBeTruthy();
  });

  it("drops the GPU runtime after three crashes within ten minutes", async () => {
    vi.useFakeTimers();
    const t = await load(GPU);
    for (let i = 0; i < 3; i++) {
      await crashOnce(t);
      vi.advanceTimersByTime(60_000);
    }
    void t.job().catch(() => {});
    expect(t.started[3].runtime).toBeNull();
  });

  it("keeps the GPU runtime when crashes are spread out", async () => {
    vi.useFakeTimers();
    const t = await load(GPU);
    for (let i = 0; i < 4; i++) {
      await crashOnce(t);
      vi.advanceTimersByTime(11 * 60_000);
    }
    void t.job().catch(() => {});
    expect(t.started[4].runtime).toEqual(GPU);
  });

  it("restarts a worker whose model run hangs, and reports stuck after repeated timeouts", async () => {
    vi.useFakeTimers();
    const t = await load(null);
    for (let i = 0; i < 2; i++) {
      const p = t.job();
      const w = t.started[i];
      w.on.message({ type: "ready" });
      w.on.message({ type: "run-start", id: t.lastId(w), label: "clip" } as never);
      vi.advanceTimersByTime(20_000);
      await expect(p).rejects.toThrow(/took too long on this photo \(a model run\)/);
      expect(w.terminated).toBe(true);
      // Its late exit is ignored: it was replaced on purpose.
      w.on.gone(new Error("terminated"));
    }
    expect(t.mod.isInferenceStuck()).toBe(true);
    const p = t.job();
    expect(t.started).toHaveLength(3);
    t.reply(t.started[2]);
    await expect(p).resolves.toBeTruthy();
    expect(t.mod.isInferenceStuck()).toBe(false);
  });

  it("stops a job that hangs outside any model run at the job ceiling", async () => {
    vi.useFakeTimers();
    const t = await load(null);
    const p = t.job();
    t.started[0].on.message({ type: "ready" });
    vi.advanceTimersByTime(179_000);
    t.started[0].on.message({ type: "run-end", id: t.lastId(t.started[0]) } as never);
    vi.advanceTimersByTime(2_000);
    await expect(p).rejects.toThrow(/the whole job/);
  });

  it("replaces an idle worker at once on a plan change", async () => {
    const t = await load(null);
    const p = t.job();
    t.reply(t.started[0]);
    await p;
    t.changePlan(GPU);
    expect(t.started[0].terminated).toBe(true);
    void t.job().catch(() => {});
    expect(t.started[1].runtime).toEqual(GPU);
  });

  it("replaces a busy worker only after its job finishes", async () => {
    const t = await load(null);
    const first = t.job();
    const second = t.job();
    t.changePlan(GPU);
    expect(t.started[0].terminated).toBe(false);
    t.reply(t.started[0]);
    await first;
    expect(t.started[0].terminated).toBe(true);
    expect(t.started[1].runtime).toEqual(GPU);
    t.reply(t.started[1]);
    await expect(second).resolves.toBeTruthy();
  });

  it("stopInference fails running and queued jobs and waits for the worker to exit", async () => {
    const t = await load(null);
    const running = t.job();
    const queued = t.job();
    await t.mod.stopInference();
    await expect(running).rejects.toThrow(/was stopped/);
    await expect(queued).rejects.toThrow(/was stopped/);
    expect(t.started[0].terminated).toBe(true);
    // A message from the stopped worker changes nothing.
    t.reply(t.started[0]);
  });
});
