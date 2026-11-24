// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
await import("../i18n");
const { default: AreaPills } = await import("./AreaPills");

const areas = [
  { id: "al", name: "Alabama" },
  { id: "fl", name: "Florida" },
  { id: "ak", name: "Alaska" },
];

describe("AreaPills", () => {
  it("stays alphabetical when every area fits, even with your photos in one", () => {
    render(<AreaPills label="Areas" areas={areas} withPhotos={new Set(["fl"])} onPick={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Alabama", "Alaska", "Florida"]);
  });

  it("is alphabetical before your places are known", () => {
    render(<AreaPills label="Areas" areas={areas} withPhotos={null} onPick={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Alabama", "Alaska", "Florida"]);
  });
});

describe("AreaPills overflow", () => {
  it("caps a long list at two rows with a +N more list, and needs no label", () => {
    // Five pills to a row: each pill's (and "+ N more"'s) top follows its place in the row.
    const spy = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const items = [...(this.parentElement?.children ?? [])].filter(
        (c) => c.tagName !== "SPAN" || c.hasAttribute("data-area-pill"),
      );
      return Math.floor(items.indexOf(this) / 5) * 30;
    });
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: `State ${String(i).padStart(2, "0")}` }));
    const { container } = render(<AreaPills areas={many} onPick={() => {}} />);
    expect(container.querySelectorAll("[data-area-pill]")).toHaveLength(9);
    expect(screen.getByRole("button", { name: "+ 41 more" })).toBeTruthy();
    // No label: the row starts with the first pill.
    expect(container.firstElementChild!.firstElementChild!.hasAttribute("data-area-pill")).toBe(true);
    spy.mockRestore();
  });
});
