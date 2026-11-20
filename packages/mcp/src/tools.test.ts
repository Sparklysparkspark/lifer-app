import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createClient } from "./client.js";
import { createServer, smartRules } from "./tools.js";

// A fake Lifer: records each call and answers from a table.
function fakeLifer(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    calls.push({
      method: init.method!,
      url: `${url.pathname}${url.search}`,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${init.method} ${url.pathname}`;
    if (!(key in answers)) return new Response(JSON.stringify({ error: "Nope" }), { status: 404 });
    return new Response(JSON.stringify(answers[key]), { status: 200 });
  }) as typeof fetch;
  return { calls, client: createClient("http://lifer.test", "key", fetchImpl) };
}

async function connect(answers: Record<string, unknown>) {
  const fake = fakeLifer(answers);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(fake.client).connect(a);
  const assistant = new Client({ name: "test", version: "1" });
  await assistant.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await assistant.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return {
      isError: !!res.isError,
      data: JSON.parse(
        res.content[0].text.startsWith("{") || res.content[0].text.startsWith("[") ? res.content[0].text : "null",
      ),
      text: res.content[0].text,
    };
  };
  return { ...fake, call, assistant };
}

describe("Lifer MCP tools", () => {
  it("lists tools, every one with a description", async () => {
    const { assistant } = await connect({});
    const { tools } = await assistant.listTools();
    expect(tools.map((t) => t.name)).toContain("add_photos_to_album");
    expect(tools.filter((t) => !t.description)).toEqual([]);
  });

  it("searches with repeated list filters and trims the answer", async () => {
    const { call, calls } = await connect({
      "GET /api/gallery": {
        items: [
          {
            captureId: "c1",
            commonName: "Heron",
            scientificName: "Ardea",
            takenAt: null,
            regionName: "BC",
            qualityRating: 4,
            tags: [],
            width: 1,
          },
        ],
        total: 1,
      },
    });
    const res = await call("search_photos", { regionIds: ["a", "b"], ratingMin: "3" });
    expect(calls[0].url).toContain("regionId=a&regionId=b");
    expect(calls[0].url).toContain("ratingMin=3");
    expect(res.data.photos).toEqual([
      { captureId: "c1", species: "Heron", scientificName: "Ardea", takenAt: null, place: "BC", rating: 4, tags: [] },
    ]);
  });

  it("adds photos, records only the newly added ones as one undo step, and undoes it", async () => {
    const { call, calls } = await connect({
      "GET /api/gallery/ids": { captureIds: ["old"] },
      "POST /api/albums/al1/captures": { ok: true },
      "POST /api/changes": { id: "b1" },
      "POST /api/changes/undo-last": { undone: { id: "b1", summary: "Added 2 photos to an album" } },
    });
    const added = await call("add_photos_to_album", { albumId: "al1", captureIds: ["old", "n1", "n2"] });
    expect(added.data).toEqual({ requested: 3, newlyAdded: 2 });
    const record = calls.find((c) => c.url === "/api/changes")!;
    expect(record.body).toMatchObject({ undo: [{ op: "removeFromAlbum", albumId: "al1", captureIds: ["n1", "n2"] }] });
    expect((await call("undo_last_change")).data).toEqual({ undone: "Added 2 photos to an album" });
  });

  it("refuses more photos than one call may add", async () => {
    const { call } = await connect({});
    const res = await call("add_photos_to_album", {
      albumId: "al1",
      captureIds: Array.from({ length: 201 }, (_, i) => `c${i}`),
    });
    expect(res.isError).toBe(true);
  });

  it("returns an API problem as a tool error", async () => {
    const { call } = await connect({});
    const res = await call("list_albums");
    expect(res).toMatchObject({ isError: true, text: "Nope" });
  });

  it("turns filters into smart album rules", () => {
    expect(smartRules({ regionIds: ["a", "b"], ratingMin: "3", query: "flight" })).toEqual({
      version: 2,
      query: { regionId: ["a", "b"], ratingMin: "3", q: "flight" },
    });
  });
});
