import { describe, expect, it } from "vitest";
import { diffPacks, type PackOnServer } from "./packs.js";

const pack = (id: string, downloaded = true): PackOnServer => ({ id, taxon: null, sizeBytes: 1, downloaded });

describe("diffPacks", () => {
  it("finds what each side lacks, treating .small and full as the same pack", () => {
    const diff = diffPacks(
      ["canada-aves", "mexico-aves.small"],
      [pack("canada-aves.small"), pack("mexico-aves", false), pack("peru-aves"), pack("chile-aves", false)],
    );
    expect(diff.localOnly).toEqual(["mexico-aves.small"]);
    expect(diff.serverOnly.map((p) => p.id)).toEqual(["peru-aves"]);
  });

  it("is empty when both sides match", () => {
    expect(diffPacks(["a"], [pack("a")])).toEqual({ localOnly: [], serverOnly: [] });
  });
});
