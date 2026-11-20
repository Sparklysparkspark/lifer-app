// What a found link wrote, and what Unlink may set back.
import { describe, expect, it } from "vitest";
import { recordWrites, revertFor, type CaptureValues } from "./unlink.js";
import { decide } from "./matching.js";

const bare: CaptureValues = {
  lat: null,
  lon: null,
  location_source: null,
  location_accuracy_m: null,
  region_id: null,
  taken_at: "2026-09-11 04:40:17+00",
  life_stage: null,
  sex: null,
};
const placed: CaptureValues = {
  ...bare,
  lat: "54.0017",
  lon: "-122.6977",
  location_source: "inaturalist",
  location_accuracy_m: "31",
  region_id: "r-bc",
};

describe("recordWrites", () => {
  it("records each field the write-back filled, with its value before", () => {
    const w = recordWrites(bare, placed, null)!;
    expect(w.sidecar).toBe(true);
    expect(w.fields).toEqual({
      lat: { from: null, to: "54.0017" },
      lon: { from: null, to: "-122.6977" },
      location_source: { from: null, to: "inaturalist" },
      location_accuracy_m: { from: null, to: "31" },
      region_id: { from: null, to: "r-bc" },
    });
  });

  it("writes nothing when nothing changed, and keeps the first 'before' across later write-backs", () => {
    expect(recordWrites(bare, bare, null)).toBeNull();
    const first = recordWrites(bare, { ...bare, region_id: "r-bc" }, null);
    const later = recordWrites({ ...bare, region_id: "r-bc" }, { ...placed }, first)!;
    expect(later.fields.region_id).toEqual({ from: null, to: "r-bc" });
    expect(later.fields.lat).toEqual({ from: null, to: "54.0017" });
  });
});

describe("revertFor", () => {
  const writes = recordWrites(bare, placed, null);

  it("sets back everything the link wrote when the photo still holds it", () => {
    const r = revertFor(writes, placed);
    expect(r.set).toEqual({ lat: null, lon: null, location_source: null, location_accuracy_m: null, region_id: null });
    expect(r).toMatchObject({ kept: [], gps: true, place: true });
  });

  it("never undoes a later edit: a moved pin stays whole, the untouched region still goes back", () => {
    const r = revertFor(writes, { ...placed, lat: "54.1", location_source: null });
    expect(r.set).toEqual({ region_id: null });
    expect(r.kept.sort()).toEqual(["lat", "location_accuracy_m", "location_source", "lon"]);
    expect(r).toMatchObject({ gps: false, place: true });
  });

  it("keeps a region the user changed since", () => {
    expect(revertFor(writes, { ...placed, region_id: "r-yukon" }).set).not.toHaveProperty("region_id");
  });

  it("restores a date the link added", () => {
    const dated = recordWrites({ ...bare, taken_at: null }, bare, null);
    expect(revertFor(dated, bare).set).toEqual({ taken_at: null });
  });

  it("takes back a life stage and sex the link filled in, unless edited since", () => {
    const annotated = { ...bare, life_stage: "juvenile", sex: "female" };
    const filled = recordWrites(bare, annotated, null);
    expect(revertFor(filled, annotated).set).toEqual({ life_stage: null, sex: null });
    expect(revertFor(filled, { ...annotated, sex: "male" }).set).toEqual({ life_stage: null });
  });

  it("has nothing to restore when the link wrote nothing", () => {
    expect(revertFor(null, placed)).toEqual({ set: {}, kept: [], gps: false, place: false });
  });
});

describe("an unlinked pair", () => {
  it("is offered for review but never linked by itself again", () => {
    const ev = { taxon: "same" as const, time: "close" as const, size: "same" as const, place: null };
    const r = decide("1", [{ captureId: "a", evidence: ev, similarity: 0.99, perPhoto: [0.99], noAuto: true }], 1);
    expect(r.links).toEqual([]);
    expect(r.review.map((m) => m.captureId)).toEqual(["a"]);
  });
});
