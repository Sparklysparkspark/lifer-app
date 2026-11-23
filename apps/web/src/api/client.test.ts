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

describe("error text", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: object) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("never shows an uncoded 500's text, which can be raw server detail", async () => {
    reply(500, { error: "deadlock detected ENOENT /srv/x" });
    await expect(api.get("/gallery")).rejects.toMatchObject({
      status: 500,
      message: "Something went wrong. Please try again.",
    });
  });

  it("keeps the server's words for a coded 500 and for other statuses", async () => {
    reply(500, { error: "Couldn't move this library", code: "storage_move_failed" });
    await expect(api.get("/x")).rejects.toMatchObject({ message: "Couldn't move this library" });
    reply(409, { error: "Wait for the scan to finish" });
    await expect(api.get("/x")).rejects.toMatchObject({ message: "Wait for the scan to finish" });
  });
});
