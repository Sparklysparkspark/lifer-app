import { describe, expect, it } from "vitest";
import { parseCsv, parseMyEbirdData } from "./csv.js";
import { matchPhotos, type MatchChecklist, type MatchPhoto } from "./match.js";

const HEADER =
  "Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location,Latitude,Longitude,Date,Time,Protocol,Duration (Min),All Obs Reported";
const row = (sub: string, sci: string, date: string, time: string, extra = "") =>
  `${sub},Name,${sci},1,1,BC,Metro,L1,"Pond, North",49.1,-123.1,${date},${time},Traveling,${extra || "90"},1`;

describe("parseCsv", () => {
  it("keeps commas, quotes and line breaks inside quoted fields and drops a BOM", () => {
    expect(parseCsv('﻿a,"b, ""c""",d\r\n"x\ny",,z\n')).toEqual([
      ["a", 'b, "c"', "d"],
      ["x\ny", "", "z"],
    ]);
  });
});

describe("parseMyEbirdData", () => {
  it("groups rows into checklists with species, time, place and duration", () => {
    const text = [
      HEADER,
      row("S1", "Ardea herodias", "2024-05-01", "07:30 AM"),
      row("S1", "Anas platyrhynchos", "2024-05-01", "07:30 AM"),
      row("S1", "Anas sp.", "2024-05-01", "07:30 AM"),
      row("S2", "Ardea herodias", "05/02/2024", "6:05 PM", "20"),
    ].join("\n");
    const { checklists, skipped } = parseMyEbirdData(text);
    expect(skipped).toEqual([]);
    expect(checklists).toHaveLength(2);
    expect(checklists[0]).toMatchObject({
      subId: "S1",
      startedAt: "2024-05-01T07:30:00Z",
      hasTime: true,
      durationMin: 90,
      lat: 49.1,
      location: "Pond, North",
      species: ["Anas platyrhynchos", "Ardea herodias"],
    });
    expect(checklists[1]).toMatchObject({ startedAt: "2024-05-02T18:05:00Z", durationMin: 20 });
  });

  it("treats a missing time as the whole day and reports unusable rows", () => {
    const { checklists, skipped } = parseMyEbirdData(
      [
        HEADER,
        row("S3", "Ardea herodias", "2024-05-01", ""),
        row("", "x", "2024-05-01", ""),
        row("S4", "y", "not a date", ""),
      ].join("\n"),
    );
    expect(checklists).toHaveLength(1);
    expect(checklists[0]).toMatchObject({ hasTime: false, startedAt: "2024-05-01T00:00:00Z" });
    expect(skipped).toEqual(["Row 3 has no submission ID", "Row 4 has no usable date"]);
  });

  it("says plainly when the file is not the eBird export", () => {
    expect(() => parseMyEbirdData("a,b\n1,2")).toThrow(/no "Submission ID", "Scientific Name", "Date" column/);
  });
});

const at = (iso: string) => Date.parse(`${iso}Z`);
const list = (over: Partial<MatchChecklist> = {}): MatchChecklist => ({
  subId: "S1",
  startedAtMs: at("2024-05-01T07:30:00"),
  hasTime: true,
  durationMin: 60,
  lat: 49.1,
  lon: -123.1,
  species: ["Ardea herodias"],
  ...over,
});
const shot = (iso: string, over: Partial<MatchPhoto> = {}): MatchPhoto => ({
  id: "p1",
  takenAtMs: at(iso),
  lat: 49.1,
  lon: -123.1,
  species: "Ardea herodias",
  ...over,
});

describe("matchPhotos", () => {
  it("matches during the count and a few minutes either side, not after", () => {
    expect(matchPhotos([shot("2024-05-01T08:00:00")], [list()])).toHaveLength(1);
    expect(matchPhotos([shot("2024-05-01T07:20:00")], [list()])).toHaveLength(1);
    expect(matchPhotos([shot("2024-05-01T08:50:00")], [list()])).toHaveLength(0);
  });

  it("uses the camera offset for a camera left on another time zone", () => {
    // Camera on home time, three hours behind the place where the count was made.
    const photo = shot("2024-05-01T05:00:00");
    expect(matchPhotos([photo], [list()])).toHaveLength(0);
    expect(matchPhotos([photo], [list()], 180)).toHaveLength(1);
  });

  it("rejects a far place, ignores place when a photo has none, and takes any time on a date-only count", () => {
    expect(matchPhotos([shot("2024-05-01T08:00:00", { lat: 50.5 })], [list()])).toHaveLength(0);
    expect(matchPhotos([shot("2024-05-01T08:00:00", { lat: null, lon: null })], [list()])).toHaveLength(1);
    expect(
      matchPhotos([shot("2024-05-01T21:00:00")], [list({ hasTime: false, startedAtMs: at("2024-05-01T00:00:00") })]),
    ).toHaveLength(1);
  });

  it("prefers the checklist that lists the photo's species", () => {
    const near = list({ subId: "near", species: [], startedAtMs: at("2024-05-01T08:00:00") });
    const far = list({ subId: "far", species: ["Ardea herodias"], startedAtMs: at("2024-05-01T07:40:00") });
    const [m] = matchPhotos([shot("2024-05-01T08:00:00")], [near, far]);
    expect(m).toMatchObject({ subId: "far", onList: true });
  });
});
