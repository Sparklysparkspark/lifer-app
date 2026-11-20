import { describe, expect, it } from "vitest";
import { migratedDb } from "../store/testDb";
import {
  applyVectorPage,
  fromBase64,
  loadVectorState,
  syncVectors,
  vectorCount,
  VectorIndex,
  type VectorPage,
} from "./vectorStore";
import { encodeVector, unit } from "./vectorTestUtil";

const page = (over: Partial<VectorPage> = {}): VectorPage => ({
  imageModelVersion: "m1",
  dimension: 768,
  items: [],
  removed: [],
  last: null,
  next: null,
  ...over,
});
const item = (id: string, w: number[]) => ({ id, updatedAt: "2026-10-01T00:00:00Z", vector: encodeVector(unit(w)) });
const cur = (n: number) => ({ since: `2026-10-01T00:00:0${n}Z`, after: `00000000-0000-0000-0000-00000000000${n}` });

describe("vector store", () => {
  it("decodes base64 like Buffer does", () => {
    for (const s of ["", "a", "ab", "abc", "hello world!"])
      expect([...fromBase64(Buffer.from(s).toString("base64"))]).toEqual([...Buffer.from(s)]);
  });

  it("stores a page, replaces a changed vector and drops a removed one", async () => {
    const db = await migratedDb();
    await applyVectorPage(db, page({ items: [item("a", [1, 0]), item("b", [0, 1])] }));
    await applyVectorPage(db, page({ items: [item("a", [0, 1])], removed: [{ id: "b", at: "x" }] }));
    expect(await vectorCount(db)).toBe(1);
    const index = await VectorIndex.load(db);
    expect(index.get("a")![1]).toBeCloseTo(1, 3);
    expect(index.get("b")).toBeUndefined();
  });

  it("pulls every page, moves the cursor only with a stored page, and is complete at the end", async () => {
    const db = await migratedDb();
    const pages = [
      page({ items: [item("a", [1])], last: cur(1), next: cur(1) }),
      page({ items: [item("b", [1])], removed: [{ id: "a", at: "x" }], last: cur(2), next: null }),
    ];
    const calls: string[] = [];
    const api = { get: async <T>(path: string) => (calls.push(path), pages[calls.length - 1] as T) };
    const r = await syncVectors({ db, api, allowed: async () => true });
    expect(r.complete).toBe(true);
    expect(calls[0]).toBe("/companion/v1/model/vectors?limit=200");
    expect(calls[1]).toContain("since=2026-10-01T00%3A00%3A01Z");
    expect(await vectorCount(db)).toBe(1);
    expect(await loadVectorState(db)).toMatchObject({ imageModelVersion: "m1", complete: true, cursor: cur(2) });
  });

  it("stops between pages when downloads are not allowed, and resumes from the stored cursor", async () => {
    const db = await migratedDb();
    let ok = true;
    const api = {
      get: async <T>() => ((ok = false), page({ items: [item("a", [1])], last: cur(1), next: cur(1) }) as T),
    };
    const r = await syncVectors({ db, api, allowed: async () => ok });
    expect(r.complete).toBe(false);
    expect((await loadVectorState(db))?.cursor).toEqual(cur(1));
    const seen: string[] = [];
    await syncVectors({
      db,
      api: { get: async <T>(p: string) => (seen.push(p), page({ last: cur(2) }) as T) },
      allowed: async () => true,
    });
    expect(seen[0]).toContain("since=2026-10-01T00%3A00%3A01Z");
  });

  it("clears everything and starts again when the hub's image model changes", async () => {
    const db = await migratedDb();
    await syncVectors({
      db,
      api: { get: async <T>() => page({ items: [item("old", [1])], last: cur(1) }) as T },
      allowed: async () => true,
    });
    const seen: string[] = [];
    const api = {
      get: async <T>(p: string) => (
        seen.push(p),
        page({ imageModelVersion: "m2", items: [item("new", [1])], last: cur(3) }) as T
      ),
    };
    await syncVectors({ db, api, allowed: async () => true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe("/companion/v1/model/vectors?limit=200");
    expect((await VectorIndex.load(db)).get("old")).toBeUndefined();
    expect(await vectorCount(db)).toBe(1);
    expect((await loadVectorState(db))?.imageModelVersion).toBe("m2");
  });
});
