// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) },
}));
const start = vi.fn();
const cancel = vi.fn();
let jobStatus: unknown = null;
vi.mock("../../hooks/useJobPoll", () => ({
  useJobPoll: () => ({ status: jobStatus, start, cancel, starting: false, cancelling: false, actionError: null }),
}));

const { default: FileWritingSettings } = await import("./FileWritingSettings");
const { ConfirmContext } = await import("../../hooks/useConfirm");

const settings = { sidecarNames: "stem", insideFiles: true, linkedFolders: false };
let preview = { files: 1200, create: 1180, update: 0, skip: 20, unavailable: 0 };
const confirm = vi.fn();

function renderIt() {
  render(
    <ConfirmContext.Provider value={confirm}>
      <FileWritingSettings />
    </ConfirmContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  jobStatus = null;
  preview = { files: 1200, create: 1180, update: 0, skip: 20, unavailable: 0 };
  get.mockImplementation((path: string) =>
    Promise.resolve(path === "/settings/file-writing/linked-preview" ? preview : settings),
  );
  put.mockImplementation((_path: string, body: object) => Promise.resolve({ ...settings, ...body }));
  confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("FileWritingSettings", () => {
  it("saves a sidecar name choice and the in-file switch at once", async () => {
    renderIt();
    fireEvent.change(await screen.findByLabelText("Sidecar names for RAW files"), { target: { value: "both" } });
    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings/file-writing", { sidecarNames: "both" }));
    fireEvent.click(screen.getByRole("switch", { name: "Write keywords inside photo files" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings/file-writing", { insideFiles: false }));
  });

  it("counts what linked folders would get, and writes only once confirmed", async () => {
    renderIt();
    fireEvent.click(await screen.findByRole("switch", { name: "Also write keywords next to linked files" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const { message } = confirm.mock.calls[0][0];
    render(<>{message}</>);
    expect(screen.getByText("1,180 new sidecar files")).toBeTruthy();
    expect(screen.getByText("20 sidecars from other apps, left alone")).toBeTruthy();
    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings/file-writing", { linkedFolders: true }));
    expect(start).toHaveBeenCalledWith("/settings/file-writing/apply?background=1");
  });

  it("leaves linked folders off when the count is declined", async () => {
    confirm.mockResolvedValue(false);
    renderIt();
    fireEvent.click(await screen.findByRole("switch", { name: "Also write keywords next to linked files" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(put).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("shows how many photos an update wrote and how many failed", async () => {
    jobStatus = { running: false, finishedAt: 1, error: null, cancelled: false, written: 2, failed: 1 };
    renderIt();
    expect(await screen.findByText("2 photos updated")).toBeTruthy();
    expect(screen.getByText("1 photo couldn't be updated")).toBeTruthy();
  });
});
