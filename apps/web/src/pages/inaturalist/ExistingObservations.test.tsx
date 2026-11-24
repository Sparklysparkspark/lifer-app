// @vitest-environment jsdom
// The check for photos already on iNaturalist (entry point, progress, quiet result) and the
// review cards for possible matches.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));
const opened = vi.fn();
vi.mock("../../lib/openExternal", () => ({ openExternal: (url: string) => opened(url) }));

const { ExistingCheckBar, MatchReview } = await import("./ExistingObservations");
const { useExistingCheck } = await import("../../hooks/useExistingCheck");

const idle = {
  running: false,
  auto: false,
  phase: null,
  processed: null,
  total: null,
  error: null,
  finishedAt: null,
  cancelRequested: false,
  cancelled: false,
  downloadedBytes: null,
  totalBytes: null,
  currentItem: null,
  result: null,
};

function Bar({ onFound = async () => {} }: { onFound?: () => Promise<void> }) {
  return <ExistingCheckBar check={useExistingCheck(onFound)} />;
}

const match = (captureId: string, observationId: string, extra: object = {}) => ({
  captureId,
  photoId: `p-${captureId}`,
  speciesId: "s-osprey",
  commonName: "Osprey",
  scientificName: "Pandion haliaetus",
  takenAt: "2026-09-11T04:40:17.000Z",
  observationId,
  observationUrl: `https://www.inaturalist.org/observations/${observationId}`,
  inatPhotoId: "759791188",
  observedOn: "2026-09-11T04:40:00",
  likeness: "same" as const,
  evidence: { taxon: "same" as const, time: "close" as const, size: "different" as const, place: null },
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  get.mockReset().mockResolvedValue(idle);
  post.mockReset().mockResolvedValue({ ok: true });
  Object.values(toast).forEach((f) => f.mockReset());
  opened.mockReset();
});
afterEach(cleanup);

describe("ExistingCheckBar", () => {
  it("asks for the quiet check on open and every few minutes while the page is open, with no button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = render(<Bar />);
      await act(async () => {});
      expect(screen.queryByRole("button")).toBeNull();
      const asks = () => post.mock.calls.filter(([url, body]) => url === "/inaturalist/existing" && body?.auto).length;
      expect(asks()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(asks()).toBe(2);
      // Not while one is already running.
      get.mockResolvedValue({ ...idle, running: true, auto: true, phase: "reading" });
      // The next status poll sees it running.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(asks()).toBe(2);
      // And never after leaving the page.
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(asks()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only a problem, and only under the toolbar's own place", async () => {
    get.mockResolvedValue({ ...idle, finishedAt: 1, result: { read: 3, linked: 0, review: 0, compared: false } });
    render(<Bar />);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a check Lifer started by itself out of sight, then tells its result once", async () => {
    const onFound = vi.fn(async () => {});
    // Running when the page opens, and still when the quiet check's request looks again.
    const running = { ...idle, running: true, auto: true, phase: "comparing" };
    get.mockResolvedValueOnce(running).mockResolvedValueOnce(running);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Bar onFound={onFound} />);
      await act(async () => {});
      expect(screen.queryByText(/Comparing/)).toBeNull();
      get.mockResolvedValue({
        ...idle,
        auto: true,
        finishedAt: 1000,
        result: { read: 12, linked: 12, review: 0, compared: true, linkedCaptureIds: ["c1", "c2"] },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      const [message, opts] = toast.show.mock.calls.at(-1)!;
      expect(message).toBe("Linked 12 photos to observations you already have on iNaturalist.");
      // Undo unlinks exactly what this check linked.
      await act(async () => opts.actions[0].onClick());
      expect(post).toHaveBeenCalledWith("/inaturalist/matches/unlink", { captureIds: ["c1", "c2"] });
      expect(onFound).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    toast.show.mockReset();
    render(<Bar />);
    await act(async () => {});
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("says when pictures couldn't be compared", async () => {
    get.mockResolvedValue({ ...idle, finishedAt: 5, result: { read: 3, linked: 0, review: 2, compared: false } });
    render(<Bar />);
    expect(await screen.findByText(/species-matching model/)).toBeTruthy();
  });
});

describe("MatchReview", () => {
  it("shows both photos and what matched in words, never numbers", () => {
    render(<MatchReview matches={[match("c1", "1")]} onChanged={async () => {}} />);
    expect(screen.getByText("Looks the same")).toBeTruthy();
    expect(screen.getByText(/Same species, same time, cropped or resized/)).toBeTruthy();
    expect(screen.getByText("Your photo")).toBeTruthy();
    const half = screen.getByRole("button", { name: "iNaturalist" });
    expect(half.querySelector("img")?.getAttribute("src")).toBe("/api/inaturalist/observations/1/photos/759791188");
    expect(document.body.textContent).not.toMatch(/0\.\d/);
  });

  it("links a photo and settles its other suggestions; Not a match removes only that pair", async () => {
    const onChanged = vi.fn(async () => {});
    render(
      <MatchReview
        matches={[match("a", "1"), match("a", "2"), match("b", "1", { likeness: "probably" })]}
        onChanged={onChanged}
      />,
    );
    expect(screen.getAllByText("Osprey")).toHaveLength(3);
    // Sorted by observation: a/1, b/1, a/2.
    fireEvent.click(screen.getAllByRole("button", { name: "Not a match" })[1]);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/matches/dismiss", { captureId: "b", observationId: "1" }),
    );
    await waitFor(() => expect(screen.queryByText("Probably the same")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Link" })[0]);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/matches/link", { captureId: "a", observationId: "1" }),
    );
    expect(await screen.findByText("Nothing left to check.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("pages thousands of possible matches", () => {
    const many = Array.from({ length: 1000 }, (_, i) => match(`c${i}`, String(i)));
    render(<MatchReview matches={many} onChanged={async () => {}} />);
    expect(screen.getAllByRole("button", { name: "Link" })).toHaveLength(120);
    expect(screen.getByRole("button", { name: /Show/ })).toBeTruthy();
  });

  it("undoes Not a match: the card comes back", async () => {
    const onChanged = vi.fn(async () => {});
    render(<MatchReview matches={[match("a", "1")]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Not a match" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(screen.queryByText("Looks the same")).toBeNull();
    const [message, opts] = toast.show.mock.calls[0];
    expect(message).toBe("Won't suggest this again.");
    await act(async () => opts.actions[0].onClick());
    expect(post).toHaveBeenLastCalledWith("/inaturalist/matches/dismiss", {
      captureId: "a",
      observationId: "1",
      undo: true,
    });
    expect(await screen.findByText("Looks the same")).toBeTruthy();
  });

  it("undoes Link from its toast: unlinks, and the card comes back", async () => {
    render(<MatchReview matches={[match("a", "1")]} onChanged={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(screen.queryByText("Looks the same")).toBeNull();
    const [message, opts] = toast.show.mock.calls[0];
    expect(message).toBe("Linked. It's on the Completed tab now.");
    await act(async () => opts.actions[0].onClick());
    expect(post).toHaveBeenLastCalledWith("/inaturalist/matches/unlink", { captureIds: ["a"] });
    expect(await screen.findByText("Looks the same")).toBeTruthy();
  });

  it("opens both photos in one viewer to compare, with the actions pinned to the card's foot", async () => {
    render(
      <MemoryRouter>
        <MatchReview matches={[match("c1", "1")]} onChanged={async () => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("list").className).not.toContain("items-start");
    expect(screen.getByRole("button", { name: "Link" }).closest(".mt-auto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Your photo" }));
    const viewer = await screen.findByRole("dialog");
    expect(viewer.querySelector("img[src$='/display']")?.getAttribute("src")).toBe("/api/photos/p-c1/display");
    expect(within(viewer).getByText("2 / 2")).toBeTruthy();
  });

  it("never shows the runtime's own error text", async () => {
    post.mockRejectedValueOnce(new TypeError("x.map is not a function"));
    render(<MatchReview matches={[match("c1", "1")]} onChanged={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).not.toMatch(/not a function/);
  });
});
