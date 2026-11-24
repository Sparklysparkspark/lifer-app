// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: async () => ({
      total: 1,
      items: [
        {
          originalId: "o1",
          path: "/Photos/old/osprey.jpg",
          photoId: "p1",
          reason: "several",
          commonName: "Osprey",
          scientificName: "Pandion haliaetus",
          candidates: [{ path: "/Photos/new/osprey.jpg" }],
        },
      ],
    }),
    post: (...a: unknown[]) => post(...a),
  },
}));
const openViewer = vi.fn();
vi.mock("./Lightbox", () => ({ useLightbox: () => ({ open: openViewer, node: null }) }));

const { default: MovedPhotosReview } = await import("./MovedPhotosReview");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

describe("MovedPhotosReview", () => {
  it("opens the photo full size, and says so when a skip fails", async () => {
    render(
      <ToastContext.Provider value={toast}>
        <MemoryRouter>
          <MovedPhotosReview open onClose={() => {}} />
        </MemoryRouter>
      </ToastContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "/Photos/old/osprey.jpg" }));
    expect(openViewer).toHaveBeenCalledWith([expect.objectContaining({ url: "/api/photos/p1/display" })]);

    post.mockRejectedValue(new Error("Couldn't reach Lifer"));
    const section = screen.getByRole("region", { name: "/Photos/old/osprey.jpg" });
    fireEvent.click(within(section).getAllByRole("button", { name: /more|actions|options/i })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't reach Lifer"));
  });
});
