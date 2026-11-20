// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeBeside } from "../hooks/useAnchoredPosition";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import Menu, { MenuItem, MenuPanel } from "./Menu";
import Modal from "./Modal";

afterEach(cleanup);

const view = { width: 800, height: 600 };
const rect = (left: number, top: number, w = 32, h = 24) => new DOMRect(left, top, w, h);

describe("placeBeside", () => {
  it("opens below, right-aligned to the trigger, inside the window", () => {
    const p = placeBeside(rect(700, 100), { width: 200, height: 150 }, view, "right");
    expect(p).toMatchObject({ top: 128, left: 532 });
  });

  it("flips above near the bottom and caps its height to the room there", () => {
    const p = placeBeside(rect(400, 560), { width: 200, height: 900 }, view, "left");
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + Math.min(900, p.maxHeight)).toBeLessThanOrEqual(560);
  });

  it("never leaves the window on either side", () => {
    for (const left of [-50, 0, 790, 900]) {
      const p = placeBeside(rect(left, 50), { width: 300, height: 100 }, view, "left");
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.left + 300).toBeLessThanOrEqual(792);
    }
  });
});

function Harness({ onCloseModal }: { onCloseModal: () => void }) {
  const menu = useDropdownMenu();
  return (
    <Modal open onClose={onCloseModal} title="Versions">
      <Menu
        open={menu.openKey !== null}
        onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
        menuRef={menu.ref}
      >
        <MenuPanel>
          <MenuItem onSelect={() => {}}>Download original</MenuItem>
        </MenuPanel>
      </Menu>
    </Modal>
  );
}

describe("a menu inside a modal", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );

  it("renders on the top layer, not in the scrolling dialog body, and Escape closes it first", () => {
    const onCloseModal = vi.fn();
    render(<Harness onCloseModal={onCloseModal} />);
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    const panel = screen.getByRole("menu");
    expect(screen.getByRole("dialog").contains(panel)).toBe(false);
    expect(panel.closest("[data-menu-layer]")?.parentElement).toBe(document.body);
    expect(panel.style.position).toBe("fixed");

    // A click inside the portaled panel isn't an outside click.
    fireEvent.click(panel);
    expect(screen.queryByRole("menu")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCloseModal).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCloseModal).toHaveBeenCalledOnce();
  });
});
