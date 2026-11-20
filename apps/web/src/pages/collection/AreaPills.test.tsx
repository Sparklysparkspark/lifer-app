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
await import("../../i18n");
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
