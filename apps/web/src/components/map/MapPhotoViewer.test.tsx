// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../../hooks/useToast";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn() },
}));

const { default: MapPhotoViewer } = await import("./MapPhotoViewer");
const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const item = (n: number) => ({
  captureId: `c${n}`,
  photoId: `p${n}`,
  speciesId: "s",
  commonName: `Bird ${n}`,
  scientificName: "Aves",
  kind: "image",
  takenAt: null,
  lat: 1,
  lon: 1,
});

describe("MapPhotoViewer", () => {
  it("steps past the loaded photos of a huge cluster by loading the next page, not all of them", async () => {
    // Pages of 2 stand in for the real 60, of a 5,000-photo cluster.
    get.mockImplementation((path: string) =>
      path.startsWith("/gallery?")
        ? Promise.resolve(
            path.includes("cursor=n2")
              ? { items: [item(3), item(4)], nextCursor: "n3" }
              : { items: [item(1), item(2)], nextCursor: "n2", total: 5000 },
          )
        : new Promise(() => {}),
    );
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <MapPhotoViewer params={new URLSearchParams("bbox=1,1,2,2")} start={1} onClose={() => {}} />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("2 / 5,000")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("3 / 5,000")).toBeTruthy();
    expect(screen.getByText("Bird 3", { exact: false })).toBeTruthy();
    await waitFor(() => expect(get.mock.calls.filter(([p]) => String(p).includes("cursor=")).length).toBe(1));
  });
});
