// @vitest-environment jsdom
// The house components have no axe violations. jsdom can't judge colour contrast or layout, so
// those rules are off here; the Playwright axe spec (e2e/tests/a11y.spec.ts) runs in a browser.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import Button, { IconButton } from "./Button";
import Menu, { MenuItems, MenuPanel } from "./Menu";
import Modal from "./Modal";
import Select from "./Select";
import Switch from "./Switch";
import TextField from "./TextField";

afterEach(cleanup);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

function MenuHarness() {
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
              { label: "Rename", onSelect: () => {} },
              { label: "Delete", onSelect: () => {}, danger: true },
            ]}
          />
        </MenuPanel>
      </Menu>
    </MemoryRouter>
  );
}

describe("axe", () => {
  it("sees a problem when there is one", async () => {
    render(<button type="button" />);
    expect(await violations()).toEqual([expect.stringContaining("button-name")]);
  });

  it("buttons, fields and switches", async () => {
    render(
      <main>
        <Button>Save</Button>
        <IconButton aria-label="Close" tooltip={{ shortcut: "Esc" }}>
          x
        </IconButton>
        <TextField aria-label="Name" />
        <Select label="Sort">
          <option>Newest</option>
        </Select>
        <Switch checked label="Show names" onChange={() => {}} />
      </main>,
    );
    expect(await violations()).toEqual([]);
  });

  it("a shown tooltip", async () => {
    render(
      <IconButton aria-label="Close" tooltip={{ label: "Close", shortcut: "Esc" }}>
        x
      </IconButton>,
    );
    // jsdom has no :focus-visible, so hover opens it.
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Close" }), { pointerType: "mouse" });
    await screen.findByRole("tooltip", {}, { timeout: 3000 });
    expect(await violations()).toEqual([]);
  });

  it("an open menu", async () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it("a modal with a title, description, field and footer", async () => {
    render(
      <Modal
        open
        onClose={() => {}}
        title="Rename"
        description="Pick a new name."
        footer={<button type="submit">Save</button>}
      >
        <TextField aria-label="Name" />
      </Modal>,
    );
    expect(await violations()).toEqual([]);
  });
});
