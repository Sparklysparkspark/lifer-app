import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: {} }));

const { fetchWithHardTimeout, inatPlaceQueryNames } = await import("./inatChecklist.js");

describe("inatPlaceQueryNames", () => {
  it("tries a known alias first, then the name with abbreviations spelled out, then the name as is", () => {
    expect(inatPlaceQueryNames("U.S. Virgin Is.")).toEqual([
      "US Virgin Islands",
      "United States Virgin Islands",
      "U.S. Virgin Is.",
    ]);
  });

  it("spells out U.S. before the single-letter abbreviations", () => {
    expect(inatPlaceQueryNames("Bosnia and Herz.")).toEqual(["Bosnia and Herzegovina", "Bosnia and Herz."]);
    expect(inatPlaceQueryNames("U.S. Pacific")[0]).toBe("United States Pacific");
  });

  it("asks once for a name with nothing to expand", () => {
    expect(inatPlaceQueryNames("Kenya")).toEqual(["Kenya"]);
  });
});

describe("fetchWithHardTimeout", () => {
  let server: Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = null;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it("returns the response when the server answers in time", async () => {
    const url = await serve((_req, res) => res.end("ok"));
    const res = await fetchWithHardTimeout(url, { headers: { "x-test": "1" } }, 2000);
    expect(await res.text()).toBe("ok");
  });

  it("gives up on a server that never answers, and drops the connection", async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
    const url = await serve((req) => req.socket.on("close", () => closed()));
    await expect(fetchWithHardTimeout(url, {}, 50)).rejects.toThrow(`fetch timed out after 50ms: ${url}`);
    await expect(connectionClosed).resolves.toBeUndefined();
  });

  it("cancels its timer once the response arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const url = await serve((_req, res) => res.end("ok"));
      await fetchWithHardTimeout(url, {}, 60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
