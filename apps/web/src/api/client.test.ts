import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setUnauthorizedHandler } from "./client";

function answer(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "Not authenticated" }), { status })),
  );
}

describe("unauthorized handler", () => {
  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("fires on a 401 from a signed-in route", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    answer(401);
    await expect(api.get("/collection")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("ignores 401s from auth and share routes, and other errors", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    answer(401);
    await expect(api.get("/auth/me")).rejects.toMatchObject({ status: 401 });
    await expect(api.post("/auth/password", {})).rejects.toMatchObject({ status: 401 });
    await expect(api.get("/share/abc")).rejects.toMatchObject({ status: 401 });
    answer(500);
    await expect(api.get("/collection")).rejects.toMatchObject({ status: 500 });
    expect(handler).not.toHaveBeenCalled();
  });
});
