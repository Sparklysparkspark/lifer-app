// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.fn();
const cancel = vi.fn();
let jobStatus: unknown = null;
vi.mock("../hooks/useJobPoll", () => ({
  useJobPoll: () => ({ status: jobStatus, start, cancel, starting: false, cancelling: false, actionError: null }),
}));

const { default: ApplePhotosDialog } = await import("./ApplePhotosDialog");

const finished = (over: object) => ({
  running: false,
  finishedAt: 1,
  error: null,
  cancelled: false,
  phase: null,
  mode: "check",
  photos: 0,
  found: 0,
  notFound: 0,
  added: 0,
  unchanged: 0,
  failed: 0,
  problem: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  jobStatus = null;
});
afterEach(cleanup);

describe("ApplePhotosDialog", () => {
  it("checks first, says what it found, and adds keywords only when asked", () => {
    jobStatus = finished({ photos: 12, found: 10, notFound: 2 });
    render(<ApplePhotosDialog captureIds={["a", "b"]} onClose={vi.fn()} />);
    expect(start).toHaveBeenCalledWith("/apple-photos/send", { mode: "check", captureIds: ["a", "b"] });
    expect(screen.getByText("10 photos found in Apple Photos")).toBeTruthy();
    expect(screen.getByText("2 photos aren't in your Photos library and are skipped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add keywords" }));
    expect(start).toHaveBeenLastCalledWith("/apple-photos/send", { mode: "send", captureIds: ["a", "b"] });
  });

  it("sends a whole album by its id", () => {
    jobStatus = finished({ found: 0, notFound: 3 });
    render(<ApplePhotosDialog albumId="album-1" onClose={vi.fn()} />);
    expect(start).toHaveBeenCalledWith("/apple-photos/send", { mode: "check", albumId: "album-1" });
    expect(screen.getByText(/None of these photos are in your Photos library/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add keywords" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains how to allow Automation when it was denied, and can try again", () => {
    jobStatus = finished({ problem: "automation_denied" });
    render(<ApplePhotosDialog captureIds={["a"]} onClose={vi.fn()} />);
    expect(screen.getByText(/Privacy & Security, then Automation/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("reports what a send changed", () => {
    jobStatus = finished({ mode: "send", found: 3, added: 2, unchanged: 1, failed: 0 });
    render(<ApplePhotosDialog captureIds={["a", "b", "c"]} onClose={vi.fn()} />);
    expect(screen.getByText("Keywords added to 2 photos")).toBeTruthy();
    expect(screen.getByText("1 photo already had them")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});
