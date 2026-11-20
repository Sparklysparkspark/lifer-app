// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));

vi.mock("../hooks/useRegions", () => ({
  useRegions: () => ({
    regions: [{ id: "bc", name: "British Columbia", exampleCity: "Victoria" }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const { default: PlaceNameInput } = await import("./PlaceNameInput");

const place = (name: string, count: number, regionName: string | null, inRegion = false) => ({
  name,
  count,
  regionId: regionName ? `r-${regionName}` : null,
  regionName,
  countryName: regionName === "Alberta" ? "Canada" : null,
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  inRegion,
});

function Harness({ regionId, onValue }: { regionId?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <>
      <label htmlFor="p">Place name</label>
      <PlaceNameInput
        id="p"
        value={value}
        regionId={regionId}
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
      />
    </>
  );
}

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((path: string) => {
    const params = new URLSearchParams(path.split("?")[1]);
    const q = params.get("q") ?? "";
    const all = [place("Pigeon Lake", 42, "Alberta", params.has("regionId")), place("Lakeview", 1, null)];
    return Promise.resolve({ places: all.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) });
  });
});
afterEach(cleanup);

describe("PlaceNameInput", () => {
  it("shows each suggestion with its region and photo count, asking for the picked region first", async () => {
    render(<Harness regionId="r-ab" />);
    const input = screen.getByRole("combobox", { name: "Place name" });
    fireEvent.focus(input);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Pigeon Lake · Alberta, Canada · 42 photos",
      "Lakeview · 1 photo",
    ]);
    const params = new URLSearchParams((get.mock.calls[0][0] as string).split("?")[1]);
    expect(params.get("regionId")).toBe("r-ab");
    // A name already used in the picked region stands in for the generic example.
    expect(input.getAttribute("placeholder")).toBe("e.g. Pigeon Lake");
  });

  it("keeps the generic example without a name in the region", async () => {
    render(<Harness />);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByRole("combobox").getAttribute("placeholder")).toBe("e.g. Alexandria");
  });

  it("falls back to the catalog's example city for the region", async () => {
    render(<Harness regionId="bc" />);
    await screen.findByRole("combobox");
    expect(screen.getByRole("combobox").getAttribute("placeholder")).toBe("e.g. Victoria");
  });

  it("picks a suggestion with the keyboard, and Enter keeps a new name as typed", async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByRole<HTMLInputElement>("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "lake" } });
    await vi.waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    // Nothing is highlighted yet, so Enter leaves the typed text alone.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("lake");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("Lakeview");
    expect(onValue).toHaveBeenLastCalledWith("Lakeview");
  });

  it("as a filter, suggests only the region's names and reports a pick apart from typing", async () => {
    const onPick = vi.fn();
    render(
      <PlaceNameInput
        id="f"
        aria-label="Place filter"
        value=""
        onChange={() => {}}
        onPick={onPick}
        regionId="r-ab"
        onlyInRegion
      />,
    );
    const input = screen.getByRole("combobox", { name: "Place filter" });
    fireEvent.focus(input);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Pigeon Lake · Alberta, Canada · 42 photos"]);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.mouseDown(options[0]);
    expect(onPick).toHaveBeenCalledWith("Pigeon Lake");
  });
});
