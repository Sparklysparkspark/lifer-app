// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import PhotoEditorRow from "./PhotoEditorRow";

const choose = vi.fn();
const pickOther = vi.fn(async () => {});
vi.mock("../../hooks/useOpenInEditors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useOpenInEditors")>()),
  useOpenInEditors: () => ({
    editors: [
      { id: "lightroom-classic", name: "Lightroom Classic" },
      { id: "darktable", name: "darktable" },
      { id: "system", name: "System default" },
    ],
    choose,
    pickOther,
  }),
}));

afterEach(cleanup);

describe("PhotoEditorRow", () => {
  it("shows the editor in use, and lists the others, the system default and Other…", () => {
    render(<PhotoEditorRow />);
    const select = screen.getByRole("combobox", { name: "Edit photos with" }) as HTMLSelectElement;
    expect(select.value).toBe("lightroom-classic");
    expect([...select.options].map((o) => o.text)).toEqual([
      "Lightroom Classic",
      "darktable",
      "System default",
      "Other…",
    ]);
    fireEvent.change(select, { target: { value: "darktable" } });
    expect(choose).toHaveBeenCalledWith("darktable");
    fireEvent.change(select, { target: { value: "__pick" } });
    expect(pickOther).toHaveBeenCalledTimes(1);
  });
});
