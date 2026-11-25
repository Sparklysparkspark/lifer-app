import { describe, expect, it } from "vitest";
import { ease, type Geo, lerpGeo, moreKey, moves, parentKey, ROOT, transition, type View } from "./arcMotion";

const TAU = 2 * Math.PI;
const CENTRE = { start: 0, end: TAU, r0: 0, r1: 100, opacity: 1 };
const geo = (start: number, end: number, ring: number, share = 0): Geo => ({
  start,
  end,
  r0: 100 + (ring - 1) * 50,
  r1: 150 + (ring - 1) * 50,
  opacity: 1,
  share,
});
const view = (centre: string, arcs: Record<string, Geo>): View => ({ centre, geo: new Map(Object.entries(arcs)) });
const byKey = (v: View, w: View) => new Map(transition(v, w, CENTRE).map((t) => [t.key, t]));

// The top of the tree: two classes, A twice as big as B, each with one ring of children.
const A = "class:A";
const B = "class:B";
const A1 = `${A}/order:A1`;
const A2 = `${A}/order:A2`;
const top = view(ROOT, {
  [A]: geo(0, TAU * (2 / 3), 1),
  [B]: geo(TAU * (2 / 3), TAU, 1),
  [A1]: geo(0, 1, 2),
  [A2]: geo(1, TAU * (2 / 3), 2),
});
// Zoomed into A: its children fill the first ring, and a new third level appears.
const A1x = `${A1}/family:x`;
const inA = view(A, { [A1]: geo(0, 1.5, 1), [A2]: geo(1.5, TAU, 1), [A1x]: geo(0, 1.5, 2) });

describe("ease", () => {
  it("runs 0 to 1, rising, faster than linear early on like CSS ease", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    // CSS ease is about 0.8 at the halfway point.
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
    for (let t = 0; t < 1; t += 0.05) expect(ease(t + 0.05)).toBeGreaterThanOrEqual(ease(t));
  });
});

describe("lerpGeo", () => {
  it("interpolates every field", () => {
    const g = lerpGeo(geo(0, 1, 1, 0), { ...geo(1, 3, 2, 1), opacity: 0 }, 0.5);
    expect(g).toEqual({ start: 0.5, end: 2, r0: 125, r1: 175, opacity: 0.5, share: 0.5 });
  });
});

describe("parentKey", () => {
  it("walks tree ids and more keys up to the root", () => {
    expect(parentKey(A1x)).toBe(A1);
    expect(parentKey(A)).toBe(ROOT);
    expect(parentKey(ROOT)).toBeNull();
    expect(parentKey(moreKey(A, 12))).toBe(A);
    expect(parentKey(moreKey(null, 12))).toBe(ROOT);
  });
});

describe("transition", () => {
  it("zooming in: the wedge becomes the middle, its children open out, siblings slide off the ends", () => {
    const t = byKey(top, inA);
    expect(t.get(A)!.to).toMatchObject({ start: 0, end: TAU, r0: 0, r1: 100 });
    expect(t.get(A1)!.from).toEqual(top.geo.get(A1));
    expect(t.get(A1)!.to).toEqual(inA.geo.get(A1));
    // B sat after A, so it is pushed past the end of the circle and folds to nothing there.
    expect(t.get(B)!.to).toMatchObject({ start: TAU, end: TAU, opacity: 0 });
    // A1's new child grows out of A1's old outer edge, inside A1's old angles.
    const x = t.get(A1x)!.from;
    expect(x).toMatchObject({ r0: 200, r1: 200, opacity: 0 });
    expect(x.start).toBeCloseTo(0);
    expect(x.end).toBeCloseTo(1);
  });

  it("stepping out is the reverse", () => {
    const t = byKey(inA, top);
    expect(t.get(A)!.from).toMatchObject({ start: 0, end: TAU, r0: 0, r1: 100 });
    expect(t.get(A)!.to).toEqual(top.geo.get(A));
    expect(t.get(B)!.from).toMatchObject({ start: TAU, end: TAU, opacity: 0 });
    expect(t.get(A1x)!.to).toMatchObject({ r0: 200, r1: 200, opacity: 0 });
  });

  it("the same view with new counts morphs in place, and children of the middle grow out of it", () => {
    const after = view(ROOT, { [A]: geo(0, 3, 1, 0.5), [B]: geo(3, TAU, 1), [`${B}/order:B1`]: geo(3, TAU, 2) });
    const t = byKey(top, after);
    expect(t.get(A)!.to.share).toBe(0.5);
    // A2 folds into A's outer edge; B's new child grows out of B's old one.
    expect(t.get(A2)!.to).toMatchObject({ r0: 150, r1: 150, opacity: 0 });
    const b1 = t.get(`${B}/order:B1`)!.from;
    expect(b1).toMatchObject({ r0: 150, r1: 150, opacity: 0 });
    expect(b1.start).toBeCloseTo(TAU * (2 / 3));
    // A lone ring arc without any common group grows out of the middle.
    const lone = byKey(view(ROOT, {}), view(ROOT, { [A]: geo(0, 1, 1) })).get(A)!.from;
    expect(lone).toMatchObject({ start: 0, end: 1, r0: 100, r1: 100, opacity: 0 });
  });

  it("retargets from a half-drawn frame, never from the old view", () => {
    const halfway = new Map(transition(top, inA, CENTRE).map((tw) => [tw.key, lerpGeo(tw.from, tw.to, 0.5)]));
    const t = byKey({ centre: A, geo: halfway }, top);
    expect(t.get(A1)!.from).toEqual(halfway.get(A1));
    expect(t.get(A1)!.to).toEqual(top.geo.get(A1));
    // B was halfway gone; it comes back from where it was.
    expect(t.get(B)!.from).toEqual(halfway.get(B));
    expect(t.get(B)!.to.opacity).toBe(1);
  });

  it("a more view opens out of its more arc", () => {
    const more = moreKey(ROOT, 2);
    const before = view(ROOT, { [A]: geo(0, 6, 1), [more]: geo(6, TAU, 1) });
    const after = view(more, { "class:C": geo(0, Math.PI, 1), "class:D": geo(Math.PI, TAU, 1) });
    const t = byKey(before, after);
    expect(t.get(more)!.to).toMatchObject({ start: 0, end: TAU, r1: 100 });
    expect(t.get("class:C")!.from.start).toBeCloseTo(6);
    expect(t.get("class:D")!.from.end).toBeCloseTo(TAU);
    expect(t.get(A)!.to).toMatchObject({ start: 0, end: 0, opacity: 0 });
  });

  it("skips arcs too thin to see at both ends, and reports no motion when nothing changes", () => {
    const thin = view(A, { "class:A/order:tiny": geo(0, 1e-4, 1) });
    expect(transition(view(A, {}), thin, CENTRE)).toEqual([]);
    expect(moves(transition(top, top, CENTRE))).toBe(false);
    expect(moves(transition(top, inA, CENTRE))).toBe(true);
  });
});
