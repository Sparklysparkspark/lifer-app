import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { palettes } from "./theme";

describe("Sunlight appearance (MR6)", () => {
  const s = palettes.sunlight;
  it("text reaches 7:1 on every surface", () => {
    for (const fg of [s.ink, s.muted, s.link]) {
      for (const bg of [s.canvas, s.surface, s["surface-muted"]]) {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(7);
      }
    }
    expect(contrastRatio(s["accent-fg"], s.accent)).toBeGreaterThanOrEqual(7);
  });
  it("control outlines reach 4.5:1", () => {
    expect(contrastRatio(s["control-line"], s.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(s["control-line"], s.control)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("light and dark body text", () => {
  it("is at least 4.5:1", () => {
    for (const p of [palettes.light, palettes.dark]) {
      expect(contrastRatio(p.ink, p.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.muted, p.canvas)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("rarity pills", () => {
  it("muted text on the quiet pill reads at 4.5:1 in light and dark, 7:1 in Sunlight", () => {
    for (const p of [palettes.light, palettes.dark])
      expect(contrastRatio(p.muted, p["surface-muted"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palettes.sunlight.muted, palettes.sunlight["surface-muted"])).toBeGreaterThanOrEqual(7);
  });
});
