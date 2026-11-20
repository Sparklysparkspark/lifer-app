// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageList } from "./ManageListPage";

afterEach(cleanup);
// The "⋯" menu measures its panel; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const rows = (n: number, section?: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => ({ key: `r${i}`, primary: `Row ${i}`, section: section?.(i) }));

describe("ManageList", () => {
  it("renders a long list a page at a time", () => {
    render(
      <MemoryRouter>
        <ManageList label="Places" rows={rows(450)} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(200);
    fireEvent.click(screen.getByRole("button", { name: "Show 200 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(400);
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(450);
    expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
  });

  it("groups consecutive rows of a section under one heading", () => {
    render(
      <MemoryRouter>
        <ManageList label="Archived" rows={rows(5, (i) => (i < 3 ? "Anatidae" : "Corvidae"))} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Anatidae 3", "Corvidae 2"]);
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });

  it("opens the same menu from right-click, with the destructive item last", () => {
    let removed = false;
    render(
      <MemoryRouter>
        <ManageList
          label="Tags"
          rows={[
            {
              key: "a",
              primary: "flight",
              menu: [
                { label: "Delete", danger: true, onSelect: () => (removed = true) },
                { label: "Rename", onSelect: () => {} },
              ].reverse(),
            },
          ]}
        />
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByRole("listitem"));
    const items = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(items).toEqual(["Rename", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(removed).toBe(true);
  });
});
