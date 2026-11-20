// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import Menu, { MenuItems, MenuPanel } from "./Menu";

afterEach(cleanup);
// The menu measures its panel; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

function Harness({ onDelete = () => {} }: { onDelete?: () => void }) {
  const menu = useDropdownMenu();
  return (
    <MemoryRouter>
      <Menu
        trigger="toolbar"
        open={menu.openKey === true}
        onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
        menuRef={menu.ref}
      >
        <MenuPanel>
          <MenuItems
            items={[
              { label: "Delete", onSelect: onDelete, danger: true },
              { label: "Rename", onSelect: () => {} },
              { label: "Share", onSelect: () => {} },
            ]}
          />
        </MenuPanel>
      </Menu>
    </MemoryRouter>
  );
}

describe("Menu", () => {
  it("lists destructive items last, after a separator", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Rename", "Share", "Delete"]);
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("moves between items with arrows, Home, End and a typed letter", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const menu = screen.getByRole("menu");
    const focused = () => document.activeElement?.textContent;
    expect(focused()).toBe("Rename");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toBe("Share");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toBe("Rename");
    fireEvent.keyDown(menu, { key: "End" });
    expect(focused()).toBe("Delete");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(focused()).toBe("Rename");
    fireEvent.keyDown(menu, { key: "d" });
    expect(focused()).toBe("Delete");
  });

  it("keeps one highlight: mouse movement takes focus, and arrow keys move on from it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const menu = screen.getByRole("menu");
    const item = (name: string) => screen.getByRole("menuitem", { name });
    const focused = () => document.activeElement?.textContent;
    fireEvent.mouseMove(item("Share"));
    expect(focused()).toBe("Share");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toBe("Delete");
    // A mouse resting on an item (no movement) doesn't take focus back.
    fireEvent.mouseOver(item("Share"));
    expect(focused()).toBe("Delete");
    // The highlight is focus only, never hover, so the resting item doesn't look chosen too.
    for (const i of screen.getAllByRole("menuitem")) expect(i.className).not.toMatch(/(^|\s)hover:bg/);
  });

  it("closes on Escape and gives focus back to its trigger", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More options" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => void vi.runAllTimers());
    expect(document.activeElement).toBe(trigger);
    vi.useRealTimers();
  });

  it("closes before running the chosen item", () => {
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
