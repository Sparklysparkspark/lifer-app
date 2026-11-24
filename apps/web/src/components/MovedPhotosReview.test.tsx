// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const renderReview = () =>
  render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <MovedPhotosReview open onClose={() => {}} />
      </MemoryRouter>
    </ToastContext.Provider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("MovedPhotosReview", () => {
  it("shows the file offered beside the photo, both opening full size to compare", async () => {
    renderReview();
    const preview = "/api/moved-photos/reviews/o1/candidates/0/preview";
    const pair = [
      expect.objectContaining({ url: "/api/photos/p1/display" }),
      expect.objectContaining({ url: `${preview}?size=full`, caption: "/Photos/new/osprey.jpg" }),
    ];
    fireEvent.click(await screen.findByRole("button", { name: "The photo in Lifer" }));
    expect(openViewer).toHaveBeenLastCalledWith(pair, 0);
    const candidate = screen.getByRole("button", { name: "/Photos/new/osprey.jpg" });
    expect(candidate.querySelector("img")?.getAttribute("src")).toBe(preview);
    fireEvent.click(candidate);
    expect(openViewer).toHaveBeenLastCalledWith(pair, 1);
  });

  it("offers Undo after a Skip, which brings the photo back to review", async () => {
    renderReview();
    const section = await screen.findByRole("region", { name: "/Photos/old/osprey.jpg" });
    fireEvent.click(within(section).getAllByRole("button", { name: /more|actions|options/i })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    await vi.waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/moved-photos/reviews/o1/dismiss");
    const [message, opts] = toast.show.mock.calls[0] as [
      string,
      { actions: Array<{ label: string; onClick: () => void }> },
    ];
    expect([message, opts.actions.map((a) => a.label)]).toEqual(["Skipped this photo", ["Undo"]]);
    opts.actions[0].onClick();
    expect(post).toHaveBeenLastCalledWith("/moved-photos/reviews/o1/restore");
  });

  it("says so when a skip fails", async () => {
    renderReview();
    await screen.findByRole("button", { name: "The photo in Lifer" });

    post.mockRejectedValue(new Error("Couldn't reach Lifer"));
    const section = screen.getByRole("region", { name: "/Photos/old/osprey.jpg" });
    fireEvent.click(within(section).getAllByRole("button", { name: /more|actions|options/i })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't reach Lifer"));
  });
});
