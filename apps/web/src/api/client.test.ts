import { afterEach, describe, expect, it, vi } from "vitest";
import { answerSize, forgetTaggedAnswers } from "./answers";
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

  it("says a gateway or timeout status in plain words, never its HTTP text", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    for (const status of [502, 503, 504]) {
      reply(status, { error: "Bad Gateway" });
      await expect(api.get("/gallery")).rejects.toMatchObject({
        status,
        message: "Couldn't reach Lifer. Check your connection and try again.",
      });
    }
    // A proxy's own page: no JSON, so only the status text was there to show.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>413</html>", { status: 413, statusText: "Payload Too Large" })),
    );
    await expect(api.post("/uploads", new FormData())).rejects.toMatchObject({
      status: 413,
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

describe("ETag reuse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks again with If-None-Match and hands back the same object on a 304, without parsing", async () => {
    const fetchMock = vi.fn(
      async (..._args: [string, RequestInit]) =>
        new Response(JSON.stringify({ tree: [1] }), { status: 200, headers: { ETag: 'W/"c-1"' } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await api.get<{ tree: number[] }>("/collection/tree?regionId=r1");
    expect(answerSize(first)).toBe(JSON.stringify({ tree: [1] }).length);

    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 304 }));
    const again = await api.get("/collection/tree?regionId=r1");
    expect(again).toBe(first);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("If-None-Match")).toBe('W/"c-1"');

    // Another path never sends the tag; after an account change nothing does.
    await api.get("/collection/tree?regionId=r2");
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get("If-None-Match")).toBeNull();
    forgetTaggedAnswers();
    await api.get("/collection/tree?regionId=r1");
    expect(new Headers(fetchMock.mock.calls[3][1].headers).get("If-None-Match")).toBeNull();
  });
});
