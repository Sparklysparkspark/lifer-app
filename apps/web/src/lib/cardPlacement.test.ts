import { describe, expect, it } from "vitest";
import { placeCard, type Box } from "./cardPlacement";

const area: Box = { left: 0, top: 0, width: 800, height: 600 };
const card = { width: 200, height: 150 };
const covers = (c: Box, m: { x: number; y: number; r: number }) =>
  m.x + m.r > c.left && m.x - m.r < c.left + c.width && m.y + m.r > c.top && m.y - m.r < c.top + c.height;

describe("placeCard", () => {
  it("goes below the mark, centred, when there's room", () => {
    const mark = { x: 400, y: 200, r: 10 };
    expect(placeCard({ area, mark, card })).toEqual({ side: "below", left: 300, top: 216, ...card });
  });

  it("flips above near the bottom of the map, never covering the mark", () => {
    const mark = { x: 400, y: 560, r: 10 };
    const p = placeCard({ area, mark, card });
    expect(p.side).toBe("above");
    expect(p.top).toBe(560 - 16 - 150);
    expect(covers(p, mark)).toBe(false);
  });

  it("slides along the edge to stay inside the map with its margin", () => {
    const p = placeCard({ area, mark: { x: 20, y: 100, r: 6 }, card });
    expect(p.side).toBe("below");
    expect(p.left).toBe(8);
    const right = placeCard({
      area: { left: 100, top: 50, width: 800, height: 600 },
      mark: { x: 890, y: 300, r: 6 },
      card,
    });
    expect(right.left + right.width).toBe(100 + 800 - 8);
  });

  it("avoids a control over the map when another side is free", () => {
    // The layers button sits right where "below" would go.
    const layers: Box = { left: 300, top: 210, width: 200, height: 40 };
    const p = placeCard({ area, mark: { x: 400, y: 200, r: 10 }, card, obstacles: [layers] });
    expect(p.side).toBe("above");
  });

  it("goes to a side when neither below nor above fits, as in a short map", () => {
    const short: Box = { left: 0, top: 0, width: 800, height: 200 };
    const p = placeCard({ area: short, mark: { x: 300, y: 100, r: 10 }, card });
    expect(p.side).toBe("right");
    expect(p.top).toBe(25);
    expect(covers(p, { x: 300, y: 100, r: 10 })).toBe(false);
  });

  it("stays inside the map even when every spot is taken by a control", () => {
    const everywhere: Box = { left: 0, top: 0, width: 800, height: 600 };
    const p = placeCard({ area, mark: { x: 400, y: 200, r: 10 }, card, obstacles: [everywhere] });
    expect(p.side).toBe("below");
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});
