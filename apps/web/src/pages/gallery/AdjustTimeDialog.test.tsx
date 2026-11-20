// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDate } from "../../lib/format";

const post = vi.fn();
const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));

const { default: AdjustTimeDialog } = await import("./AdjustTimeDialog");

const EARLIEST = "2026-05-03T06:12:00.000Z";
const LATEST = "2026-05-04T09:30:00.000Z";
const FIRST = "2026-05-03T10:00:00.000Z";
const HOUR_MS = 3_600_000;

function serve(preview: object) {
  post.mockImplementation(async (url: string) => (url === "/captures/taken-at/preview" ? preview : { started: true }));
  get.mockResolvedValue({
    running: false,
    error: null,
    processed: 3,
    total: 3,
    result: { shifted: 2, undated: 1, filesFailed: 0 },
  });
}

function renderDialog(onChanged = vi.fn(), onClose = vi.fn()) {
  render(<AdjustTimeDialog captureIds={["a", "b", "c"]} onClose={onClose} onChanged={onChanged} />);
  return { onChanged, onClose };
}

const preview = {
  dated: 2,
  undated: 1,
  earliest: EARLIEST,
  latest: LATEST,
  first: { captureId: "b", photoId: "p1", takenAt: FIRST },
};
const at = (iso: string, plusMs = 0) => formatDate(new Date(Date.parse(iso) + plusMs), "dateTime");
const shiftCalls = () => post.mock.calls.filter(([url]) => url === "/captures/taken-at/shift");

afterEach(() => vi.clearAllMocks());

describe("AdjustTimeDialog", () => {
  it("previews a shift, applies it, and offers Undo with the opposite shift", async () => {
    serve(preview);
    const { onChanged, onClose } = renderDialog();
    expect(await screen.findByText("2 photos will change. 1 with no date is skipped.")).toBeTruthy();
    const apply = screen.getByRole("button", { name: "Adjust" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "8" } });
    expect(screen.getByText(`Earliest: ${at(EARLIEST)} → ${at(EARLIEST, 8 * HOUR_MS)}`)).toBeTruthy();
    expect(screen.getByText(`Latest: ${at(LATEST)} → ${at(LATEST, 8 * HOUR_MS)}`)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Move"), { target: { value: "earlier" } });
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "1" } });
    expect(screen.getByText(`Earliest: ${at(EARLIEST)} → ${at(EARLIEST, -32 * HOUR_MS)}`)).toBeTruthy();
    fireEvent.click(apply);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(shiftCalls()).toEqual([["/captures/taken-at/shift", { captureIds: ["a", "b", "c"], minutes: -32 * 60 }]]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Adjusted 2 photos. 1 with no date is skipped.");

    await act(async () => options.actions[0].onClick());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Put back the dates of 2 photos."));
    expect(shiftCalls()[1]).toEqual(["/captures/taken-at/shift", { captureIds: ["a", "b", "c"], minutes: 32 * 60 }]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("sets one photo's time and shifts every photo by the same difference", async () => {
    serve(preview);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Set this photo's time" }));
    const input = screen.getByLabelText("Correct date and time") as HTMLInputElement;
    // Opens on the photo's own time, so nothing changes until it's corrected.
    expect((screen.getByRole("button", { name: "Adjust" }) as HTMLButtonElement).disabled).toBe(true);

    const corrected = new Date(Date.parse(FIRST) + 5 * HOUR_MS + 15 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    fireEvent.change(input, {
      target: {
        value: `${corrected.getFullYear()}-${pad(corrected.getMonth() + 1)}-${pad(corrected.getDate())}T${pad(corrected.getHours())}:${pad(corrected.getMinutes())}`,
      },
    });
    expect(screen.getByText(`Earliest: ${at(EARLIEST)} → ${at(EARLIEST, 5 * HOUR_MS + 15 * 60_000)}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
    await waitFor(() => expect(shiftCalls()).toHaveLength(1));
    expect(shiftCalls()[0][1]).toEqual({ captureIds: ["a", "b", "c"], minutes: 5 * 60 + 15 });
  });

  it("says when no selected photo has a date, and keeps Adjust off", async () => {
    serve({ dated: 0, undated: 3, earliest: null, latest: null, first: null });
    renderDialog();
    expect(await screen.findByText("None of these photos has a date to adjust.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2" } });
    expect((screen.getByRole("button", { name: "Adjust" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a failed job's error and stays open", async () => {
    serve(preview);
    get.mockResolvedValue({ running: false, error: "Disk full", processed: 0, total: 3, result: null });
    const { onClose } = renderDialog();
    fireEvent.change(await screen.findByLabelText("Minutes"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Disk full");
    expect(onClose).not.toHaveBeenCalled();
  });
});
