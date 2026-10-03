// Local matching must never get in an import's way: outside the desktop app, in an older app
// without the commands, or on any error, the photo just goes to the server without vectors.
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

const photo = new Blob([new Uint8Array([1, 2, 3])]);

async function fresh(invoke: ((cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>) | null) {
  vi.resetModules();
  (globalThis as { window?: unknown }).window = invoke ? { __TAURI__: { core: { invoke } } } : {};
  return import("./localInference");
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("computeClientVectors", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ targets: ["clip", "id-crop"] });
  });

  it("is null outside the desktop app", async () => {
    const m = await fresh(null);
    expect(await m.computeClientVectors(photo)).toBeNull();
  });

  it("stays silent when the app doesn't have the commands", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("command local_inference_status not found"));
    const m = await fresh(invoke);
    expect(await m.computeClientVectors(photo)).toBeNull();
    await settle();
    expect(await m.computeClientVectors(photo)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("sends the photo as raw bytes with the server's targets once ready", async () => {
    const vectors = { pipelineVersion: 1, contentHash: "ab", clipFull: { modelVersion: "m", b64f32: "AAAA" } };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "local_inference_status" || cmd === "local_inference_prepare") return { ready: true, error: null };
      if (cmd === "local_embed") return vectors;
      throw new Error("unknown");
    });
    const m = await fresh(invoke);
    expect(await m.computeClientVectors(photo)).toBeNull(); // still getting ready
    await settle();
    expect(await m.computeClientVectors(photo)).toBe(JSON.stringify(vectors));
    const call = invoke.mock.calls.find((c) => c[0] === "local_embed")! as unknown[];
    expect(call[1]).toBeInstanceOf(Uint8Array);
    expect(call[2]).toEqual({ headers: { "x-lifer-targets": "clip,id-crop" } });
  });

  it("falls back to the server when preparing fails or an embed errors", async () => {
    let embedFails = true;
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "local_embed") {
        if (embedFails) throw new Error("Local matching isn't running");
        return { ok: 1 };
      }
      return { ready: true, error: null };
    });
    const m = await fresh(invoke);
    await m.computeClientVectors(photo);
    await settle();
    expect(await m.computeClientVectors(photo)).toBeNull();
    embedFails = false;
    await settle(); // re-prepared after the failure
    expect(await m.computeClientVectors(photo)).toBe(JSON.stringify({ ok: 1 }));

    get.mockResolvedValue({ targets: [] });
    const m2 = await fresh(vi.fn().mockResolvedValue({ ready: true, error: null }));
    await m2.computeClientVectors(photo);
    await settle();
    expect(await m2.computeClientVectors(photo)).toBeNull();
  });
});

describe("shouldMatchLocally", () => {
  it("measures this computer first, then the server, then keeps to the faster and re-checks the other", async () => {
    vi.resetModules();
    const m = await import("./localInference");
    expect(m.shouldMatchLocally()).toBe(true);
    m.recordLocalMatching(600);
    const early = [m.shouldMatchLocally(), m.shouldMatchLocally(), m.shouldMatchLocally()];
    expect(early).toContain(false); // the server gets tried soon
    m.recordServerMatching(120);
    const picks = Array.from({ length: 40 }, () => m.shouldMatchLocally());
    expect(picks.filter((p) => !p).length).toBeGreaterThan(35); // mostly the faster server
    expect(picks.filter((p) => p).length).toBeGreaterThan(0); // with the occasional re-check
  });
});
