// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import type { RegionSummary } from "@lifer/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  realmsOf,
  recentRegionIds,
  regionLabel,
  regionPartOf,
  rememberRegion,
  searchExampleRegion,
  searchRegions,
} from "../lib/regionSearch";

const region = (id: string, name: string, parentId: string | null, scoped = true): RegionSummary => ({
  id,
  name,
  parentId,
  ebirdRegionCode: null,
  boundaryGeoJson: null,
  hasChildren: false,
  hasScopedChecklist: scoped,
  sovereigntyGroup: null,
  isSovereignDependency: false,
});

const REGIONS = [
  region("world", "World", null, false),
  region("na", "North America", "world", false),
  region("asia", "Asia", "world", false),
  region("ca", "Canada", "na"),
  region("us", "United States of America", "na"),
  region("mb", "Manitoba", "ca"),
  region("qc", "Québec", "ca"),
  region("ga-us", "Georgia", "us"),
  region("ga", "Georgia", "asia"),
  region("ny", "New York", "us"),
  // A one-area country whose area shares its name: shown as the country alone.
  region("aw", "Aruba", "na"),
  region("aw-1", "Aruba", "aw"),
];
const byId = new Map(REGIONS.map((r) => [r.id, r]));
const names = (rs: RegionSummary[]) => rs.map((r) => regionLabel(byId, r));

// Hoisted above the fixture, so it reads REGIONS lazily.
vi.mock("../hooks/useRegions", () => ({
  useRegions: () => ({ regions: REGIONS, loading: false, error: null, refresh: vi.fn() }),
}));
const { default: RegionBrowser } = await import("./RegionBrowser");

function Harness({
  suggested,
  restrict,
  initial = null,
}: {
  suggested?: string[];
  restrict?: Set<string>;
  initial?: string | null;
}) {
  const [regionId, setRegionId] = useState<string | null>(initial);
  return (
    <MemoryRouter>
      <RegionBrowser
        regionId={regionId}
        onChange={setRegionId}
        allowAnyRegion
        restrictToIds={restrict}
        suggestedRegionIds={suggested}
      />
      <output data-testid="picked">{regionId}</output>
    </MemoryRouter>
  );
}

const search = () => screen.getByRole("combobox", { name: "Search regions" });
const picked = () => screen.getByTestId("picked").textContent;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("RegionBrowser", () => {
  it("searches every reachable region and picks one with the arrow keys and Enter", () => {
    render(<Harness />);
    fireEvent.change(search(), { target: { value: "georgia" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Georgia",
      "Georgia, part of United States of America",
    ]);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toBe(
      "Georgia, part of United States of America",
    );
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(picked()).toBe("ga-us");
    // Picked like drilling to it: the breadcrumb shows it and the search is cleared.
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("button", { name: "United States of America" })).toBeTruthy();
  });

  // Remembered state (docs/docs/contributing/remembered-state.md): the stored last region.
  it("clears a remembered region that no longer exists or is no longer available", () => {
    render(<Harness initial="deleted-region-id" restrict={new Set(["world", "na", "ca", "mb"])} />);
    expect(picked()).toBe("");
    cleanup();
    render(<Harness initial="ny" restrict={new Set(["world", "na", "ca", "mb"])} />);
    expect(picked()).toBe("");
  });

  it("leaves out regions the picker is restricted from", () => {
    render(<Harness restrict={new Set(["world", "na", "ca", "mb"])} />);
    fireEvent.change(search(), { target: { value: "georgia" } });
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText("No region by that name.")).toBeTruthy();
  });

  it("suggests the caller's regions, then recent picks, skipping the current one and unreachable ones", () => {
    localStorage.setItem("lifer:recentRegions", JSON.stringify(["qc", "mb", "gone"]));
    render(<Harness suggested={["mb", "ga"]} />);
    const chips = () =>
      Array.from(screen.getByText("Suggested:").parentElement!.querySelectorAll("button"), (b) => b.textContent);
    expect(chips()).toEqual(["Manitoba, Canada", "Georgia", "Québec, Canada"]);
    fireEvent.click(screen.getByRole("button", { name: "Georgia" }));
    expect(picked()).toBe("ga");
    expect(chips()).toEqual(["Manitoba, Canada", "Québec, Canada"]);
  });

  it("treats a country's lone same-named area as the country", () => {
    render(<Harness suggested={["aw-1", "aw"]} initial="aw-1" />);
    expect(screen.queryByText("Suggested:")).toBeNull();
    expect(screen.getAllByText("Aruba")).toHaveLength(1);
    expect(screen.queryByText("Drill in:")).toBeNull();
    expect(screen.queryByText(/countries are downloaded yet/)).toBeNull();
    cleanup();
    render(<Harness suggested={["aw-1", "aw"]} />);
    const chips2 = Array.from(
      screen.getByText("Suggested:").parentElement!.querySelectorAll("button"),
      (b) => b.textContent,
    );
    expect(chips2).toEqual(["Aruba"]);
    fireEvent.change(search(), { target: { value: "aruba" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Aruba"]);
  });

  it("shows no suggestions row when there's nothing to suggest, and a plain placeholder", () => {
    render(<Harness />);
    expect(screen.queryByText("Suggested:")).toBeNull();
    expect(search().getAttribute("placeholder")).toBe("Search regions");
  });

  it("gives the region the caller is working in as the search example", () => {
    render(<Harness suggested={["mb"]} />);
    expect(search().getAttribute("placeholder")).toBe("Search regions, e.g. Manitoba");
  });
});

describe("searchRegions", () => {
  it("ignores accents and names provinces with their country", () => {
    expect(names(searchRegions(REGIONS, byId, "quebec", null))).toEqual(["Québec, Canada"]);
    expect(names(searchRegions(REGIONS, byId, "MANI", null))).toEqual(["Manitoba, Canada"]);
  });

  it("puts the country before a province of the same name, and prefix matches before others", () => {
    expect(names(searchRegions(REGIONS, byId, "georgia", null))).toEqual([
      "Georgia",
      "Georgia, United States of America",
    ]);
    // "New York" starts with "new"; nothing else does.
    expect(names(searchRegions(REGIONS, byId, "york", null))).toEqual(["New York, United States of America"]);
    expect(names(searchRegions(REGIONS, byId, "ne", null))[0]).toBe("New York, United States of America");
  });

  it("only finds regions the picker can reach", () => {
    expect(names(searchRegions(REGIONS, byId, "georgia", new Set(["ga-us"])))).toEqual([
      "Georgia, United States of America",
    ]);
  });
});

describe("recent regions", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the last three, most recent first, without duplicates or the ancestors drilled through", () => {
    for (const id of ["world", "na", "ca", "mb"]) rememberRegion(byId, id);
    expect(recentRegionIds()).toEqual(["mb"]);
    for (const id of ["ga", "ny", "ga"]) rememberRegion(byId, id);
    expect(recentRegionIds()).toEqual(["ga", "ny", "mb"]);
    rememberRegion(byId, "qc");
    expect(recentRegionIds()).toEqual(["qc", "ga", "ny"]);
  });

  it("reads a damaged entry as none", () => {
    localStorage.setItem("lifer:recentRegions", "{nope");
    expect(recentRegionIds()).toEqual([]);
  });
});

describe("searchExampleRegion", () => {
  it("takes the first context region with a checklist, skipping World and the continents", () => {
    expect(searchExampleRegion(byId, [null, "world", "ca", "mb"])?.name).toBe("Canada");
    expect(searchExampleRegion(byId, [undefined, "na", "gone"])).toBeNull();
  });
});

describe("aliases, constituent areas and realms", () => {
  const nl: RegionSummary = { ...region("nl", "Netherlands", "na"), aliases: ["Holland"], sovereigntyGroup: "NL1" };
  const aruba: RegionSummary = {
    ...region("aw", "Aruba", "na"),
    sovereigntyGroup: "NL1",
    isSovereignDependency: true,
  };
  const scotland = region("sc", "Scotland", "uk");
  const all = [...REGIONS, nl, aruba, region("uk", "United Kingdom", "na"), scotland];
  const index = new Map(all.map((r) => [r.id, r]));

  it("finds a region by an alias, accents and case ignored", () => {
    expect(searchRegions(all, index, "HOLLAND", null).map((r) => r.name)).toEqual(["Netherlands"]);
  });

  it("says what a province or territory is part of", () => {
    expect(regionPartOf(index, scotland)).toBe("United Kingdom");
    expect(regionPartOf(index, aruba)).toBe("Netherlands");
    expect(regionPartOf(index, nl)).toBeNull();
  });

  it("lists a sovereign's territories as its realms", () => {
    expect(realmsOf(all, nl).map((r) => r.name)).toEqual(["Aruba"]);
    expect(realmsOf(all, aruba)).toEqual([]);
  });

  it("uses a country's most populous province as the search example", () => {
    const ca = { ...region("ca", "Canada", "na"), populousChildId: "mb" };
    const withPopulous = new Map([...index, ["ca", ca]]);
    expect(searchExampleRegion(withPopulous, ["ca"])?.name).toBe("Manitoba");
  });
});
