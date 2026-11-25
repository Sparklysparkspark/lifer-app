// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const open = vi.fn();
vi.mock("../../lib/openExternal", () => ({ openExternal: (u: string) => open(u) }));
let os: "mac" | "windows" | "other" = "mac";
vi.mock("../../lib/platform", () => ({
  get platform() {
    return os;
  },
}));

const { default: WorksWithApps } = await import("./WorksWithApps");
const { setShowSuggestedApps } = await import("../../lib/suggestedApps");

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("works with apps", () => {
  it("lists each app and opens its guide section", () => {
    os = "mac";
    render(<WorksWithApps />);
    expect(screen.getByText("Apple Photos")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guide for Adobe Bridge" }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining("/guides/other-apps-and-keywords#adobe-bridge"));
  });

  it("leaves Apple Photos out on Windows and Linux", () => {
    for (os of ["windows", "other"] as const) {
      render(<WorksWithApps />);
      expect(screen.queryByText("Apple Photos")).toBeNull();
      expect(screen.getByText("Lightroom Classic")).toBeTruthy();
      cleanup();
    }
  });

  it("hides with Show suggested apps", () => {
    os = "mac";
    setShowSuggestedApps(false);
    render(<WorksWithApps />);
    expect(screen.queryByText("Works with")).toBeNull();
  });
});
