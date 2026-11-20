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
  downloads: { darwin: { url: "https://dl.example.com/a.dmg", signer: "ABCDE12345" } },
};
const suggested = vi.fn();
const install = vi.fn();
const grant = vi.fn();
const installer = vi.fn();
const setShow = vi.fn();
const open = vi.fn();
vi.mock("../lib/openExternal", () => ({ openExternal: (u: string) => open(u) }));
vi.mock("../lib/suggestedApps", () => ({
  useSuggestedApps: () => suggested(),
  setShowSuggestedApps: (on: boolean) => setShow(on),
  installerFor: () => installer(),
  installSuggestedApp: (...a: unknown[]) => install(...a),
  grantSuggestedApp: (...a: unknown[]) => grant(...a),
  installProgress: () => Promise.resolve({ downloaded: 50, total: 100, running: true }),
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
  installer.mockReturnValue(app.downloads.darwin);
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
    await waitFor(() => expect(install).toHaveBeenCalledWith(app, app.downloads.darwin));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("shows a plain message when the check fails", async () => {
    install.mockRejectedValue("This installer isn't signed by the publisher it should be.");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText(/isn't signed by the publisher/)).toBeTruthy();
  });

  it("says so when there is no installer for this computer, or no such suggestion", () => {
    installer.mockReturnValue(undefined);
    show();
    expect(screen.getByText("Example isn't available for this computer yet.")).toBeTruthy();
    cleanup();
    suggested.mockReturnValue([]);
    show();
    expect(screen.getByText("This suggestion isn't available")).toBeTruthy();
  });

  it("a live Preen offer starts the trial, names the counting host and says the count is anonymous", async () => {
    const live = { url: "https://licence.preenwildlife.com/v1/download/lifer/darwin", signer: "ABCDE12345" };
    installer.mockReturnValue(live);
    suggested.mockReturnValue([{ ...app, offer: "cull" }]);
    install.mockResolvedValue(undefined);
    show();
    expect(screen.getByText(/through licence\.preenwildlife\.com.*nothing that identifies you/)).toBeTruthy();
    expect(screen.getByText("Free 30-day trial for Lifer users")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start free trial" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith(expect.objectContaining({ offer: "cull" }), live));
  });

  it("lists what the app may do next to the button, and the click allows exactly that", async () => {
    const scoped = { ...app, scopes: ["userdata.read", "imports.write"] };
    suggested.mockReturnValue([scoped]);
    grant.mockResolvedValue({});
    install.mockResolvedValue(undefined);
    show();
    expect(screen.getByText(/also lets Example connect to Lifer/)).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Read your life list, targets and seen species, and your own photos",
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
      installer.mockReturnValue({ url: "https://PLACEHOLDER.invalid/x", signer: "PLACEHOLDER", pending: true });
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
