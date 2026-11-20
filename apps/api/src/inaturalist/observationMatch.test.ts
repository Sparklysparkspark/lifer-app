// Picture similarity on small synthetic images with the real CLIP model. Skipped where the model
// isn't downloaded (CI); the matching rules themselves are covered in matching.test.ts.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { isModelDownloaded, photoVectors } from "@lifer/core/species/embeddings.js";
import { bestSimilarity } from "./observationMatch.js";

// A "bird" (dark ellipse with a light eye) on a two-tone background, at a chosen spot.
async function scene(birdX: number, background: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <rect width="1200" height="800" fill="${background}"/><rect y="560" width="1200" height="240" fill="#5b7f3a"/>
    <ellipse cx="${birdX}" cy="420" rx="140" ry="80" fill="#2b2118"/><circle cx="${birdX + 95}" cy="395" r="14" fill="#f2f2f2"/>
    <polygon points="${birdX + 135},405 ${birdX + 200},420 ${birdX + 135},432" fill="#d9a21b"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}
const vectors = async (bytes: Buffer) => {
  const { vectors: v } = photoVectors(bytes, { kinds: ["clip"], priority: "interactive" });
  return [await v.clip];
};

describe.skipIf(!isModelDownloaded())("picture similarity", () => {
  it("scores a downsized crop of the same picture above a different scene", async () => {
    const original = await scene(500, "#8fb8de");
    const upload = await sharp(original)
      .extract({ left: 120, top: 80, width: 960, height: 640 })
      .resize(400)
      .toBuffer();
    const stripes = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">${Array.from(
      { length: 12 },
      (_, i) => `<rect x="${i * 100}" width="50" height="800" fill="#c0392b"/>`,
    ).join("")}<circle cx="600" cy="400" r="200" fill="#1f4e9c"/></svg>`;
    const other = await sharp(Buffer.from(stripes)).jpeg().toBuffer();
    const local = await vectors(original);
    const same = bestSimilarity(await vectors(upload), local);
    const different = bestSimilarity(await vectors(other), local);
    expect(same).toBeGreaterThan(different);
  }, 120_000);
});

describe("bestSimilarity", () => {
  it("takes the best pair across both sets of vectors", () => {
    const a = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const b = [Float32Array.from([0.6, 0.8])];
    expect(bestSimilarity(a, b)).toBeCloseTo(0.8);
  });
});
