import { describe, expect, it } from "vitest";
import { migratedDb } from "../store/testDb";
import { applyCaptureChanges } from "../store/library";
import { capture } from "../testing/seed";
import { applyFramePage, clearFrames, loadFrameState, syncFrames, type FramePage } from "./frameStore";
import { localRows } from "./localSearch";
import { vectorCount, VectorIndex } from "./vectorStore";
import { encodeVector, unit } from "./vectorTestUtil";

const light = { luma: 0.5, warmth: 0, highlights: 0, shadows: 0, saturation: 0.3 };
const page = (over: Partial<FramePage> = {}): FramePage => ({
  imageModelVersion: "m1",
  items: [],
  removed: [],
  last: null,
  next: null,
  ...over,
});
const frame = (id: string, bg: number[] | null = null, over: Partial<FramePage["items"][number]> = {}) => ({
  id,
  updatedAt: "2026-10-01T00:00:00Z",
  box: [0.1, 0.1, 0.3, 0.3],
  boxUnsure: false,
  aspect: 1.5,
  light,
  takenAtZoned: true,
  background: bg ? encodeVector(unit(bg)) : null,
  ...over,
});
const cur = (n: number) => ({ since: `2026-10-01T00:00:0${n}Z`, after: `00000000-0000-0000-0000-00000000000${n}` });

describe("frame store", () => {
  it("stores frames and backgrounds, replaces a changed one, drops a lost background and removed captures", async () => {
    const db = await migratedDb();
    await applyFramePage(db, page({ items: [frame("a", [1, 0]), frame("b", [0, 1]), frame("c")] }));
    expect(await vectorCount(db, "capture_backgrounds")).toBe(2);
    await applyFramePage(db, page({ items: [frame("a", null, { aspect: 0.7 })], removed: [{ id: "c", at: "x" }] }));
    expect(await vectorCount(db, "capture_backgrounds")).toBe(1);
    expect((await VectorIndex.load(db, "capture_backgrounds")).get("b")![1]).toBeCloseTo(1, 3);
    expect(await db.get("SELECT aspect FROM capture_frames WHERE capture_id = 'a'")).toEqual({ aspect: 0.7 });
    expect(await db.get("SELECT 1 AS n FROM capture_frames WHERE capture_id = 'c'")).toBeFalsy();
  });

  it("skips a background of the wrong size", async () => {
    const db = await migratedDb();
    await applyFramePage(db, page({ items: [frame("a", null, { background: "AAAA" })] }));
    expect(await vectorCount(db, "capture_backgrounds")).toBe(0);
  });

  it("lands on the search rows, and leaves a photo with no frame null", async () => {
    const db = await migratedDb();
    await applyCaptureChanges(db, [capture("a", "Cygnus olor"), capture("b", "Cygnus olor")], []);
    await applyFramePage(db, page({ items: [frame("a", null, { boxUnsure: true, takenAtZoned: false })] }));
    const [a, b] = (await localRows(db)).sort((x, y) => x.capture_id.localeCompare(y.capture_id));
    expect(a).toMatchObject({
      frame_box: [0.1, 0.1, 0.3, 0.3],
      frame_unsure: true,
      frame_aspect: 1.5,
      taken_at_zoned: false,
      light_stats: light,
    });
    expect(b).toMatchObject({
      frame_box: null,
      frame_unsure: null,
      frame_aspect: null,
      taken_at_zoned: null,
      light_stats: null,
    });
  });

  it("purging a capture takes its frame and background with it", async () => {
    const db = await migratedDb();
    await applyCaptureChanges(db, [capture("a", "Cygnus olor")], []);
    await applyFramePage(db, page({ items: [frame("a", [1])] }));
    await applyCaptureChanges(db, [], ["a"]);
    expect(await vectorCount(db, "capture_backgrounds")).toBe(0);
    expect(await db.get("SELECT 1 AS n FROM capture_frames")).toBeFalsy();
  });

  it("pulls every page with backgrounds asked for, resumes from the cursor, and restarts on a new image model", async () => {
    const db = await migratedDb();
    const calls: string[] = [];
    const pages = [
      page({ items: [frame("a", [1])], last: cur(1), next: cur(1) }),
      page({ items: [frame("b")], last: cur(2) }),
    ];
    const api = { get: async <T>(p: string) => (calls.push(p), pages[calls.length - 1] as T) };
    expect(await syncFrames({ db, api, allowed: async () => true })).toMatchObject({ complete: true });
    expect(calls[0]).toBe("/companion/v1/model/frames?limit=200&background=1");
    expect(calls[1]).toContain("since=2026-10-01T00%3A00%3A01Z");
    expect(await loadFrameState(db)).toMatchObject({ complete: true, cursor: cur(2) });

    const seen: string[] = [];
    await syncFrames({
      db,
      api: {
        get: async <T>(p: string) => (
          seen.push(p),
          page({ imageModelVersion: "m2", items: [frame("new")], last: cur(3) }) as T
        ),
      },
      allowed: async () => true,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe("/companion/v1/model/frames?limit=200&background=1");
    expect(
      (await db.all("SELECT capture_id FROM capture_frames")).map((r) => (r as { capture_id: string }).capture_id),
    ).toEqual(["new"]);
  });

  it("stops between pages when downloads are not allowed", async () => {
    const db = await migratedDb();
    let ok = true;
    const api = { get: async <T>() => ((ok = false), page({ items: [frame("a")], last: cur(1), next: cur(1) }) as T) };
    expect(await syncFrames({ db, api, allowed: async () => ok })).toMatchObject({ complete: false });
    expect((await loadFrameState(db))?.cursor).toEqual(cur(1));
    await clearFrames(db);
    expect(await loadFrameState(db)).toBeNull();
  });
});
