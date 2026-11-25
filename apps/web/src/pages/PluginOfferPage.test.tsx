// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = {
  id: "com.example.offer",
  name: "Example",
  description: "Does a thing.",
  publisher: "Example Co",
  homepage: "https://example.com",
  label: "Example",
  icon: "M0 0h1v1z",
};
const live = { host: "dl.example.com", pending: false };
const suggested = vi.fn();
const install = vi.fn();
const grant = vi.fn();
const installer = vi.fn();
const targetKey = vi.fn();
const setShow = vi.fn();
const open = vi.fn();
const detect = vi.fn();
const openStandalone = vi.fn();
const plugins = vi.fn();
const progress = vi.fn();
vi.mock("../lib/openExternal", () => ({ openExternal: (u: string) => open(u) }));
vi.mock("../lib/plugins", () => ({ usePlugins: () => plugins(), pluginPath: (id: string) => `/apps/${id}` }));
vi.mock("../lib/suggestedApps", async (importOriginal) => ({
  installErrorKey: (await importOriginal<typeof import("../lib/suggestedApps")>()).installErrorKey,
  SUGGESTED_APPS: [app],
  detectInstalled: (id: string) => detect(id),
  openInstalled: (id: string) => openStandalone(id),
  useSuggestedApps: () => suggested(),
  setShowSuggestedApps: (on: boolean) => setShow(on),
  installerFor: () => installer(),
  isIntelMac: (t: string | null) => t === "darwin-x86_64",
  useTargetKey: () => targetKey(),
  installSuggestedApp: (...a: unknown[]) => install(...a),
  grantSuggestedApp: (...a: unknown[]) => grant(...a),
  installProgress: () => progress(),
  cancelInstall: () => Promise.resolve(),
}));
vi.mock("../components/AppSidebar", () => ({ useSidebarLayout: () => false }));

const { default: PluginOfferPage } = await import("./PluginOfferPage");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const show = () =>
  render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter initialEntries={["/apps/offer/com.example.offer"]}>
        <Routes>
          <Route path="/apps/offer/:id" element={<PluginOfferPage />} />
        </Routes>
      </MemoryRouter>
    </ToastContext.Provider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  suggested.mockReturnValue([app]);
  installer.mockReturnValue(live);
  targetKey.mockReturnValue("darwin-aarch64");
  detect.mockResolvedValue(null);
  plugins.mockReturnValue([]);
  progress.mockResolvedValue({ downloaded: 50, total: 100, running: true, stage: "downloading" });
});
afterEach(cleanup);

describe("PluginOfferPage", () => {
  it("says what it downloads and from where, and downloads nothing until Install", () => {
    show();
    expect(screen.getByText(/dl\.example\.com/)).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });

  it("installs on Install and tells the user", async () => {
    install.mockResolvedValue(undefined);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith(app));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getByText("Finish in the installer, then come back here to open Example.")).toBeTruthy();
  });

  it.each([
    ["verification", "The download didn't match what the publisher signed. Nothing was installed."],
    ["offline", "Couldn't reach the download. Check your connection and try again."],
    ["space", "There isn't enough free space for the download. Free some space and try again."],
    ["blocked", "Your system wouldn't open the installer. Get Example from the publisher's website instead."],
    ["not-set-up", "This app's publisher details are not set up yet."],
    ["something odd", "Couldn't install Example"],
  ])("words the %s failure plainly and offers the website", async (code, text) => {
    install.mockRejectedValue(code);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download from the publisher's website instead" }));
    expect(open).toHaveBeenCalledWith("https://example.com");
  });

  it("a cancel needs no message", async () => {
    install.mockRejectedValue("cancelled");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(screen.queryByText(/Couldn't/)).toBeNull();
  });

  it("shows the three steps with the current one marked", async () => {
    install.mockReturnValue(new Promise(() => undefined));
    progress.mockResolvedValue({ downloaded: 100, total: 100, running: true, stage: "verifying" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const current = await screen.findByText("Check the publisher's signatures", { selector: "li" });
    await waitFor(() => expect(current.getAttribute("aria-current")).toBe("step"));
    expect(screen.getByText("Download Example")).toBeTruthy();
    expect(screen.getByText("Open the installer")).toBeTruthy();
  });

  it("offers Open instead of Install when a signed copy is already installed", async () => {
    detect.mockResolvedValue("/Applications/Example.app/Contents/MacOS/example");
    openStandalone.mockResolvedValue(undefined);
    show();
    expect(await screen.findByText("Example is already installed on this computer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Example" }));
    await waitFor(() => expect(openStandalone).toHaveBeenCalledWith(app.id));
  });

  it("once the app is installed, Open goes to its page", () => {
    suggested.mockReturnValue([]);
    plugins.mockReturnValue([{ id: app.id }]);
    show();
    expect(screen.getByText("Example is installed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Example" })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });

  it("tells an Intel Mac the app runs on the CPU only, and nobody else", () => {
    const note = "On this Mac the app runs on the CPU only, so it is slower than on a Mac with Apple silicon.";
    show();
    expect(screen.queryByText(note)).toBeNull();
    cleanup();
    targetKey.mockReturnValue("darwin-x86_64");
    show();
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("says so when there is no installer for this computer, or no such suggestion", () => {
    installer.mockReturnValue(undefined);
    show();
    expect(screen.getByText("Example isn't available for this computer yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download from the publisher's website instead" })).toBeTruthy();
    cleanup();
    suggested.mockReturnValue([]);
    show();
    expect(screen.getByText("This suggestion isn't available")).toBeTruthy();
  });

  it("a live Preen offer starts the trial, names the counting host and says the count is anonymous", async () => {
    installer.mockReturnValue({ host: "updates.preenwildlife.com", pending: false });
    suggested.mockReturnValue([{ ...app, offer: "cull" }]);
    install.mockResolvedValue(undefined);
    show();
    expect(screen.getByText(/through updates\.preenwildlife\.com.*nothing that identifies you/)).toBeTruthy();
    expect(screen.getByText("Free 30-day trial for Lifer users")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start free trial" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith(expect.objectContaining({ offer: "cull" })));
  });

  it("lists what the app may do next to the button, and the click allows exactly that", async () => {
    const scoped = { ...app, scopes: ["userdata.read", "imports.write"] };
    suggested.mockReturnValue([scoped]);
    grant.mockResolvedValue({});
    install.mockResolvedValue(undefined);
    show();
    expect(screen.getByText(/also lets Example connect to Lifer/)).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "See your life list, targets, seen species and your own photos",
      "Import photos into your library",
    ]);
    expect(grant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(grant).toHaveBeenCalledWith(scoped);
    expect(grant.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]);
  });

  it("still installs when the grant fails; the app then asks in the usual dialog", async () => {
    suggested.mockReturnValue([{ ...app, scopes: ["userdata.read"] }]);
    grant.mockRejectedValue(new Error("no"));
    install.mockResolvedValue(undefined);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  describe("a placeholder offer", () => {
    beforeEach(() => {
      installer.mockReturnValue({ host: "updates.preenwildlife.com", pending: true });
      suggested.mockReturnValue([{ ...app, offer: "cull", homepage: "https://preenwildlife.com" }]);
    });

    it.each([
      ["en-GB", "Then a £99 one-time licence, VAT included, no subscription"],
      ["de-DE", "Then a €99 one-time licence, VAT included, no subscription"],
    ])("shows one price for %s", (lang, text) => {
      vi.spyOn(navigator, "language", "get").mockReturnValue(lang);
      show();
      expect(screen.getByText(text)).toBeTruthy();
      vi.restoreAllMocks();
    });

    it("shows the trial disabled as Available soon, still opens Learn more, and requests nothing before a press", () => {
      show();
      expect(open).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      const soon = screen.getByRole("button", { name: "Available soon" }) as HTMLButtonElement;
      expect(soon.disabled).toBe(true);
      expect(screen.getByText("Then a $99 one-time licence, no subscription")).toBeTruthy();
      expect(screen.queryByText(/counts each download/)).toBeNull();
      fireEvent.click(soon);
      expect(install).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
      expect(open).toHaveBeenCalledWith("https://preenwildlife.com");
    });

    it("Hide turns suggestions off and leaves the page", () => {
      show();
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(setShow).toHaveBeenCalledWith(false);
    });
  });
});
