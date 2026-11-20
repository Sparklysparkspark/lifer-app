import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { MAX_WAIT_MS, retryAfterMs } from "./rateLimitWait";
import { uploadFile } from "./tusUpload";

// A stand-in tus client: the first upload is refused with 429 and Retry-After: 30, the next succeeds.
const tus = vi.hoisted(() => ({ starts: 0 }));
vi.mock("tus-js-client", () => ({
  Upload: class {
    url: string | null = null;
    constructor(
      _file: File,
      private options: { onError: (err: unknown) => void; onSuccess: () => void; uploadUrl: string | null },
    ) {
      this.url = options.uploadUrl;
    }
    async findPreviousUploads() {
      return [];
    }
    start() {
      tus.starts++;
      if (tus.starts === 1) {
        this.url = "/api/uploads/tus/u1";
        this.options.onError({
          originalRequest: { getMethod: () => "PATCH" },
          originalResponse: { getStatus: () => 429, getHeader: () => "30", getBody: () => "" },
        });
      } else this.options.onSuccess();
    }
    async abort() {}
  },
}));

describe("retryAfterMs", () => {
  it("reads seconds or a date, capped at a minute and at least a second", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("0")).toBe(1000);
    expect(retryAfterMs("600")).toBe(MAX_WAIT_MS);
    expect(retryAfterMs(new Date(1_000_000 + 20_000).toUTCString(), 1_000_000)).toBe(20_000);
  });

  it("waits a few seconds without a readable header", () => {
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs("soon")).toBe(5000);
  });
});

describe("waiting out a 429", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tus.starts = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resends an upload check only once the Retry-After window has passed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": "30" } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = api.post("/uploads/inspect", new FormData());
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a 429 outside /uploads, such as sign-in", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Too many attempts" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.post("/auth/login", { email: "a@example.com", password: "x" })).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes a tus upload after the Retry-After window instead of failing it", async () => {
    const result = uploadFile(new File(["x"], "a.jpg"));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(tus.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("u1");
    expect(tus.starts).toBe(2);
  });
});
