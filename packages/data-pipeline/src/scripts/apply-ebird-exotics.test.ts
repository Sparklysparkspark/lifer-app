import { describe, expect, it } from "vitest";
import { classifyExotic, mergeSnapshots, wildRanges, withReintroduced } from "./apply-ebird-exotics.js";

describe("classifyExotic", () => {
  it("lets one native observation outweigh exotic ones", () => {
    expect(classifyExotic("-NX")).toBe("native");
  });

  it("ranks Naturalized over Provisional over Escapee", () => {
    expect(classifyExotic("NPX")).toBe("naturalized");
    expect(classifyExotic("PX")).toBe("provisional");
    expect(classifyExotic("X")).toBe("escapee");
  });

  it("has no status without observations", () => {
    expect(classifyExotic("")).toBeNull();
  });
});

describe("mergeSnapshots", () => {
  it("pools every window, so a native sighting in one keeps an Escapee in another", () => {
    const { cats, sci } = mergeSnapshots({
      "2026-01-10": { native: ["muscov"], exotic: { budger: { sci: "Melopsittacus undulatus", cats: "X" } } },
      "2026-06-10": { native: [], exotic: { muscov: { sci: "Cairina moschata", cats: "X" }, budger: { sci: "Melopsittacus undulatus", cats: "X" } } },
    });
    expect(classifyExotic(cats.get("muscov")!)).toBe("native");
    expect(classifyExotic(cats.get("budger")!)).toBe("escapee");
    expect(sci.get("Melopsittacus undulatus")).toBe("budger");
  });
});

describe("wildRanges", () => {
  it("places a cage bird where it lives wild or naturalized, not where it only escapes", () => {
    const regions = new Map([
      ["US-FL", { cats: new Map([["chifla1", "X"], ["mutswa", "X"]]) }],
      ["US-NY", { cats: new Map([["mutswa", "N"]]) }],
      ["CL-AN", { cats: new Map([["chifla1", "-"]]) }],
    ]);
    const { escapeeSomewhere, wildAt } = wildRanges(regions);
    expect([...escapeeSomewhere].sort()).toEqual(["chifla1", "mutswa"]);
    expect(wildAt.get("chifla1")).toEqual(["CL-AN"]);
    expect(wildAt.get("mutswa")).toEqual(["US-NY"]);
  });
});

describe("withReintroduced", () => {
  it("keeps a reintroduced native native, whatever eBird calls it", () => {
    const turkey = { region_id: "on", species_id: "wiltur" };
    const finch = { region_id: "on", species_id: "houfin" };
    const by = withReintroduced({ native: [], naturalized: [turkey, finch], provisional: [], escapee: [] }, new Set(["on|wiltur"]));
    expect(by.native).toEqual([turkey]);
    expect(by.naturalized).toEqual([finch]);
  });
});
