import { describe, expect, it } from "vitest";
import { hasRememberedVector, photoVectors, rememberPhotoVector } from "./vectorCache.js";

// 16 MB each, so the 64 MB memo holds four.
const big = () => new Float32Array(4 * 1024 * 1024);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("vector memo", () => {
  it("evicts the least recently used vector once over its byte budget", async () => {
    for (const key of ["a", "b", "c", "d"]) {
      rememberPhotoVector("clip", key, big());
      await tick();
    }
    // A hit moves "a" to the newest end, so "b" is the oldest now.
    await photoVectors(new Uint8Array(), { kinds: ["clip"], key: "a", priority: "background" }).vectors.clip;
    rememberPhotoVector("clip", "e", big());
    await tick();
    expect(["a", "b", "c", "d", "e"].map((k) => hasRememberedVector("clip", k))).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
  });
});
