// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const start = vi.fn();
vi.mock("../../hooks/useJobPoll", () => ({
  useJobPoll: () => ({ status: null, start, cancel: vi.fn(), starting: false, cancelling: false, actionError: null }),
}));
vi.mock("../../hooks/useDeploymentMode", () => ({ useIsTauri: () => false, useDeploymentMode: () => "server" }));
const pickFolderNative = vi.fn();
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: (...a: unknown[]) => pickFolderNative(...a) }));

const { default: ExportAlbumModal } = await import("./ExportAlbumModal");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderModal() {
  render(
    <ToastContext.Provider value={toast}>
      <ExportAlbumModal albumId="a1" albumName="Birds" onClose={() => {}} />
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ExportAlbumModal", () => {
  it("has no typed path: Export opens the picker and a picked folder starts the copy", async () => {
    localStorage.setItem("lifer:albumExportFolder", "/Volumes/USB");
    pickFolderNative.mockResolvedValue("/Volumes/Frame");
    renderModal();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(pickFolderNative).toHaveBeenCalledWith("/Volumes/USB");
    expect(start.mock.calls[0][1]).toEqual({
      destination: "/Volumes/Frame",
      include: { raw: false, sidecars: false },
      structure: "flat",
      // Off by default, and remembered for next time.
      hideSensitiveLocations: false,
    });
    expect(localStorage.getItem("lifer:albumExportFolder")).toBe("/Volumes/Frame");
    expect(localStorage.getItem("lifer:albumExportHideSensitive")).toBe("0");
  });

  it("remembers hiding sensitive species' locations from the last export", async () => {
    localStorage.setItem("lifer:albumExportHideSensitive", "1");
    pickFolderNative.mockResolvedValue("/Volumes/Frame");
    renderModal();
    const toggle = screen.getByRole("switch", { name: "Hide locations of sensitive species" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0][1]).toMatchObject({ hideSensitiveLocations: true });
  });

  it("cancelling the picker returns to the dialog without exporting", async () => {
    pickFolderNative.mockResolvedValue(null);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(pickFolderNative).toHaveBeenCalled());
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("on a server, picks in the in-app browser and exports from there", async () => {
    pickFolderNative.mockResolvedValue(undefined);
    get.mockResolvedValue({ path: "/exports", parent: null, entries: [] });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    fireEvent.click(await screen.findByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0][1]).toMatchObject({ destination: "/exports" });
  });
});
