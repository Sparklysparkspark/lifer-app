import { describe, expect, it } from "vitest";
import { groupImportRows, groupPlace, rowTime, type PlaceableRow, type StagedPlace } from "./importGroups";

// `time` is the camera's own clock, as /uploads/inspect returns it (no zone).
const row = (key: string, time: string, regionId?: string, extra: Partial<PlaceableRow> = {}): PlaceableRow => ({
  key,
  file: { lastModified: 0 },
  cameraTime: time,
  gps: regionId ? { lat: 1, lon: 2, regionId } : null,
  ...extra,
});
const keys = (groups: PlaceableRow[][]) => groups.map((g) => g.map((r) => r.key));
const clock = (ms: number) => new Date(ms).toISOString().slice(0, 19);

describe("groupImportRows", () => {
  it("splits after an hour's gap and sorts by time", () => {
    const groups = groupImportRows([
      row("c", "2026-09-14T09:30:00"),
      row("a", "2026-09-14T07:10:00"),
      row("b", "2026-09-14T08:02:00"),
    ]);
    expect(keys(groups)).toEqual([["a", "b"], ["c"]]);
  });

  it("splits at a new day on the camera's clock even within the hour", () => {
    expect(keys(groupImportRows([row("a", "2026-09-14T23:50:00"), row("b", "2026-09-15T00:10:00")]))).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("splits where the GPS moves region, but photos without GPS don't break a group", () => {
    const groups = groupImportRows([
      row("a", "2026-09-14T07:00:00", "bc"),
      row("b", "2026-09-14T07:05:00"),
      row("c", "2026-09-14T07:10:00", "bc"),
      row("d", "2026-09-14T07:15:00", "ab"),
    ]);
    expect(keys(groups)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("keeps one camera's GPS and non-GPS photos of one outing together", () => {
    // Near Vancouver at 07:00 on the camera: the zoned instant is 14:00 UTC, which must not matter.
    const groups = groupImportRows([
      row("gps1", "2018-06-01T07:00:00", "bc"),
      row("plain", "2018-06-01T07:20:00"),
      row("gps2", "2018-06-01T07:40:00", "bc"),
      row("afternoon", "2018-06-01T14:00:00"),
    ]);
    expect(keys(groups)).toEqual([["gps1", "plain", "gps2"], ["afternoon"]]);
  });

  it("is not shifted by daylight saving changes on this computer", () => {
    // 02:30 doesn't exist on 8 March 2026 in North America and 01:30 happens twice on 1 November;
    // read as UTC wall clock, both stay 40 minutes from their neighbours.
    expect(keys(groupImportRows([row("a", "2026-03-08T01:50:00"), row("b", "2026-03-08T02:30:00")]))).toEqual([
      ["a", "b"],
    ]);
    expect(keys(groupImportRows([row("a", "2026-11-01T01:10:00"), row("b", "2026-11-01T01:50:00")]))).toEqual([
      ["a", "b"],
    ]);
    expect(rowTime(row("a", "2026-03-08T02:30:00"))).toBe(Date.UTC(2026, 2, 8, 2, 30));
  });

  it("falls back to the file date on this computer's clock before the camera time is known", () => {
    const a = new Date(2026, 8, 14, 7, 0).getTime();
    const groups = groupImportRows([
      { key: "a", file: { lastModified: a } },
      { key: "b", file: { lastModified: a + 20 * 60_000 } },
    ]);
    expect(keys(groups)).toEqual([["a", "b"]]);
    // The local 07:00 reads as 07:00 on the wall clock, like a camera set to this computer's zone.
    expect(clock(rowTime({ key: "a", file: { lastModified: a } }))).toBe("2026-09-14T07:00:00");
  });

  it("holds up with 2,000 photos in 60 outings, GPS and not mixed", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => {
      const outing = Math.floor(i / 34);
      const t = Date.UTC(2026, 0, 1) + outing * 3 * 3600_000 + (i % 34) * 60_000;
      return row(`r${i}`, clock(t), i % 2 ? `region${outing % 2}` : undefined);
    });
    const groups = groupImportRows(rows);
    // Outings 3 h apart: eight a day, so midnight never falls inside one. Exact on any machine zone.
    expect(groups).toHaveLength(Math.ceil(2000 / 34));
    expect(groups.flat()).toHaveLength(2000);
    expect(groups[0][0].key).toBe("r0");
  });
});

describe("groupPlace", () => {
  const pond: StagedPlace = { source: "spot", name: "Pond", spotId: "s1", regionId: null, point: null };
  it("is the place most photos share, so the others read as overrides", () => {
    const g = [row("a", "2026-09-14T07:00:00"), row("b", "2026-09-14T07:01:00"), row("c", "2026-09-14T07:02:00")];
    expect(groupPlace(g)).toBeNull();
    g[0].place = { ...pond };
    g[1].place = { ...pond };
    expect(groupPlace(g)).toEqual(pond);
  });
});
