import { describe, expect, it } from "vitest";
import { queryFromRules, rulesFromQuery, rulesSummary } from "./smartAlbumRules";
import type { GalleryQuery } from "./types";

type SmartAlbumRulesQuery = Parameters<typeof queryFromRules>[0]["query"];

const base: Omit<GalleryQuery, "sortBy"> = {
  searchQuery: "",
  onlyHidden: false,
  ratingMin: null,
  ratingMax: null,
  unrated: false,
  animalsMin: null,
  animalsMax: null,
  onlyFeatured: false,
  notOnInat: false,
  missingDate: false,
  missingCoordinates: false,
  shotActions: new Set(),
  shotFramings: new Set(),
  tiers: [],
  tierRegionId: null,
  selectedTaxa: new Set(),
  rawFiles: "show",
  editedRaw: "any",
  mediaFilter: "photos",
  dateFrom: "",
  dateTo: "",
  regionIds: [],
  tags: [],
  places: [],
  appearance: { lifeStage: [], sex: [], plumage: [], morph: [] },
  bbox: null,
  scopeTripId: null,
  scopeAlbumId: null,
};

describe("smart album rules", () => {
  it("round-trips the Gallery filter state", () => {
    const query = {
      ...base,
      searchQuery: "in flight",
      ratingMin: 3,
      ratingMax: 4,
      selectedTaxa: new Set(["aves", "mammalia"]),
      rawFiles: "only" as const,
      editedRaw: "with" as const,
      mediaFilter: "both" as const,
      dateFrom: "2024-01-01",
      regionIds: ["uncategorized", "11111111-1111-4111-8111-111111111112"],
      tags: ["best", "keeper"],
      tiers: ["rare", "legendary"],
      bbox: "12.5,42.5,13.5,43.5",
      scopeTripId: "11111111-1111-4111-8111-111111111111",
    };
    const rules = rulesFromQuery(query);
    expect(rules.version).toBe(2);
    expect(rules.query).toMatchObject({
      tag: ["best", "keeper"],
      tier: ["rare", "legendary"],
      tripId: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(rules.query).toMatchObject({
      q: "in flight",
      ratingMin: "3",
      ratingMax: "4",
      taxa: "aves,mammalia",
      onlyRaw: "1",
    });
    expect(queryFromRules(rules)).toEqual(query);
  });

  it("reads an older top rated rule as a 5-star minimum, and names rating ranges", () => {
    expect(queryFromRules({ version: 2, query: { onlyTopRated: "1" } })).toMatchObject({
      ratingMin: 5,
      ratingMax: null,
    });
    const label = (q: Partial<typeof base>) =>
      rulesSummary(rulesFromQuery({ ...base, ...q }), { regionNames: [], namingStyles: [] });
    expect(label({ ratingMin: 3 })).toBe("3 to 5 stars");
    expect(label({ ratingMin: 3, ratingMax: 4 })).toBe("3 to 4 stars");
    expect(label({ unrated: true })).toBe("Unrated");
  });

  it("summarizes the rules in one line, leaving the default presets out", () => {
    const rules = rulesFromQuery({
      ...base,
      selectedTaxa: new Set(["aves"]),
      shotActions: new Set(["flying", "behavior"]),
      shotFramings: new Set(["environmental"]),
      ratingMin: 5,
    });
    expect(rules.query).toMatchObject({ action: "flying,behavior", framing: "environmental" });
    expect(rulesSummary(rules, { regionNames: [], namingStyles: [] })).toBe(
      "Birds · Flying or Behaviour · Environmental · 5 stars",
    );
    expect(rulesSummary(rulesFromQuery(base), { regionNames: [], namingStyles: [] })).toBe("All photos");
  });

  it("round-trips and summarizes appearance rules as lists", () => {
    const query = {
      ...base,
      appearance: { lifeStage: ["juvenile", "adult"], sex: ["female"], plumage: ["eclipse"], morph: ["dark morph"] },
    };
    const rules = rulesFromQuery(query);
    expect(rules.query).toEqual({
      excludeVideo: "1",
      lifeStage: ["juvenile", "adult"],
      sex: ["female"],
      plumage: ["eclipse"],
      morph: ["dark morph"],
    });
    expect(queryFromRules(rules)).toEqual(query);
    expect(rulesSummary(rules, { regionNames: [], namingStyles: [] })).toBe(
      "Juvenile or Adult · Female · eclipse · dark morph",
    );
  });

  it("round-trips and summarizes the RAW photos not edited yet", () => {
    const rules = rulesFromQuery({ ...base, rawFiles: "unedited" });
    expect(rules.query).toEqual({ excludeVideo: "1", unedited: "1" });
    expect(queryFromRules(rules).rawFiles).toBe("unedited");
    expect(rulesSummary(rules, { regionNames: [], namingStyles: [] })).toBe("RAW files not edited yet");
  });

  it("reads rules saved with the older single shotKind as the axis it stands for", () => {
    const read = (shotKind: string) => {
      const q = queryFromRules({ version: 2, query: { shotKind } as SmartAlbumRulesQuery });
      return [[...q.shotActions], [...q.shotFramings]];
    };
    expect(read("flight")).toEqual([["flying"], []]);
    expect(read("behavior")).toEqual([["behavior"], []]);
    expect(read("portrait")).toEqual([[], ["close"]]);
    expect(read("environmental")).toEqual([[], ["environmental"]]);
    // Saving again writes the new fields only.
    const resaved = rulesFromQuery(queryFromRules({ version: 2, query: { shotKind: "flight" } }));
    expect(resaved.query).toEqual({ action: "flying" });
  });
});
