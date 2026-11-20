// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: async () => "/Volumes/NAS/Costa Rica" }));

const { default: TripFilesDialog } = await import("./TripFilesDialog");
const { default: TripFileMoveTray, TRIP_FILE_MOVE_STARTED } = await import("../../components/TripFileMoveTray");
const { ToastContext } = await import("../../hooks/useToast");

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const wrap = (ui: React.ReactNode) => render(<ToastContext.Provider value={toast}>{ui}</ToastContext.Provider>);
const check = {
  folder: "/Volumes/NAS/Costa Rica",
  files: 2,
  bytes: 3_000_000,
  neededBytes: 3_000_000,
  freeBytes: 9e9,
  alreadyThere: 0,
  notManaged: 1,
  outside: 0,
  missing: 0,
  problem: null,
  message: null,
};
const idle = {
  running: false,
  phase: null,
  downloadedBytes: null,
  totalBytes: null,
  processed: null,
  total: null,
  currentItem: null,
  error: null,
  finishedAt: null,
  cancelRequested: false,
  cancelled: false,
  result: null,
  tripId: null,
  tripName: null,
  folder: null,
  moved: 0,
  skipped: 0,
  missing: 0,
  failed: 0,
};

beforeEach(() => vi.clearAllMocks());

describe("Move trip files", () => {
  it("says what will happen, then starts the move in the background and closes", async () => {
    post.mockResolvedValueOnce(check).mockResolvedValueOnce({ started: true });
    const onClose = vi.fn();
    const started = vi.fn();
    window.addEventListener(TRIP_FILE_MOVE_STARTED, started);
    wrap(<TripFilesDialog tripId="t1" mode="move" onClose={onClose} onRelinked={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Move files" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText(/2 files \(3 MB\) will move here/)).toBeTruthy();
    expect(screen.getByText(/on another drive, so the files are copied/)).toBeTruthy();
    expect(screen.getByText(/1 of your own files is linked where it is/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Also move my own linked files/ })).toHaveProperty("checked", false);
    expect(post).toHaveBeenCalledWith("/trips/t1/move-files/check", {
      folder: "/Volumes/NAS/Costa Rica",
      includeLinked: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Move 2 files" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith("/trips/t1/move-files", {
      folder: "/Volumes/NAS/Costa Rica",
      includeLinked: false,
    });
    expect(started).toHaveBeenCalled();
    window.removeEventListener(TRIP_FILE_MOVE_STARTED, started);
  });

  it("moves the user's own linked files too once they tick the option", async () => {
    post
      .mockResolvedValueOnce(check)
      .mockResolvedValueOnce({ ...check, files: 3 })
      .mockResolvedValueOnce({ started: true });
    const onClose = vi.fn();
    wrap(<TripFilesDialog tripId="t1" mode="move" onClose={onClose} onRelinked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Also move my own linked files/ }));
    expect(post).toHaveBeenLastCalledWith("/trips/t1/move-files/check", {
      folder: "/Volumes/NAS/Costa Rica",
      includeLinked: true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Move 3 files" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith("/trips/t1/move-files", {
      folder: "/Volumes/NAS/Costa Rica",
      includeLinked: true,
    });
  });

  it("accepts a Wildlife folder inside the trip's folder and says new photos go there", async () => {
    post.mockResolvedValueOnce({
      ...check,
      folder: "/Users/me/Desktop/Belize 2026/Wildlife",
      files: 4,
      alreadyThere: 2,
    });
    wrap(<TripFilesDialog tripId="t1" mode="move" onClose={vi.fn()} onRelinked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText("New photos for this trip will be saved here too.")).toBeTruthy();
    expect(screen.getByText(/2 files are already there/)).toBeTruthy();
    expect(screen.getByTestId("chosen-folder").textContent).toBe("/Users/me/Desktop/Belize 2026/Wildlife");
    expect(screen.getByRole("button", { name: "Move 4 files" })).toHaveProperty("disabled", false);
  });

  it("shows why a folder can't be used and offers no way to start", async () => {
    post.mockResolvedValueOnce({
      ...check,
      problem: "read_only",
      message: "Lifer can't save files in that folder. Choose another, or check the folder's permissions",
    });
    wrap(<TripFilesDialog tripId="t1" mode="move" onClose={vi.fn()} onRelinked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText(/can't save files in that folder/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move 2 files" })).toHaveProperty("disabled", true);
  });
});

describe("Point to where I moved them", () => {
  it("reports what isn't there and relinks only after confirming", async () => {
    const report = {
      total: 3,
      found: 1,
      missing: 1,
      sizeDiffers: 1,
      outside: 0,
      details: [
        { file: "/Volumes/NAS/Costa Rica/Birds/b.jpg", reason: "missing" },
        { file: "/Volumes/NAS/Costa Rica/Birds/c.jpg", reason: "sizeDiffers" },
      ],
      moreDetails: 0,
      applied: false,
    };
    post.mockResolvedValueOnce(report).mockResolvedValueOnce({ ...report, applied: true });
    const onRelinked = vi.fn();
    wrap(<TripFilesDialog tripId="t1" mode="relink" onClose={vi.fn()} onRelinked={onRelinked} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText("Found 1 of 3 photos there.")).toBeTruthy();
    expect(screen.getByText(/2 files aren't there or have changed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("/Volumes/NAS/Costa Rica/Birds/b.jpg")).toBeTruthy();
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(onRelinked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use this folder (1 of 3 found)" }));
    await waitFor(() => expect(onRelinked).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith("/trips/t1/relink", { folder: "/Volumes/NAS/Costa Rica", apply: true });
    expect(toast.success).toHaveBeenCalledWith(
      "Updated where 1 photo is. New photos for this trip will be saved to /Volumes/NAS/Costa Rica.",
    );
  });
});

describe("TripFileMoveTray", () => {
  it("shows progress with Cancel, then sums up the move with its details", async () => {
    const running = {
      ...idle,
      running: true,
      phase: "moving",
      processed: 1,
      total: 4,
      tripId: "t1",
      tripName: "Costa Rica",
    };
    const done = {
      ...idle,
      finishedAt: 1,
      tripId: "t1",
      tripName: "Costa Rica",
      result: {
        tripId: "t1",
        tripName: "Costa Rica",
        folder: "/Volumes/NAS/Costa Rica",
        moved: 3,
        skipped: 0,
        missing: 1,
        failed: 0,
        folderUpdated: true,
        stopReason: null,
        details: [{ file: "/trip/Wildlife/gone.jpg", reason: "missing" }],
        moreDetails: 0,
      },
    };
    get.mockResolvedValueOnce(running).mockResolvedValue(done);
    post.mockResolvedValue({ cancelled: true });
    wrap(<TripFileMoveTray />);
    expect(await screen.findByText("Moving Costa Rica files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(post).toHaveBeenCalledWith("/trips/move-files/cancel", {});

    window.dispatchEvent(new Event(TRIP_FILE_MOVE_STARTED));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe(
      "Moved 3 files, 0 skipped, 1 missing. New photos for this trip will be saved to /Volumes/NAS/Costa Rica.",
    );
    options.actions[0].onClick();
    expect(await screen.findByText("/trip/Wildlife/gone.jpg")).toBeTruthy();
  });
});

describe("Set wildlife folder", () => {
  it("only changes where new photos are saved", async () => {
    patch.mockResolvedValue({ ok: true });
    const onRelinked = vi.fn();
    wrap(<TripFilesDialog tripId="t1" mode="wildlife" onClose={vi.fn()} onRelinked={onRelinked} />);
    expect(screen.getByText(/Photos already saved stay where they are/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRelinked).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("/trips/t1", { destinationFolder: "/Volumes/NAS/Costa Rica" });
    expect(post).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("New photos for this trip will be saved to /Volumes/NAS/Costa Rica.");
  });
});
