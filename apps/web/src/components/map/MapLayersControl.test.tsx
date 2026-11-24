// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useMapAvailable", () => ({ useMapAvailable: () => true }));

const { default: MapLayersControl } = await import("./MapLayersControl");
const { publishOnlineState, resetOnlineMapPrefs } = await import("../../hooks/useOnlineMap");

afterEach(() => {
  localStorage.clear();
  act(() => resetOnlineMapPrefs());
});

function open() {
  render(<MapLayersControl map={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Map layers" }));
}

describe("MapLayersControl", () => {
  it("starts on Automatic and says what loading detail sends", () => {
    open();
    expect(screen.getAllByRole("button", { name: "Automatic" })[0].getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText(/relief from Mapterhorn, which see the area you view and your IP address. No photos/),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Off" })[0]);
    expect(localStorage.getItem("lifer:photo-map-detail")).toBe('"off"');
    expect(screen.getByText("The map stays offline.")).toBeTruthy();
  });

  it("shows Satellite at once when picked, with its provider and limit, and no prompt", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Satellite" }));
    expect(localStorage.getItem("lifer:photo-map-base")).toBe('"satellite"');
    expect(screen.queryByRole("dialog")).toBeNull();
    // Said once, in the panel: no floating copy over it.
    expect(screen.getAllByText(/Imagery from EOxCloudless/)).toHaveLength(1);
    expect(screen.getByText(/10 m per pixel/)).toBeTruthy();
  });

  it("turns online place search off from the same panel", () => {
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Off" })[1]);
    expect(localStorage.getItem("lifer:places-online")).toBe('"off"');
  });

  it("is a neutral button with a small dot only while online tiles are in use", () => {
    render(<MapLayersControl map={null} />);
    const button = screen.getByRole("button", { name: "Map layers" });
    expect(button.className).not.toMatch(/bg-accent/);
    expect(screen.queryByTestId("layers-online-dot")).toBeNull();
  });

  it("opens its panel on the page, outside a small map, and closes it on Esc", () => {
    const { container } = render(
      <div className="h-40" data-testid="small-map">
        <MapLayersControl map={null} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Map layers" }));
    const panel = screen.getByTestId("map-layers-panel");
    expect(panel.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("map-layers-panel")).toBeNull();
  });

  it("closes when another popover opens", () => {
    render(<MapLayersControl map={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Map layers" }));
    act(() => void window.dispatchEvent(new CustomEvent("lifer:popover-open", { detail: "someone-else" })));
    expect(screen.queryByTestId("map-layers-panel")).toBeNull();
  });

  it("puts the offline line under the button's slot, which stays in place while the button fades", () => {
    const map = {} as never;
    act(() => publishOnlineState(map, { mode: null, failed: true }));
    render(<MapLayersControl map={map} reveal />);
    const line = screen.getByTestId("map-layers-failed");
    const slot = screen.getByRole("button", { name: "Map layers" }).parentElement!;
    // Faded with opacity only, so the slot keeps its space above the line.
    expect(slot.className).toMatch(/opacity-0/);
    expect(slot.className).not.toMatch(/hidden|invisible/);
    // The line sits under the row that holds the slot, never beside it.
    expect(line.previousElementSibling?.contains(slot)).toBe(true);
  });

  it("fades a page's own controls with the button, unclickable while faded but still in the tab order", () => {
    render(<MapLayersControl map={{} as never} reveal />);
    const slot = screen.getByTestId("map-control-slot");
    expect(slot.className).toMatch(/pointer-fine:opacity-0/);
    expect(slot.className).toMatch(/pointer-fine:pointer-events-none/);
    expect(slot.className).toMatch(/pointer-fine:group-hover:pointer-events-auto/);
    // Hidden from the tab order (visibility) would make the first Tab skip Reset view for the layers button.
    expect(slot.className).not.toMatch(/invisible|(^|\s)hidden/);
    // Its own focus-visible (the first Tab into the map) shows the row.
    expect(slot.className).toMatch(/pointer-fine:group-has-\[:focus-visible\]:opacity-100/);
    // A click on the map focuses its canvas; that alone mustn't keep the controls shown.
    expect(slot.className).not.toMatch(/focus-within/);
    expect(screen.getByRole("button", { name: "Map layers" }).parentElement!.className).not.toMatch(/focus-within/);
  });

  it("has one row for a page's own controls, left of the layers button", () => {
    const map = {} as never;
    render(<MapLayersControl map={map} />);
    const slot = screen.getByTestId("map-control-slot");
    const layers = screen.getByRole("button", { name: "Map layers" });
    expect(slot.parentElement?.contains(layers)).toBe(true);
    expect(slot.compareDocumentPosition(layers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
