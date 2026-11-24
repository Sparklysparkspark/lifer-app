// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";

const resolveDuplicate = vi.fn();
const info = (photoId: string | null) => ({
  captureId: "c",
  photoId,
  speciesId: "s",
  speciesName: "Osprey",
  scientificName: "Pandion haliaetus",
  commonName: "Osprey",
  takenAt: null,
  exact: true,
});
const queue = {
  jobs: [],
  targetsExternalDrive: false,
  justFinishedAt: null,
  finished: null,
  pendingDuplicates: [
    { jobId: "j1", fileName: "a.jpg", info: info("p1") },
    { jobId: "j2", fileName: "b.jpg", info: info(null) },
  ],
  removals: 0,
};
vi.mock("../lib/uploadQueue", () => ({
  useUploadQueue: () => queue,
  resolveDuplicate: (...a: unknown[]) => resolveDuplicate(...a),
}));
vi.mock("../lib/rateLimitWait", () => ({ useRateLimitWaiting: () => false }));

const { default: UploadQueueBanner } = await import("./UploadQueueBanner");
const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBanner() {
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <UploadQueueBanner />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
}

describe("UploadQueueBanner duplicate prompt", () => {
  it("skips every waiting duplicate at once", () => {
    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Skip all (2)" }));
    expect(resolveDuplicate.mock.calls).toEqual([
      ["j1", "skip"],
      ["j2", "skip"],
    ]);
  });

  it("opens the photo already in the library full size, to compare", () => {
    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Your earlier photo of Osprey" }));
    const viewer = screen.getByRole("dialog", { name: "Photo viewer" });
    expect(viewer.textContent).toContain("Osprey");
  });
});
