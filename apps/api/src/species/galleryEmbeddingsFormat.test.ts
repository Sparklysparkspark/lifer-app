import { describe, expect, it } from "vitest";
import {
  decodeGalleryEmbeddings,
  encodeGalleryEmbeddingRecord,
  encodeGalleryEmbeddingsHeader,
  float16BitsToFloat32,
  float32ToFloat16Bits,
  type GalleryEmbeddingsHeader,
} from "@lifer/shared/src/galleryEmbeddingsFormat.js";
import { cosineSimilarity, l2Normalize } from "./embeddings.js";

function randomUnitVector(dim: number, seed: number): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  return l2Normalize(Float32Array.from({ length: dim }, rand));
}

const roundTrip = (v: number[]) => v.map((x) => float16BitsToFloat32(float32ToFloat16Bits(x)));

async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe("float16 conversion", () => {
  it("round-trips exact values and specials", () => {
    for (const v of [0, 1, -1, 0.5, -2, 65504]) expect(roundTrip([v])[0]).toBe(v);
    expect(roundTrip([Infinity])[0]).toBe(Infinity);
    expect(Number.isNaN(roundTrip([NaN])[0])).toBe(true);
    expect(roundTrip([1e-8])[0]).toBe(0);
  });

  it("keeps cosine scores far inside the suggestion confidence margin", () => {
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const a = randomUnitVector(768, i * 2 + 1);
      const b = randomUnitVector(768, i * 2 + 2);
      worst = Math.max(worst, Math.abs(cosineSimilarity(a, b) - cosineSimilarity(roundTrip(a), roundTrip(b))));
    }
    // CONFIDENCE_MARGIN in embeddings.ts is 0.025.
    expect(worst).toBeLessThan(1e-3);
  });
});

describe("gallery embeddings file", () => {
  const records = [
    { speciesId: "0f8fad5b-d9cb-469f-a165-70867728950e", photoUrl: "https://example.org/a.jpg", embedding: randomUnitVector(8, 1) },
    { speciesId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", photoUrl: "https://example.org/b é.jpg", embedding: randomUnitVector(8, 2) },
  ];
  const file = Buffer.concat([
    encodeGalleryEmbeddingsHeader({ dimension: 8, rowCount: records.length, modelVersion: "clip-test" }),
    ...records.map((r) => encodeGalleryEmbeddingRecord(r, 8)),
  ]);

  it("decodes across arbitrary chunk boundaries", async () => {
    for (const size of [1, 7, 64, file.length]) {
      let header: GalleryEmbeddingsHeader | null = null;
      const out = [];
      for await (const r of decodeGalleryEmbeddings(chunked(file, size), (h) => (header = h))) out.push(r);
      expect(header).toMatchObject({ dimension: 8, rowCount: 2, modelVersion: "clip-test" });
      expect(out.map((r) => [r.speciesId, r.photoUrl])).toEqual(records.map((r) => [r.speciesId, r.photoUrl]));
      out.forEach((r, i) => r.embedding.forEach((v, j) => expect(v).toBeCloseTo(records[i].embedding[j], 3)));
    }
  });

  it("rejects a truncated file", async () => {
    const run = async () => {
      for await (const _ of decodeGalleryEmbeddings(chunked(file.subarray(0, file.length - 3), 16), () => {})) void _;
    };
    await expect(run()).rejects.toThrow(/mid-record/);
  });
});
