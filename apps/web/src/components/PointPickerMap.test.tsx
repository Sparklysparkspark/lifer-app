// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("../hooks/useMapAvailable", () => ({ useMapAvailable: () => false }));
// Never built without the map; mocked so jsdom needn't load it.
vi.mock("maplibre-gl", () => ({ Map: vi.fn(), Marker: vi.fn(), setWorkerUrl: vi.fn(), addProtocol: vi.fn() }));

const { default: PointPickerMap } = await import("./PointPickerMap");
afterEach(cleanup);

function Path() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

describe("PointPickerMap", () => {
  it("says the map isn't downloaded and offers the download, never an empty box", () => {
    render(
      <MemoryRouter>
        <PointPickerMap point={null} onPick={() => {}} />
        <Path />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("point-picker-map")).toBeNull();
    expect(screen.getByText(/Download the offline map to pick a spot/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download map" }));
    expect(screen.getByTestId("path").textContent).toBe("/settings/species/downloads");
  });
});
