// @vitest-environment jsdom
// Toolbar popovers and menus: opening one closes the other, even though a menu trigger stops its click.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilterPopover from "../components/FilterPopover";
import Menu, { MenuItems, MenuPanel } from "../components/Menu";
import { useDropdownMenu } from "../hooks/useDropdownMenu";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

function Toolbar() {
  const menu = useDropdownMenu();
  return (
    <>
      <Menu
        open={menu.openKey !== null}
        onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
        menuRef={menu.ref}
      >
        <MenuPanel>
          <MenuItems items={[{ label: "Select none", onSelect: () => {} }]} />
        </MenuPanel>
      </Menu>
      <FilterPopover label="View" activeCount={0}>
        <p>View panel</p>
      </FilterPopover>
      <FilterPopover label="Filters" activeCount={0}>
        <p>Filters panel</p>
      </FilterPopover>
    </>
  );
}

describe("one toolbar popover at a time", () => {
  it("closes the open popover or menu when another opens", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("View panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByText("View panel")).toBeNull();
    expect(screen.getByText("Filters panel")).toBeTruthy();
    // The menu's trigger stops its click, so only the shared signal can close the panel.
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.queryByText("Filters panel")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Select none" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByRole("menuitem", { name: "Select none" })).toBeNull();
  });
});
