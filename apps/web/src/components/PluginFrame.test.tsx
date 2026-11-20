// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@lifer/shared";
import PluginFrame from "./PluginFrame";
import { ToastProvider } from "./ToastProvider";
import { ThemeContext } from "../hooks/useTheme";
import { usePluginTitle } from "../lib/pluginHost";

const ORIGIN = "http://127.0.0.1:5123";
const plugin: PluginSummary = {
  id: "com.example.app",
  name: "Example",
  page: { label: "Example", icon: "M0 0", accent: "#336699", surface: "default" },
  scopes: [],
  capabilities: ["notifications"],
  approved: true,
};

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function Title() {
  return <p data-testid="title">{usePluginTitle(plugin.id) ?? ""}</p>;
}

function renderFrame() {
  render(
    <ThemeContext.Provider value={{ theme: "light", preference: "light", setPreference: () => {} }}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/apps/com.example.app"]}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <PluginFrame
                    plugin={plugin}
                    endpoint={{ origin: ORIGIN, pageUrl: "about:blank", pageToken: "tok" }}
                    title="Example"
                    visible
                  />
                  <Where />
                  <Title />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ThemeContext.Provider>,
  );
  const frame = document.querySelector("iframe")!;
  return (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: ORIGIN, source: frame.contentWindow }));
    });
}

afterEach(() => vi.restoreAllMocks());

describe("PluginFrame host wiring", () => {
  it("collapses a burst of 100 notices into one", async () => {
    const send = renderFrame();
    for (let i = 1; i <= 100; i++) send({ lifer: 1, type: "notify", payload: { title: `Card ${i} done` } });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const notices = screen.getAllByText(/Example: /);
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain("100 new notices");
    expect(notices[0].textContent).toContain("Card 100 done");
  });

  it("forwards Mod+1 to Collection and shows the page's title", async () => {
    const send = renderFrame();
    // No shell bridge here, so the host takes Windows and Linux chords (Ctrl).
    const mac = false;
    send({ lifer: 1, type: "title", payload: { text: "Card import" } });
    send({
      lifer: 1,
      type: "shortcut",
      payload: { key: "2", code: "Digit2", meta: mac, ctrl: !mac, alt: false, shift: false },
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByTestId("title").textContent).toBe("Card import");
    expect(screen.getByTestId("where").textContent).toBe("/gallery");
    send({
      lifer: 1,
      type: "shortcut",
      payload: { key: "1", code: "Digit1", meta: mac, ctrl: !mac, alt: false, shift: false },
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByTestId("where").textContent).toBe("/");
  });
});
