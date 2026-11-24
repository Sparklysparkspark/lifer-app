// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import SidePanel from "./SidePanel";
import Lightbox from "./Lightbox";

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

afterEach(cleanup);
// jsdom lays nothing out, so every element would count as hidden to the focus trap.
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get() {
    return this.parentNode;
  },
});

// A list beside the panel, as on the iNaturalist page: each item opens or swaps the panel.
function Page({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  return (
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <button onClick={() => setOpen("Heron")}>Heron</button>
        <button onClick={() => setOpen("Egret")}>Egret</button>
        <SidePanel
          open={open !== null}
          title={open}
          onClose={() => {
            onClose();
            setOpen(null);
          }}
          footer={<button data-primary>Send</button>}
        >
          <button onClick={() => setViewing(true)}>Photo 1</button>
        </SidePanel>
        {viewing && (
          <Lightbox
            slides={[{ url: "/a.jpg", caption: "A" }]}
            index={0}
            onIndexChange={() => {}}
            onClose={() => setViewing(false)}
          />
        )}
      </ToastContext.Provider>
    </MemoryRouter>
  );
}

const panel = () => screen.queryByRole("complementary");

describe("SidePanel", () => {
  it("docks right without a scrim or scroll lock, fills a narrow window, and pins its footer", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("Heron"));
    const el = panel()!;
    expect(el.getAttribute("aria-modal")).toBeNull();
    expect(el.getAttribute("aria-labelledby")).toBeTruthy();
    // Full width below sm, the panel width from sm up.
    expect(el.className).toMatch(/\bw-full\b/);
    expect(el.className).toContain("sm:w-md");
    expect(el.parentElement!.className).toContain("pointer-events-none");
    expect(document.body.style.overflow).toBe("");
    // The footer sits outside the scrolling body, so it stays in view.
    const footer = screen.getByText("Send").closest("div")!.parentElement!;
    expect(footer.className).toContain("shrink-0");
    expect(footer.previousElementSibling!.className).toContain("overflow-y-auto");
  });

  it("swaps its content when another item is clicked, without closing", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("Heron"));
    fireEvent.click(screen.getByText("Egret"));
    expect(screen.getByRole("heading", { name: "Egret" })).toBeTruthy();
  });

  it("traps Tab, closes on Escape and from its close button, and hands focus back to the last item used", () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    const heron = screen.getByText("Heron");
    heron.focus();
    fireEvent.click(heron);
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first control wraps to the last.
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("Send"));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    const egret = screen.getByText("Egret");
    egret.focus();
    fireEvent.click(egret);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(egret);

    fireEvent.click(heron);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(panel()).toBeNull();
  });

  it("lets the viewer open above it, and Escape closes the viewer first", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("Heron"));
    fireEvent.click(screen.getByText("Photo 1"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel()).toBeNull();
  });

  it("with a backdrop it blocks the page like a dialog", () => {
    render(
      <SidePanel open backdrop title="Details" onClose={() => {}}>
        <p>Body</p>
      </SidePanel>,
    );
    expect(screen.getByRole("dialog", { name: "Details" }).getAttribute("aria-modal")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
  });
});
