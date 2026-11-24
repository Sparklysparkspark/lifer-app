// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));
vi.mock("../../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => "desktop" }));
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: () => Promise.resolve("/cards/2026") }));

const { default: WatchedFoldersGroup } = await import("./WatchedFoldersGroup");

const folder = (path: string, enabled = true) => ({ path, enabled, available: true });

beforeEach(() => {
  get.mockReset().mockResolvedValue({ folders: [folder("/cards", false)] });
  post.mockReset().mockResolvedValue({ ok: true, added: true, coveredBy: null, contains: [] });
  patch.mockReset().mockResolvedValue({ ok: true });
  toast.show.mockReset();
});
afterEach(cleanup);

describe("WatchedFoldersGroup", () => {
  it("filters a long list instead of a row per folder", async () => {
    get.mockResolvedValue({ folders: Array.from({ length: 12 }, (_, i) => folder(`/cards/trip ${i}`)) });
    render(<WatchedFoldersGroup />);
    expect(await screen.findByRole("textbox", { name: "Filter Watched folders" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
  });

  it("says when a folder is already covered instead of silently doing nothing", async () => {
    post.mockResolvedValue({ added: false, coveredBy: "/cards", contains: [] });
    render(<WatchedFoldersGroup />);
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    expect(await screen.findByText("Already covered by /cards")).toBeTruthy();
  });

  it("offers to watch a parent instead of the folders inside it", async () => {
    post.mockResolvedValueOnce({ added: false, coveredBy: null, contains: ["/cards/2026/a", "/cards/2026/b"] });
    render(<WatchedFoldersGroup />);
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Watch this one" }));
    await vi.waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/library/watched-folders", { path: "/cards/2026", merge: true }),
    );
  });

  it("stops watching at once and Undo puts the folder back switched off", async () => {
    render(<WatchedFoldersGroup />);
    fireEvent.click(await screen.findByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop watching" }));
    await vi.waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/library/watched-folders/remove", { path: "/cards" });
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Stopped watching /cards");
    options.actions[0].onClick();
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/library/watched-folders", { path: "/cards", enabled: false }),
    );
    expect(post).toHaveBeenCalledWith("/library/watched-folders", { path: "/cards" });
  });
});
