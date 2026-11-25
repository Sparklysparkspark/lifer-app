// The five Stats groups (birds, mammals, reptiles and amphibians, fish and sea life, other) stay
// apart under protanopia, deuteranopia and tritanopia in both themes, and every mark meets 3:1
// against its surfaces. Read from disk: the test runner stubs CSS imports.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RARITY_BG, RARITY_FILL } from "../pages/explorer/treeModel";

const themeCss = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const MIN_DELTA_E = 12;
const GROUPS = ["birds", "mammals", "reptiles", "fish", "other"];
const SURFACES = ["canvas", "surface", "surface-muted"];

// Machado et al. 2009, severity 1.0, applied in linear RGB.
const MATRICES: Record<string, number[][]> = {
  none: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function linear(hex: string): number[] {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

const luminance = (hex: string) => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function lab(hex: string, kind: string): number[] {
  const [r, g, b] = MATRICES[kind].map(
    (row) => row[0] * linear(hex)[0] + row[1] * linear(hex)[1] + row[2] * linear(hex)[2],
  );
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 (Sharma et al. reference implementation). */
function deltaE2000(p: number[], q: number[]): number {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const cMean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1 = Math.hypot(a1p, b1);
  const c2 = Math.hypot(a2p, b2);
  const hue = (y: number, x: number) => (Math.atan2(y, x) / rad + 360) % 360;
  const h1 = c1 ? hue(b1, a1p) : 0;
  const h2 = c2 ? hue(b2, a2p) : 0;
  let dh = 0;
  if (c1 * c2) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh * rad) / 2);
  const lMean = (L1 + L2) / 2;
  const cp = (c1 + c2) / 2;
  let hp = h1 + h2;
  if (c1 * c2) hp = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const t =
    1 -
    0.17 * Math.cos((hp - 30) * rad) +
    0.24 * Math.cos(2 * hp * rad) +
    0.32 * Math.cos((3 * hp + 6) * rad) -
    0.2 * Math.cos((4 * hp - 63) * rad);
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cp;
  const sh = 1 + 0.015 * cp * t;
  const rt =
    -Math.sin(2 * 30 * Math.exp(-(((hp - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(cp ** 7 / (cp ** 7 + 25 ** 7));
  const dl = (L2 - L1) / sl;
  const dc = (c2 - c1) / sc;
  const dhh = dH / sh;
  return Math.sqrt(dl ** 2 + dc ** 2 + dhh ** 2 + rt * dc * dhh);
}

describe("taxa colours for colour-blind viewers", () => {
  const light = tokens(themeCss.slice(themeCss.indexOf(":root"), themeCss.indexOf(".dark")));
  const dark = { ...light, ...tokens(themeCss.slice(themeCss.indexOf(".dark"), themeCss.indexOf("@theme"))) };
  it.each([
    ["light", light],
    ["dark", dark],
  ])("keeps every group pair apart in %s mode", (_mode, theme) => {
    const tooClose: string[] = [];
    for (const kind of Object.keys(MATRICES)) {
      for (const [i, a] of GROUPS.entries()) {
        for (const b of GROUPS.slice(i + 1)) {
          const d = deltaE2000(lab(theme[`taxa-${a}`], kind), lab(theme[`taxa-${b}`], kind));
          if (d < MIN_DELTA_E) tooClose.push(`${a} vs ${b} (${kind}): ${d.toFixed(1)}`);
        }
      }
    }
    expect(tooClose).toEqual([]);
  });
  it.each([
    ["light", light],
    ["dark", dark],
  ])("meets 3:1 for marks on every surface in %s mode", (_mode, theme) => {
    const weak = GROUPS.flatMap((g) => SURFACES.map((s) => [g, s, contrast(theme[`taxa-${g}`], theme[s])] as const))
      .filter(([, , c]) => c < 3)
      .map(([g, s, c]) => `${g} on ${s}: ${c.toFixed(2)}`);
    expect(weak).toEqual([]);
  });
});

// The Tree of life's rarity scale: the accent at rising opacity over the canvas, one hue, so it must
// read by lightness alone.
describe("rarity scale", () => {
  const light = tokens(themeCss.slice(themeCss.indexOf(":root"), themeCss.indexOf(".dark")));
  const dark = { ...light, ...tokens(themeCss.slice(themeCss.indexOf(".dark"), themeCss.indexOf("@theme"))) };
  const alphas = RARITY_FILL.map((c) => Number(c.split("/")[1]) / 100);
  const blend = (fg: string, bg: string, a: number) =>
    `#${[1, 3, 5]
      .map((i) => Math.round(a * parseInt(fg.slice(i, i + 2), 16) + (1 - a) * parseInt(bg.slice(i, i + 2), 16)))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;

  it("uses the same steps for arcs and list chips", () => {
    expect(RARITY_BG.map((c) => c.replace("bg-", "fill-"))).toEqual(RARITY_FILL);
  });
  it.each([
    ["light", light],
    ["dark", dark],
  ])("keeps each step at least 1.3:1 from the next in %s mode", (_mode, theme) => {
    const steps = alphas.map((a) => blend(theme.accent, theme.canvas, a));
    const close = steps.slice(1).filter((c, i) => contrast(c, steps[i]) < 1.3);
    expect(close).toEqual([]);
  });
});
