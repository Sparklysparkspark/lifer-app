// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFormatLocale } from "../lib/format";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: async () => ({ counts: { p1: 3, p2: 1 } }) },
}));
// Every tile at once: jsdom has no layout to measure rows with.
vi.mock("./MasonryGrid", () => ({
  default: <T,>(p: { items: T[]; keyFor: (i: T) => string; renderItem: (i: T, r: number) => ReactNode }) =>
    p.items.map((item) => <div key={p.keyFor(item)}>{p.renderItem(item, 1.5)}</div>),
}));

const { default: PhotoGrid } = await import("./PhotoGrid");

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  setFormatLocale(undefined);
});

describe("PhotoGrid group heading", () => {
  it("counts a group in the app's language, not the browser's", () => {
    setFormatLocale("de-DE");
    const items = Array.from({ length: 1200 }, (_, i) => `p${i}`);
    render(
      <PhotoGrid
        items={items}
        idFor={(p) => p}
        tileFor={(p) => ({ photoId: p, alt: p })}
        columnWidth={200}
        groups={[
          {
            key: "g",
            label: "June",
            entries: items.map((item, i) => ({ item, i })),
            collapsed: true,
            onToggle: () => {},
          },
        ]}
        select={{ selectMode: false, selectedIds: new Set(), toggle: () => {} }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /June/ }).textContent).toContain("(1.200)");
  });
});

describe("PhotoGrid version labels", () => {
  const grid = () =>
    render(
      <PhotoGrid
        items={["p1", "p2", "p3"]}
        idFor={(p) => p}
        tileFor={(p) => ({ photoId: p, alt: p, versionLabel: p === "p3" ? "Print 8x10" : undefined })}
        columnWidth={200}
        select={{ selectMode: false, selectedIds: new Set(), toggle: () => {} }}
        onOpen={() => {}}
      />,
    );

  it("shows the stack badge and a version's name until turned off, and remembers that", async () => {
    const { useVersionLabels } = await import("../lib/photoVersions");
    let set: (on: boolean) => void = () => {};
    function Toggle() {
      set = useVersionLabels()[1];
      return null;
    }
    render(<Toggle />);
    grid();
    expect(await screen.findByText("3 versions")).toBeTruthy();
    // A count of 1 (a RAW behind its edit) has no badge.
    expect(screen.queryByText("1 version")).toBeNull();
    expect(screen.getByText("Print 8x10")).toBeTruthy();

    act(() => set(false));
    await waitFor(() => expect(screen.queryByText("3 versions")).toBeNull());
    expect(screen.queryByText("Print 8x10")).toBeNull();
    expect(localStorage.getItem("lifer:showVersionLabels")).toBe("false");
    act(() => set(true));
    expect(localStorage.getItem("lifer:showVersionLabels")).toBe("true");
  });

  it("reads a saved choice, and unreadable storage as on", async () => {
    const labelled = async () => {
      const { default: Fresh } = await import("./PhotoGrid");
      cleanup();
      render(
        <Fresh
          items={["p3"]}
          idFor={(p) => p}
          tileFor={(p) => ({ photoId: p, alt: p, versionLabel: "Print 8x10" })}
          columnWidth={200}
          select={{ selectMode: false, selectedIds: new Set(), toggle: () => {} }}
          onOpen={() => {}}
        />,
      );
      return screen.queryByText("Print 8x10") != null;
    };
    localStorage.setItem("lifer:showVersionLabels", "false");
    vi.resetModules();
    expect(await labelled()).toBe(false);

    vi.resetModules();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await import("../lib/photoVersions");
    getItem.mockRestore();
    expect(await labelled()).toBe(true);
    localStorage.removeItem("lifer:showVersionLabels");
  });
});
