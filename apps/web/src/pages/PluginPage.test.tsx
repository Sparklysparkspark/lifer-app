// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ToastProvider";
import { ThemeContext } from "../hooks/useTheme";

vi.mock("../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => "desktop" }));
vi.mock("../components/AppSidebar", () => ({ useSidebarLayout: () => true }));

const { default: PluginPage } = await import("./PluginPage");
const { default: PluginFrames } = await import("../components/PluginFrames");

const endpoint = { origin: "http://127.0.0.1:50001", pageUrl: "http://127.0.0.1:50001/", pageToken: "secret" };
const plugin = (id: string, label = "Field Kit", surface = "default") => ({
  id,
  name: label,
  page: { label, icon: "M0 0h4", accent: "#33aa77", surface },
  scopes: [],
  capabilities: [] as string[],
  approved: true,
});

let plugins: ReturnType<typeof plugin>[] = [];
let status: { state: string; endpoint: unknown; error: string | null };
const start = vi.fn();
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "plugins_list") return plugins;
  if (cmd === "plugin_status") return status;
  if (cmd === "plugin_start") return start();
  throw new Error(cmd);
});

afterEach(cleanup);
beforeEach(() => {
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
  invoke.mockClear();
  start.mockReset();
});

function open(id: string, path = `/apps/${id}`) {
  render(
    <ThemeContext.Provider value={{ theme: "light", preference: "light", setPreference: () => {} }}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Link to="/">Away</Link>
          <Link to="/apps/com.example.kept">Back</Link>
          <Routes>
            <Route path="/apps/:id" element={<PluginPage />} />
            <Route path="*" element={<p>Elsewhere</p>} />
          </Routes>
          <PluginFrames />
        </MemoryRouter>
      </ToastProvider>
    </ThemeContext.Provider>,
  );
}

const starts = () => invoke.mock.calls.filter(([cmd]) => cmd === "plugin_start").length;

describe("PluginPage", () => {
  it("starts an app that was never started and frames it with a narrow sandbox", async () => {
    plugins = [plugin("com.example.fresh")];
    status = { state: "stopped", endpoint: null, error: null };
    start.mockResolvedValue(endpoint);
    open("com.example.fresh");
    const frame = await screen.findByTitle("Field Kit");
    expect(starts()).toBe(1);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-downloads");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    // The token reaches the page only as a `credential` message.
    expect(frame.getAttribute("src")).toBe(endpoint.pageUrl);
    expect(frame.getAttribute("src")).not.toContain("secret");
  });

  it("never restarts a stopped app by itself, only on Restart", async () => {
    plugins = [plugin("com.example.crashed")];
    status = { state: "stopped", endpoint: null, error: "It stopped twice." };
    start.mockResolvedValue(endpoint);
    open("com.example.crashed");
    expect(await screen.findByText("It stopped twice.")).toBeTruthy();
    expect(starts()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await screen.findByTitle("Field Kit");
    expect(starts()).toBe(1);
  });

  it("shows why a start failed with a way to try again", async () => {
    plugins = [plugin("com.example.fails")];
    status = { state: "stopped", endpoint: null, error: null };
    start.mockRejectedValue("You didn't allow it.");
    open("com.example.fails");
    expect(await screen.findByText("You didn't allow it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("shows a running app at once and offers the dark surface", async () => {
    plugins = [plugin("com.example.running", "Field Kit", "dark")];
    status = { state: "running", endpoint, error: null };
    open("com.example.running");
    const frame = await screen.findByTitle("Field Kit");
    expect(frame.closest(".dark")).not.toBeNull();
    expect(starts()).toBe(0);
  });

  it("keeps the frame, and its state, while the user is on another page", async () => {
    plugins = [plugin("com.example.kept")];
    status = { state: "running", endpoint, error: null };
    open("com.example.kept");
    // Earlier tests' apps are still started (the store is module-wide), so wait for this one's frame.
    const frame = await waitFor(() => {
      const f = screen.getByTitle("Field Kit");
      expect(f.closest("[hidden]")).toBeNull();
      return f;
    });
    act(() => void fireEvent.click(screen.getByText("Away")));
    expect(await screen.findByText("Elsewhere")).toBeTruthy();
    expect(frame.isConnected).toBe(true);
    expect(frame.closest("[hidden]")).not.toBeNull();
    act(() => void fireEvent.click(screen.getByText("Back")));
    await waitFor(() => expect(frame.closest("[hidden]")).toBeNull());
    expect(screen.getByTitle("Field Kit")).toBe(frame);
  });

  it("opens an app that asks for it in the background, out of sight, unless the user turned that off", async () => {
    localStorage.setItem("lifer:noBackgroundApps", JSON.stringify(["com.example.off"]));
    try {
      plugins = [
        { ...plugin("com.example.early"), capabilities: ["background"] },
        { ...plugin("com.example.off", "Off"), capabilities: ["background"] },
        { ...plugin("com.example.unasked", "Unasked"), capabilities: ["background"], approved: false },
      ];
      status = { state: "stopped", endpoint: null, error: null };
      start.mockResolvedValue(endpoint);
      open("com.example.early", "/");
      await screen.findByText("Elsewhere");
      expect(starts()).toBe(0);
      const frame = await screen.findByTitle("Field Kit", undefined, { timeout: 5_000 });
      expect(frame.closest("[hidden]")).not.toBeNull();
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "plugin_start")).toEqual([
        ["plugin_start", { id: "com.example.early", background: true }],
      ]);
    } finally {
      localStorage.removeItem("lifer:noBackgroundApps");
    }
  }, 10_000);

  it("says so when the app isn't installed", async () => {
    plugins = [];
    open("com.example.gone");
    expect(await screen.findByText("This app isn't installed")).toBeTruthy();
    await waitFor(() => expect(starts()).toBe(0));
  });
});
