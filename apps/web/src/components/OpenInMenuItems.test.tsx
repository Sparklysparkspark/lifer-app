// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import OpenInMenuItems from "./OpenInMenuItems";

const openIn = vi.fn();
vi.mock("../hooks/useOpenInEditors", () => ({
  useOpenInEditors: () => ({
    editors: [
      { id: "darktable", name: "darktable" },
      { id: "dxo", name: "DxO PhotoLab" },
    ],
    openIn,
  }),
}));

afterEach(cleanup);

describe("OpenInMenuItems", () => {
  it("opens the RAW in the chosen editor, offers the edited file, and the others under Open with", () => {
    render(<OpenInMenuItems targets={{ photoIds: ["p1"] }} hasEdit />);
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Open in darktable",
      "Open edited file in darktable",
      "Open with DxO PhotoLab",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open edited file in darktable" }));
    expect(openIn).toHaveBeenCalledWith({ id: "darktable", name: "darktable" }, { photoIds: ["p1"], edited: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open with DxO PhotoLab" }));
    expect(openIn).toHaveBeenLastCalledWith({ id: "dxo", name: "DxO PhotoLab" }, { photoIds: ["p1"], edited: false });
  });
});
