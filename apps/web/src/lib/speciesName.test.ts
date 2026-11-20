// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { loadSettings, resetSettingsCache } from "../hooks/useSettings";
import {
  DEFAULT_SPECIES_NAME_PREFS,
  namePartClass,
  normaliseSpeciesNamePrefs,
  resetSpeciesNamePrefsCache,
  setSpeciesNamePrefs,
  speciesDisplayName,
  speciesNameParts,
  useSpeciesName,
  useSpeciesNamePrefs,
  type NamedSpecies,
  type NamePart,
  type AlsoShow,
  type MainName,
  type SpeciesNamePrefs,
} from "./speciesName";

describe("speciesDisplayName", () => {
  it("prefers the common name in either casing", () => {
    expect(speciesDisplayName({ commonName: "Osprey", scientificName: "Pandion haliaetus" })).toBe("Osprey");
    expect(speciesDisplayName({ common_name: "Osprey", scientific_name: "Pandion haliaetus" })).toBe("Osprey");
  });

  it("falls back to the scientific name when the common name is missing or empty", () => {
    expect(speciesDisplayName({ scientificName: "Pandion haliaetus" })).toBe("Pandion haliaetus");
    expect(speciesDisplayName({ common_name: null, scientific_name: "Pandion haliaetus" })).toBe("Pandion haliaetus");
    expect(speciesDisplayName({ commonName: "", scientificName: "Pandion haliaetus" })).toBe("Pandion haliaetus");
  });
});

describe("speciesNameParts", () => {
  const robin = {
    commonName: "American Robin",
    scientificName: "Turdus migratorius",
    abaCode: "AMRO",
    ebirdCode: "amerob",
  };
  // A bird outside the ABA area: an eBird code, no ABA code.
  const blackbird = { commonName: "Eurasian Blackbird", scientificName: "Turdus merula", ebirdCode: "eurbla" };
  // Not a bird: no codes at all.
  const fox = { common_name: "Red Fox", scientific_name: "Vulpes vulpes" };
  const common = (text: string): NamePart => ({ text, kind: "common" });
  const sci = (text: string): NamePart => ({ text, kind: "scientific" });
  const code = (text: string): NamePart => ({ text, kind: "code" });
  const parts = (species: NamedSpecies, main: MainName, also: AlsoShow[]) => speciesNameParts(species, { main, also });

  it("defaults to common, with the scientific name below", () => {
    expect(speciesNameParts(robin)).toEqual({
      primary: common("American Robin"),
      secondary: [sci("Turdus migratorius")],
    });
  });

  const ALL_ALSO: AlsoShow[][] = [
    [],
    ["other"],
    ["aba"],
    ["ebird"],
    ["other", "aba"],
    ["other", "ebird"],
    ["aba", "ebird"],
    ["other", "aba", "ebird"],
  ];
  it.each(ALL_ALSO)("shows %j under either main name, in a fixed order", (...also) => {
    const expected = (other: NamePart) =>
      [
        also.includes("other") && other,
        also.includes("aba") && code("AMRO"),
        also.includes("ebird") && code("amerob"),
      ].filter((p): p is NamePart => !!p);
    expect(parts(robin, "common", also)).toEqual({
      primary: common("American Robin"),
      secondary: expected(sci("Turdus migratorius")),
    });
    expect(parts(robin, "scientific", [...also].reverse())).toEqual({
      primary: sci("Turdus migratorius"),
      secondary: expected(common("American Robin")),
    });
  });

  it("leaves out codes a species doesn't have", () => {
    expect(parts(blackbird, "common", ["aba"]).secondary).toEqual([]);
    expect(parts(blackbird, "common", ["other", "aba", "ebird"]).secondary).toEqual([
      sci("Turdus merula"),
      code("eurbla"),
    ]);
    expect(parts(fox, "scientific", ["other", "aba", "ebird"])).toEqual({
      primary: sci("Vulpes vulpes"),
      secondary: [common("Red Fox")],
    });
    expect(parts(fox, "common", ["aba", "ebird"]).secondary).toEqual([]);
  });

  it("leads with the scientific name when there is no common name, never repeating it", () => {
    for (const main of ["common", "scientific"] as const) {
      expect(parts({ scientificName: "Turdus sp." }, main, ["other"])).toEqual({
        primary: sci("Turdus sp."),
        secondary: [],
      });
    }
    expect(
      parts({ scientificName: "Turdus sp.", ebirdCode: "turdus1" }, "common", ["other", "ebird"]).secondary,
    ).toEqual([code("turdus1")]);
  });

  it("styles scientific names italic and codes compact", () => {
    expect(namePartClass(sci("x"))).toBe("italic");
    expect(namePartClass(code("x"))).toContain("uppercase");
    expect(namePartClass(common("x"))).toBe("");
  });
});

describe("normaliseSpeciesNamePrefs", () => {
  it.each([
    [
      { main: "scientific", also: ["ebird", "other"] },
      { main: "scientific", also: ["other", "ebird"] },
    ],
    // The earlier single Second line choice, mapped exactly.
    [
      { first: "scientific", second: "other" },
      { main: "scientific", also: ["other"] },
    ],
    [
      { first: "common", second: "aba" },
      { main: "common", also: ["aba"] },
    ],
    [
      { first: "common", second: "ebird" },
      { main: "common", also: ["ebird"] },
    ],
    [
      { first: "common", second: "none" },
      { main: "common", also: [] },
    ],
    [{ main: "latin", also: [] }, null],
    [{ main: "common" }, null],
    ["common", null],
    [null, null],
  ])("reads %j as %j", (value, expected) => {
    expect(normaliseSpeciesNamePrefs(value)).toEqual(expected);
  });
});

describe("species name preference", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSpeciesNamePrefsCache();
  });
  const stored = () => renderHook(() => useSpeciesNamePrefs()).result.current;

  it("defaults to common, with the scientific name below", () => {
    expect(stored()).toEqual({ main: "common", also: ["other"] });
  });

  it.each([
    ["other", ["other"]],
    ["aba", ["aba"]],
    ["ebird", ["ebird"]],
    ["none", []],
  ])("turns an earlier Second line of %s into Also show %j", (second, also) => {
    localStorage.setItem("lifer:speciesNameFirst", JSON.stringify("scientific"));
    localStorage.setItem("lifer:speciesNameSecond", JSON.stringify(second));
    expect(stored()).toEqual({ main: "scientific", also });
  });

  it("turns the old Hide scientific names toggle into nothing below the name", () => {
    localStorage.setItem("lifer:hideScientificName", "1");
    expect(stored()).toEqual({ main: "common", also: [] });
  });

  it("prefers the current keys over older ones, and ignores junk", () => {
    localStorage.setItem("lifer:hideScientificName", "1");
    localStorage.setItem("lifer:speciesNameSecond", JSON.stringify("aba"));
    localStorage.setItem("lifer:speciesNameAlso", JSON.stringify(["ebird", "bogus"]));
    localStorage.setItem("lifer:speciesNameMain", JSON.stringify("bogus"));
    expect(stored()).toEqual({ main: "common", also: ["ebird"] });
  });

  it("updates every mounted view and persists in display order", () => {
    const a = renderHook(() => useSpeciesName());
    const b = renderHook(() => useSpeciesNamePrefs());
    act(() => setSpeciesNamePrefs({ main: "scientific", also: ["ebird", "other", "ebird"] }));
    expect(a.result.current({ commonName: "Osprey", scientificName: "Pandion haliaetus" })).toBe("Pandion haliaetus");
    expect(b.result.current).toEqual({ main: "scientific", also: ["other", "ebird"] });
    expect(localStorage.getItem("lifer:speciesNameMain")).toBe(JSON.stringify("scientific"));
    expect(localStorage.getItem("lifer:speciesNameAlso")).toBe(JSON.stringify(["other", "ebird"]));
  });

  it("lets a page pin its own choice", () => {
    act(() => setSpeciesNamePrefs({ main: "scientific" }));
    const { result } = renderHook(() => useSpeciesName(DEFAULT_SPECIES_NAME_PREFS));
    expect(result.current({ commonName: "Osprey", scientificName: "Pandion haliaetus" })).toBe("Osprey");
  });
});

describe("the account's saved choice", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSpeciesNamePrefsCache();
    resetSettingsCache();
  });

  const loadWith = async (speciesNameDisplay: SpeciesNamePrefs | null) => {
    vi.spyOn(api, "get").mockResolvedValueOnce({ speciesNameDisplay } as never);
    await act(() => loadSettings());
  };

  it("seeds a browser with no choice of its own", async () => {
    const { result } = renderHook(() => useSpeciesNamePrefs());
    await loadWith({ main: "scientific", also: ["ebird"] });
    expect(result.current).toEqual({ main: "scientific", also: ["ebird"] });
    expect(localStorage.getItem("lifer:speciesNameAlso")).toBe(JSON.stringify(["ebird"]));
  });

  it("never overrides this browser's own choice", async () => {
    setSpeciesNamePrefs({ also: [] });
    await loadWith({ main: "scientific", also: ["ebird"] });
    expect(renderHook(() => useSpeciesNamePrefs()).result.current).toEqual({ main: "common", also: [] });
  });
});
