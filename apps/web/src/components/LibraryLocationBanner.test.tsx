// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ToastProvider } from "./ToastProvider";
import LibraryLocationBanner from "./LibraryLocationBanner";
import { LIBRARY_LOCATION_CONNECTED } from "../lib/libraryLocations";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
let mode: "desktop" | "server" = "desktop";
vi.mock("../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => mode }));

const home = {
  mountPath: "/Volumes/home",
  name: "home",
  status: "not_connected",
  connectable: true,
  mountedAt: null,
  serverConnected: true,
};

const renderBanner = () =>
  render(
    <ToastProvider>
      <LibraryLocationBanner />
    </ToastProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  mode = "desktop";
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LibraryLocationBanner", () => {
  it("connects a missing share in one click, then tells the pages to look again", async () => {
    get.mockResolvedValue({ locations: [home] });
    let release: (v: unknown) => void = () => {};
    post.mockReturnValue(new Promise((r) => (release = r)));
    const connected = vi.fn();
    window.addEventListener(LIBRARY_LOCATION_CONNECTED, connected);
    renderBanner();
    expect(await screen.findByText(/Photos on "home" can't be opened/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: 'Connect "home"' }));
    expect(post).toHaveBeenCalledWith("/storage-volumes/library-locations/connect", { mountPath: "/Volumes/home" });
    // Only the button waits while the OS mounts; the page stays usable.
    expect(await screen.findByText(/may ask for the share's password/)).toBeTruthy();
    get.mockResolvedValue({ locations: [{ ...home, status: "connected" }] });
    release({ ...home, status: "connected" });
    expect(await screen.findByText('"home" is connected.')).toBeTruthy();
    expect(connected).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.queryByText(/Photos on "home"/)).toBeNull());
    window.removeEventListener(LIBRARY_LOCATION_CONNECTED, connected);
  });

  it("says so when connecting fails", async () => {
    get.mockResolvedValue({ locations: [home] });
    post.mockResolvedValue(home);
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: 'Connect "home"' }));
    expect(await screen.findByText(/Couldn't connect "home"/)).toBeTruthy();
  });

  it("never shows a share again once dismissed", async () => {
    get.mockResolvedValue({ locations: [home] });
    const first = renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Don't show again" }));
    expect(screen.queryByText(/Photos on "home"/)).toBeNull();
    first.unmount();
    renderBanner();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Photos on "home"/)).toBeNull();
  });

  it("offers no Connect for a share whose address Lifer doesn't know, and nothing on a server", async () => {
    get.mockResolvedValue({ locations: [{ ...home, connectable: false }] });
    renderBanner();
    expect(await screen.findByText(/Photos on "home"/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: 'Connect "home"' })).toBeNull();
    cleanup();
    mode = "server";
    renderBanner();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
