import { describe, expect, it } from "vitest";
import type { CollectionItem } from "@lifer/shared";
import { summarizeCategories } from "./categorySummary";

const sp = (id: string, over: Partial<CollectionItem>): CollectionItem =>
  ({
    speciesId: id,
    taxonClass: "aves",
    state: "unseen",
    tier: "common",
    localTier: null,
    coverPhotoUrl: `/api/species/${id}/reference-photo/thumb`,
    ...over,
  }) as CollectionItem;

describe("summarizeCategories", () => {
  it("counts photographed of shown per offered group, in the offered order, skipping empty ones", () => {
    const items = [
      sp("a", { state: "collected" }),
      sp("b", {}),
      sp("c", { taxonClass: "mammalia", state: "collected" }),
      sp("d", { taxonClass: "insecta" as never }),
    ];
    const out = summarizeCategories(items, ["mammalia", "aves", "amphibia"]);
    expect(out.map((s) => [s.taxon, s.collected, s.total])).toEqual([
      ["mammalia", 1, 1],
      ["aves", 1, 2],
    ]);
  });

  it("uses your rarest photo, most photos breaking a tie", () => {
    const own = (id: string, tier: string, photoCount: number) =>
      sp(id, { state: "collected", tier: tier as never, photoCount, coverPhotoUrl: `/api/photos/${id}/thumb` });
    const [s] = summarizeCategories([own("x", "common", 50), own("y", "rare", 2), own("z", "rare", 9)], ["aves"]);
    expect(s.own).toBe(true);
    expect(s.cover?.speciesId).toBe("z");
  });

  it("falls back to the most common species' reference photo, never an unrated one", () => {
    const items = [sp("r", { tier: "rare" }), sp("u", { tier: "unrated" as never }), sp("c", { tier: "common" })];
    const [s] = summarizeCategories(items, ["aves"]);
    expect(s.own).toBe(false);
    expect(s.cover?.speciesId).toBe("c");
  });
});
