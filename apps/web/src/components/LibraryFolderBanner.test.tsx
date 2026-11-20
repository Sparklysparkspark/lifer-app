// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));
const confirm = vi.fn();
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirm }));
const pick = vi.fn();
vi.mock("../lib/pickFolderNative", () => ({ pickFolderNative: (...a: unknown[]) => pick(...a) }));
const change = vi.fn();
vi.mock("../lib/libraryFolderChange", () => ({
  changeLibraryFolder: (...a: unknown[]) => change(...a),
  resumeDownloadsAfterRestart: async () => {},
}));

const { LIBRARY_FOLDER_UNAVAILABLE } = await import("../api/client");
const { default: LibraryFolderBanner } = await import("./LibraryFolderBanner");

const MISSING = {
  ok: false,
  problems: [
    {
      folder: "library",
      path: "/Users/someone/Desktop/Birds",
      problem: "missing",
      message: "Lifer's photo library folder (/Users/someone/Desktop/Birds) is missing.",
    },
  ],
};

let folderStatus: unknown;
let changeable: boolean;
beforeEach(() => {
  folderStatus = MISSING;
  changeable = true;
  sessionStorage.clear();
  get.mockImplementation(async (url: string) =>
    url === "/settings/storage" ? { dataDir: "/x", changeable } : folderStatus,
  );
});
afterEach(() => vi.clearAllMocks());

const title = () => screen.queryByText("Lifer can't save photos right now");

describe("LibraryFolderBanner", () => {
  it("stays hidden while the folder is fine", async () => {
    folderStatus = { ok: true, problems: [] };
    render(<LibraryFolderBanner />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(title()).toBeNull();
  });

  it("is compact: the title and the missing folder, with the full text behind Details", async () => {
    render(<LibraryFolderBanner />);
    await screen.findByText("Lifer can't save photos right now");
    expect(screen.getByText("Birds")).toBeTruthy();
    expect(screen.queryByText(/is missing\.$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/is missing\.$/)).toBeTruthy();
  });

  it("hides on Remind me later until a save fails again", async () => {
    render(<LibraryFolderBanner />);
    await screen.findByText("Lifer can't save photos right now");
    fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
    expect(title()).toBeNull();
    expect(sessionStorage.getItem("lifer-library-folder-dismissed")).toBe("1");
    act(() => void window.dispatchEvent(new Event(LIBRARY_FOLDER_UNAVAILABLE)));
    await screen.findByText("Lifer can't save photos right now");
  });

  it("disappears at once when Check again finds the folder back", async () => {
    render(<LibraryFolderBanner />);
    await screen.findByText("Lifer can't save photos right now");
    folderStatus = { ok: true, problems: [] };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(title()).toBeNull());
  });

  it("says so when Check again finds it still missing", async () => {
    render(<LibraryFolderBanner />);
    await screen.findByText("Lifer can't save photos right now");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText(/Still missing/);
  });

  it("warns about the restart, then applies the chosen folder", async () => {
    confirm.mockResolvedValue(true);
    pick.mockResolvedValue("/Volumes/Photos/Birds");
    change.mockResolvedValue({ kind: "restarting" });
    render(<LibraryFolderBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose new location" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith("/Volumes/Photos/Birds"));
    expect(confirm).toHaveBeenCalledWith({
      title: "Choose your library folder",
      message: "Lifer will restart to use this folder. Anything running (imports, downloads) will pause and resume.",
      confirmLabel: "Choose folder and restart",
    });
  });

  it("does nothing when the restart warning is cancelled", async () => {
    confirm.mockResolvedValue(false);
    render(<LibraryFolderBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose new location" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(pick).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  it("explains instead of restarting while an import is still running", async () => {
    confirm.mockResolvedValue(true);
    pick.mockResolvedValue("/Volumes/Photos/Birds");
    change.mockResolvedValue({ kind: "importsRunning" });
    render(<LibraryFolderBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose new location" }));
    await screen.findByText(/still importing photos/);
  });

  it("offers no folder choice on a server, where the folder is set in its setup", async () => {
    changeable = false;
    render(<LibraryFolderBanner />);
    await screen.findByText("Lifer can't save photos right now");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/settings/storage"));
    expect(screen.queryByRole("button", { name: "Choose new location" })).toBeNull();
  });
});
