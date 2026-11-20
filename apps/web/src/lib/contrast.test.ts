// Every text colour in theme.css against every background it sits on, light and dark, meets
// WCAG AA for normal text (4.5:1). Read from disk: the test runner stubs CSS imports.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const themeCss = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TAXA = ["birds", "mammals", "reptiles", "amphibians", "fish", "insects", "arachnids", "other"];
const PAIRS: Array<[string, string]> = [
  ...TAXA.flatMap((g): Array<[string, string]> =>
    ["canvas", "surface", "surface-muted"].map((bg) => [`taxa-${g}`, bg]),
  ),
  ["ink", "canvas"],
  ["ink", "surface"],
  ["ink", "surface-muted"],
  ["ink", "control"],
  ["muted", "canvas"],
  ["muted", "surface"],
  ["muted", "surface-muted"],
  ["muted", "control"],
  ["link", "canvas"],
  ["link", "surface"],
  ["accent-fg", "accent"],
  ["ink", "sidebar"],
  ["link", "sidebar"],
];

describe("colour contrast", () => {
  const light = tokens(themeCss.slice(themeCss.indexOf(":root"), themeCss.indexOf(".dark")));
  const dark = { ...light, ...tokens(themeCss.slice(themeCss.indexOf(".dark"), themeCss.indexOf("@theme"))) };
  it.each([
    ["light", light],
    ["dark", dark],
  ])("meets 4.5:1 for text in %s mode", (_mode, theme) => {
    expect(Object.keys(theme)).toEqual(expect.arrayContaining(PAIRS.flat()));
    const failing = PAIRS.filter(([fg, bg]) => contrast(theme[fg], theme[bg]) < 4.5).map(
      ([fg, bg]) => `${fg} on ${bg}: ${contrast(theme[fg], theme[bg]).toFixed(2)}`,
    );
    expect(Object.keys(theme)).toEqual(expect.arrayContaining(PAIRS.flat()));
    expect(failing).toEqual([]);
  });
});

// Map graphics (WCAG 1.4.11 asks 3:1; the palette was tuned to these floors, dark ice being the
// lowest at 5.04) and labels on every basemap fill. Cluster numerals sit on the taxa discs, so they
// use canvas in dark mode, where the taxa colours are light.
const MAP_FILLS = ["map-land", "map-water", "map-forest", "map-scrub", "map-ice"];
const PIN_FLOOR = { light: 3.68, dark: 5 };

describe("map contrast", () => {
  const light = tokens(themeCss.slice(themeCss.indexOf(":root"), themeCss.indexOf(".dark")));
  const dark = { ...light, ...tokens(themeCss.slice(themeCss.indexOf(".dark"), themeCss.indexOf("@theme"))) };
  const below = (theme: Record<string, string>, pairs: Array<[string, string]>, floor: number) =>
    pairs
      .filter(([fg, bg]) => contrast(theme[fg], theme[bg]) < floor)
      .map(([fg, bg]) => `${fg} on ${bg}: ${contrast(theme[fg], theme[bg]).toFixed(2)}`);
  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("keeps pins, labels and the region outline legible in %s mode", (mode, theme) => {
    const pins = TAXA.flatMap((g) => MAP_FILLS.map((bg): [string, string] => [`taxa-${g}`, bg]));
    expect(below(theme, pins, PIN_FLOOR[mode])).toEqual([]);
    expect(
      below(
        theme,
        MAP_FILLS.map((bg): [string, string] => ["map-label", bg]),
        4.5,
      ),
    ).toEqual([]);
    expect(
      below(
        theme,
        ["map-land", "surface"].map((bg): [string, string] => ["link", bg]),
        3,
      ),
    ).toEqual([]);
    const numeral = mode === "light" ? "accent-fg" : "canvas";
    expect(
      below(
        theme,
        TAXA.map((g): [string, string] => [numeral, `taxa-${g}`]),
        4.5,
      ),
    ).toEqual([]);
  });

  it("tells land from water by more than the old near-equal greys", () => {
    expect(contrast(light["map-land"], light["map-water"])).toBeGreaterThanOrEqual(1.29);
    expect(contrast(dark["map-land"], dark["map-water"])).toBeGreaterThanOrEqual(1.24);
  });
});

// Controls: the slider's accent track and thumb meet 3:1 (WCAG 1.4.11) where sliders sit, and the
// viewers' white overlay text reads on the neutral surround.
describe("control and viewer contrast", () => {
  const light = tokens(themeCss.slice(themeCss.indexOf(":root"), themeCss.indexOf(".dark")));
  const dark = { ...light, ...tokens(themeCss.slice(themeCss.indexOf(".dark"), themeCss.indexOf("@theme"))) };
  it.each([
    ["light", light],
    ["dark", dark],
  ])("keeps the slider and viewer text legible in %s mode", (_mode, theme) => {
    for (const bg of ["surface", "canvas"]) expect(contrast(theme.accent, theme[bg])).toBeGreaterThanOrEqual(3);
    expect(contrast("#ffffff", theme.surround)).toBeGreaterThanOrEqual(4.5);
  });
});
