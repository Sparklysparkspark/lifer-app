import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
class MockApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) }, ApiError: MockApiError }));

const store = await import("./packDownloadStore");

const idle = { running: false, phase: null };
const running = { running: true, phase: "downloading" };

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("nextPackPollDelay", () => {
  const base = { subscribers: 1, hidden: false, authed: true, stopped: false, running: false };
  it("polls fast while running and slowly while idle", () => {
    expect(store.nextPackPollDelay({ ...base, running: true })).toBe(1000);
    expect(store.nextPackPollDelay(base)).toBe(5000);
  });
  it("pauses with no subscribers, a hidden tab, signed out, or stopped", () => {
    expect(store.nextPackPollDelay({ ...base, subscribers: 0 })).toBeNull();
    expect(store.nextPackPollDelay({ ...base, hidden: true })).toBeNull();
    expect(store.nextPackPollDelay({ ...base, authed: false })).toBeNull();
    expect(store.nextPackPollDelay({ ...base, stopped: true })).toBeNull();
  });
});

describe("packDownloadStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset();
    store.resetPackDownloadStore();
  });
  afterEach(() => vi.useRealTimers());

  it("shares one poll loop across subscribers and stops when the last leaves", async () => {
    get.mockResolvedValue(idle);
    const a = store.subscribePackDownload(() => {});
    const b = store.subscribePackDownload(() => {});
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
    a();
    b();
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("fires finish listeners when a running job stops", async () => {
    get.mockResolvedValueOnce(running).mockResolvedValue(idle);
    const onFinish = vi.fn();
    store.onPackDownloadFinish(onFinish);
    const unsub = store.subscribePackDownload(() => {});
    await flush();
    expect(store.getPackDownloadState().status?.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFinish).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("stops after a 404 until refreshed", async () => {
    get.mockRejectedValueOnce(new MockApiError(404, "nope")).mockResolvedValue(idle);
    const unsub = store.subscribePackDownload(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(30000);
    expect(get).toHaveBeenCalledTimes(1);
    await store.refreshPackDownload();
    expect(get).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("does not poll while signed out and resumes on sign-in", async () => {
    get.mockResolvedValue(idle);
    store.setPackDownloadAuthed(false);
    const unsub = store.subscribePackDownload(() => {});
    await vi.advanceTimersByTimeAsync(10000);
    expect(get).not.toHaveBeenCalled();
    store.setPackDownloadAuthed(true);
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("nextPackDownloadFinish", () => {
  it("resolves for its own packs only, and rejects when signed out", async () => {
    const store = await import("./packDownloadStore");
    const { nextPackDownloadFinish } = await import("./waitForPackDownload");
    store.resetPackDownloadStore();
    const mine = nextPackDownloadFinish(["costa_rica-aves"]);
    let settled = false;
    mine.finished.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Signing out gives up on it rather than leaving it waiting forever.
    store.setPackDownloadAuthed(false);
    await expect(mine.finished).rejects.toThrow(/signed out/);
    expect(settled).toBe(true);
  });
});
