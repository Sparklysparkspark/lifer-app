import { describe, expect, it } from "vitest";
import { PORTRAIT, classifyReferencePhoto, promptVectors } from "./referencePortrait.js";
import { PROMPTS } from "./portraitPromptVectors.js";

// Fixture "image" vectors: a prompt's own text vector, or a normalized blend of two.
const vectorOf = (text: string) => promptVectors()[PROMPTS.findIndex(([, t]) => t === text)];
function blend(a: string, b: string, wb: number): number[] {
  const va = vectorOf(a);
  const vb = vectorOf(b);
  const v = Array.from(va, (x, i) => (1 - wb) * x + wb * vb[i]);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

describe("classifyReferencePhoto", () => {
  it("decodes one unit-length vector per prompt", () => {
    for (const v of promptVectors()) expect(Math.hypot(...v)).toBeCloseTo(1, 2);
  });

  it("calls a picture of the animal a portrait with a positive score", () => {
    const c = classifyReferencePhoto(vectorOf("a photo of a bird"));
    expect(c.kind).toBe(PORTRAIT);
    expect(c.score).toBeGreaterThan(0);
  });

  it.each([
    ["a clutch of eggs in a nest", "egg"],
    ["animal footprints in mud", "tracks"],
    ["an animal skull", "bones"],
    ["a museum specimen in a drawer", "specimen"],
    ["a range map", "map"],
    ["a page of text", "text"],
  ])("calls %s %s", (text, kind) => {
    const c = classifyReferencePhoto(vectorOf(text));
    expect(c.kind).toBe(kind);
    expect(c.score).toBeLessThan(0);
  });

  it("keeps a photo that only leans toward a non-portrait kind a portrait", () => {
    // Mostly bird, a little nest: the nest wins only by less than its margin, if at all.
    const c = classifyReferencePhoto(blend("a photo of a bird", "a bird nest", 0.45));
    expect(c.kind).toBe(PORTRAIT);
  });

  it("ranks a cleaner portrait above a blended one", () => {
    const clean = classifyReferencePhoto(vectorOf("a photo of a bird")).score;
    const blended = classifyReferencePhoto(blend("a photo of a bird", "a photo of eggs", 0.3)).score;
    expect(clean).toBeGreaterThan(blended);
  });
});
