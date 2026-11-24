// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFormatLocale } from "../lib/format";
import PhotoGrid from "./PhotoGrid";

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
