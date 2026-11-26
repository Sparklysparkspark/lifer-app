import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { scopedTier, tierPills } from "./tiers";

const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
const texts = (...a: Parameters<typeof tierPills>) => tierPills(...a).map((p) => p.text);

describe("tier pills", () => {
  it("inside a region: here, then worldwide, both even when they match; VoiceOver names the region", () => {
    const pills = tierPills(t, { localTier: "rare", worldTier: "uncommon" }, "British Columbia");
    expect(pills).toEqual([
      { text: "Rare here", label: "Rare in British Columbia" },
      { text: "Uncommon worldwide", label: "Uncommon worldwide" },
    ]);
    expect(texts(t, { localTier: "common", worldTier: "common" }, "Norfolk")).toEqual([
      "Common here",
      "Common worldwide",
    ]);
  });

  it("Everywhere shows only the plain worldwide tier, even with a local one stored", () => {
    expect(texts(t, { localTier: "rare", worldTier: "legendary" }, null)).toEqual(["Legendary"]);
  });

  it("thin data reads Unrated in its own scope; other gaps and unknown tiers show nothing", () => {
    expect(texts(t, { localTier: null, localTierReason: "thin_data", worldTier: "common" }, "Ontario")).toEqual([
      "Unrated here",
      "Common worldwide",
    ]);
    expect(texts(t, { localTier: null, worldTier: null, worldTierReason: "few_photos" }, null)).toEqual(["Unrated"]);
    expect(texts(t, { localTier: null, localTierReason: "untiered_group", worldTier: null }, "Ontario")).toEqual([]);
    expect(scopedTier("mythical", null)).toBeNull();
  });
});
