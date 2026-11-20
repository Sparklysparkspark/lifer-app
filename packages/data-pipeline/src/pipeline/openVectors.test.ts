import { describe, expect, it } from "vitest";
import { chooseGalleryVectors } from "./openVectors.js";

const v = (photoId: string, license: string | null) => ({ photoId, license });

describe("chooseGalleryVectors", () => {
  it("keeps only open vectors once a species has 3 or more", () => {
    const out = chooseGalleryVectors([v("a", "cc-by-nc"), v("b", "cc0"), v("c", "cc-by"), v("d", "cc-by-4.0")]);
    expect(out.map((x) => x.photoId)).toEqual(["b", "c", "d"]);
  });
  it("caps at 6", () => {
    const many = Array.from({ length: 9 }, (_, i) => v(`p${i}`, "cc0"));
    expect(chooseGalleryVectors(many)).toHaveLength(6);
  });
  it("tops up with other vectors, open first, when fewer than 3 are open", () => {
    const out = chooseGalleryVectors([v("a", "cc-by-nc"), v("b", "cc0"), v("c", null)]);
    expect(out.map((x) => x.photoId)).toEqual(["b", "a", "c"]);
  });
});
