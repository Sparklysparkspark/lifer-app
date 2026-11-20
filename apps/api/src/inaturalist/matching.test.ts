// The rules that pair the user's own iNaturalist observations with library photos.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MARGIN,
  SAME,
  candidatePairs,
  compareSize,
  compareTaxon,
  compareTime,
  decide,
  evidenceFor,
  likeness,
  parseObservation,
  previewUrl,
  settle,
  type Candidate,
  type Evidence,
  type LocalCapture,
  type RemoteObservation,
} from "./matching.js";

// Trimmed from the real v1 response for the maintainer's hand-made osprey observation.
const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/osprey-observation.json", import.meta.url), "utf8"));
const osprey = parseObservation(fixture.results[0])!;

// The photo it came from: Canon R5 II, no zone in the file, so the wall clock is stored as UTC.
const capture: LocalCapture = {
  id: "c-osprey",
  taxonId: 116999,
  takenAt: "2026-09-11T04:40:17.000Z",
  zoned: false,
  lat: null,
  lon: null,
  width: 2560,
  height: 1708,
};

describe("parseObservation", () => {
  it("reads the real response: taxon, wall clock, the point from `location`, photo sizes and place text", () => {
    expect(osprey).toMatchObject({
      id: "412876366",
      taxonId: 116999,
      belowSpecies: false,
      instant: "2026-09-11T11:40:00.000Z",
      wallClock: "2026-09-11T04:40:00",
      observedOn: "2026-09-11",
      point: { lat: 54.001725703, lon: -122.6977703871 },
      accuracyM: 31,
      geoprivacy: null,
      placeGuess: "Prince George, BC, Canada",
      photos: [{ id: "759791188", width: 2048, height: 1366 }],
    });
    expect(osprey.ancestorIds).toContain(116999);
  });

  it("works out the wall clock from the zone offset when the time comes back in UTC", () => {
    const o = parseObservation({ id: 1, time_observed_at: "2026-09-11T11:40:00Z", time_zone_offset: "-07:00" });
    expect(o?.wallClock).toBe("2026-09-11T04:40:00");
  });

  it("keeps a date-only observation's day, and rejects things that aren't observations", () => {
    expect(parseObservation({ id: 2, observed_on: "2026-05-01", time_observed_at: null })).toMatchObject({
      instant: null,
      wallClock: null,
      observedOn: "2026-05-01",
    });
    expect(parseObservation({ nope: true })).toBeNull();
    expect(parseObservation(null)).toBeNull();
  });
});

describe("previewUrl", () => {
  it("asks for a small size, never the original, and only from iNaturalist", () => {
    expect(previewUrl(osprey.photos[0].url)).toBe(
      "https://inaturalist-open-data.s3.amazonaws.com/photos/759791188/large.jpg",
    );
    expect(previewUrl("https://static.inaturalist.org/photos/1/square.jpeg?123", "medium")).toBe(
      "https://static.inaturalist.org/photos/1/medium.jpeg?123",
    );
    expect(previewUrl("https://evil.example/photos/1/square.jpg")).toBeNull();
    expect(previewUrl("http://static.inaturalist.org/photos/1/square.jpg")).toBeNull();
  });
});

describe("the osprey", () => {
  it("passes the cheap filter: same species, 17 s apart on the wall clock, same shape", () => {
    expect(evidenceFor(capture, osprey)).toEqual({ taxon: "same", time: "close", size: "same", place: null });
  });

  it("links on its measured picture score (0.958), with no other osprey that day", () => {
    const { links } = decide(
      osprey.id,
      [{ captureId: capture.id, evidence: evidenceFor(capture, osprey)!, similarity: 0.958, perPhoto: [0.958] }],
      1,
    );
    expect(links.map((l) => l.captureId)).toEqual(["c-osprey"]);
  });
});

describe("compareTime", () => {
  const obs = (over: Partial<RemoteObservation> = {}): RemoteObservation => ({ ...osprey, ...over });

  it("reads a zoned capture as a true instant", () => {
    expect(compareTime({ ...capture, zoned: true, takenAt: "2026-09-11T11:40:30Z" }, obs())?.kind).toBe("close");
    // The same digits as a true instant are 7 hours off: only the same day, not close.
    expect(compareTime({ ...capture, zoned: true }, obs())?.kind).toBe("sameDay");
  });

  it("accepts either reading for older imports that didn't record a zone", () => {
    expect(compareTime({ ...capture, zoned: null }, obs())?.kind).toBe("close");
    expect(compareTime({ ...capture, zoned: null, takenAt: "2026-09-11T11:40:10Z" }, obs())?.kind).toBe("close");
  });

  it("allows a wrong zone on either side within a day, and nothing beyond", () => {
    expect(compareTime({ ...capture, takenAt: "2026-09-11T14:00:00Z" }, obs())?.kind).toBe("sameDay");
    expect(compareTime({ ...capture, takenAt: "2026-09-13T04:40:00Z" }, obs())).toBeNull();
  });

  it("matches a date-only observation (an edited upload without EXIF) on that day or the next", () => {
    const dateOnly = obs({ instant: null, wallClock: null, observedOn: "2026-09-11" });
    expect(compareTime(capture, dateOnly)?.kind).toBe("sameDay");
    expect(compareTime({ ...capture, takenAt: "2026-09-12T23:00:00Z" }, dateOnly)?.kind).toBe("sameDay");
    expect(compareTime({ ...capture, takenAt: "2026-09-14T01:00:00Z" }, dateOnly)).toBeNull();
    expect(compareTime(capture, obs({ instant: null, wallClock: null, observedOn: null }))).toBeNull();
  });
});

describe("compareTaxon", () => {
  it("takes a subspecies observation as the photo's species, a broader one only as related", () => {
    expect(compareTaxon(116999, osprey)).toBe("same");
    const sub = { ...osprey, taxonId: 999, belowSpecies: true, ancestorIds: [...osprey.ancestorIds, 999] };
    expect(compareTaxon(116999, sub)).toBe("finer");
    // A photo filed under the genus, the observation at species: not proof.
    expect(compareTaxon(71725, osprey)).toBe("related");
    const genusObs = { ...osprey, taxonId: 71725, ancestorIds: [1, 71725], identTaxonIds: [1, 71725, 116999] };
    expect(compareTaxon(116999, genusObs)).toBe("related");
    expect(compareTaxon(4956, osprey)).toBeNull();
    expect(compareTaxon(null, osprey)).toBeNull();
  });
});

describe("compareSize", () => {
  it("is orientation-free and treats a crop as different, not as a mismatch", () => {
    expect(compareSize({ ...capture, width: 1708, height: 2560 }, osprey)).toBe("same");
    expect(compareSize({ ...capture, width: 2560, height: 2560 }, osprey)).toBe("different");
    expect(compareSize({ ...capture, width: null }, osprey)).toBeNull();
    // A cropped upload never blocks the pair; it only reads as a different shape.
    const cropped = { ...osprey, photos: [{ ...osprey.photos[0], width: 1200, height: 1100 }] };
    expect(evidenceFor(capture, cropped)?.size).toBe("different");
  });
});

describe("evidenceFor", () => {
  it("never pairs on species alone, and a far-away place rules a pair out", () => {
    expect(evidenceFor({ ...capture, takenAt: "2026-06-01T10:00:00Z" }, osprey)).toBeNull();
    expect(evidenceFor({ ...capture, lat: 49.28, lon: -123.12 }, osprey)).toBeNull();
    expect(evidenceFor({ ...capture, lat: 54.0018, lon: -122.698 }, osprey)?.place).toBe("near");
  });
});

const ev: Evidence = { taxon: "same", time: "close", size: "same", place: null };
const cand = (captureId: string, perPhoto: number[], evidence: Evidence = ev): Candidate => ({
  captureId,
  evidence,
  perPhoto,
  similarity: Math.max(...perPhoto),
});

describe("decide", () => {
  it("links the one frame the picture clearly picks", () => {
    const r = decide("1", [cand("a", [0.98]), cand("b", [0.9])], 1);
    expect(r.links.map((l) => l.captureId)).toEqual(["a"]);
    expect(r.review.map((l) => l.captureId)).toEqual(["b"]);
  });

  it("sends a burst of near-identical frames to review, all side by side", () => {
    // Measured: two woodpecker frames a minute apart, 0.976 and 0.973.
    const r = decide("1", [cand("a", [0.976]), cand("b", [0.973]), cand("c", [0.95])], 1);
    expect(r.links).toEqual([]);
    expect(r.review.map((l) => l.captureId)).toEqual(["a", "b", "c"]);
  });

  it("does not link a crop where the wrong frame edges ahead (measured lead 0.023)", () => {
    const r = decide("1", [cand("other", [0.954]), cand("truth", [0.931])], 1);
    expect(0.954 - 0.931).toBeLessThan(MARGIN);
    expect(r.links).toEqual([]);
    expect(r.review).toHaveLength(2);
  });

  it("links a cropped upload that tiles lift above sure", () => {
    expect(decide("1", [cand("a", [0.984]), cand("b", [0.909])], 1).links).toHaveLength(1);
  });

  it("puts a probable match in review and drops a poor one", () => {
    expect(decide("1", [cand("a", [0.9])], 1)).toMatchObject({ links: [], review: [{ captureId: "a" }] });
    expect(decide("1", [cand("a", [0.77])], 1)).toEqual({ links: [], review: [] });
  });

  it("never links a broader or disputed name on the picture alone", () => {
    expect(decide("1", [cand("a", [0.99], { ...ev, taxon: "related" })], 1).links).toEqual([]);
  });

  it("links a frame per observation photo, but only as many as it has room for", () => {
    const pair = [cand("a", [0.98, 0.8]), cand("b", [0.8, 0.97])];
    expect(
      decide("1", pair, 2)
        .links.map((l) => l.captureId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(decide("1", pair, 1).links).toHaveLength(1);
    // Not fully compared (untiled close frames): offered, never linked.
    expect(decide("1", pair, 0).links).toEqual([]);
  });

  it("without the image model links nothing and offers only close times", () => {
    const none = (id: string, time: Evidence["time"]): Candidate => ({
      captureId: id,
      evidence: { ...ev, time },
      similarity: null,
      perPhoto: [],
    });
    const r = decide("1", [none("a", "close"), none("b", "sameDay")], 1);
    expect(r.links).toEqual([]);
    expect(r.review.map((m) => m.captureId)).toEqual(["a"]);
  });
});

describe("settle", () => {
  it("sends a photo two observations both claim to review", () => {
    const one = decide("1", [cand("a", [0.99])], 1);
    const two = decide("2", [cand("a", [0.98])], 1);
    const three = decide("3", [cand("b", [0.99])], 1);
    const r = settle([one, two, three]);
    expect(r.links.map((l) => `${l.observationId}:${l.captureId}`)).toEqual(["3:b"]);
    expect(r.review.map((l) => l.observationId).sort()).toEqual(["1", "2"]);
  });
});

describe("candidatePairs", () => {
  it("finds pairs by taxon and day, skips dismissed pairs and observations Lifer sent", () => {
    const other: LocalCapture = { ...capture, id: "c-heron", taxonId: 4956 };
    const pairs = candidatePairs([capture, other], [osprey], { notMatches: new Set(), skipObservations: new Set() });
    expect(pairs.get(osprey.id)?.map((p) => p.capture.id)).toEqual(["c-osprey"]);
    expect(
      candidatePairs([capture], [osprey], {
        notMatches: new Set([`c-osprey:${osprey.id}`]),
        skipObservations: new Set(),
      }).size,
    ).toBe(0);
    expect(
      candidatePairs([capture], [osprey], { notMatches: new Set(), skipObservations: new Set([osprey.id]) }).size,
    ).toBe(0);
  });

  it("compares the nearest frames first on a busy day", () => {
    const burst = Array.from({ length: 60 }, (_, i) => ({
      ...capture,
      id: `c${i}`,
      takenAt: new Date(Date.parse("2026-09-11T04:00:00Z") + i * 60_000).toISOString(),
    }));
    const list = candidatePairs(burst, [osprey], {
      notMatches: new Set(),
      skipObservations: new Set(),
      perObservation: 5,
    });
    expect(list.get(osprey.id)?.map((p) => p.capture.id)).toEqual(["c40", "c39", "c41", "c38", "c42"]);
  });
});

describe("likeness", () => {
  it("names the score in words", () => {
    expect(likeness(SAME)).toBe("same");
    expect(likeness(0.9)).toBe("probably");
    expect(likeness(0.5)).toBeNull();
    expect(likeness(null)).toBeNull();
  });
});
