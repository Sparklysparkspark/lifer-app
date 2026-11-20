// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idlePackLanes, type PackDownloadStatus } from "@lifer/shared";
import PackProgress from "./PackProgress";

afterEach(cleanup);

function running(lanes: (l: PackDownloadStatus["lanes"]) => void) {
  const l = idlePackLanes();
  for (const lane of Object.values(l)) lane.total = 2;
  lanes(l);
  return { running: true, phase: "downloading", lanes: l } as unknown as PackDownloadStatus;
}

describe("PackProgress", () => {
  it("shows one bar for the download, with the set-up meanwhile as a note", () => {
    const status = running((l) => {
      Object.assign(l.download, { currentItem: "Belize mammals", processed: 1, downloadedBytes: 1, totalBytes: 2 });
      Object.assign(l.setup, { currentItem: "Belize birds", step: "checklist" });
    });
    render(<PackProgress status={status} />);
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(screen.getByText("Also setting up Belize birds on this computer")).toBeTruthy();
  });

  it("offers stopping only the downloads while packs are still to come", () => {
    const onCancel = vi.fn();
    const status = running((l) => Object.assign(l.download, { currentItem: "Belize birds" }));
    render(<PackProgress status={status} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop downloading, finish setting up" }));
    expect(onCancel).toHaveBeenCalledWith(true);
  });

  it("stops everything at once when only the set-up is left", () => {
    const onCancel = vi.fn();
    const status = running((l) => {
      Object.assign(l.download, { processed: 2 });
      Object.assign(l.photos, { processed: 2 });
      Object.assign(l.setup, { processed: 1, currentItem: "Belize birds", step: "checklist" });
    });
    render(<PackProgress status={status} onCancel={onCancel} />);
    expect(screen.getByText("Setting up on this computer")).toBeTruthy();
    expect(screen.getByText(/Doesn't use the internet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith(false);
  });
});
