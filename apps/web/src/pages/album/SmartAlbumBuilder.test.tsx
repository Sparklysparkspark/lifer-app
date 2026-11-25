// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), delete: vi.fn() },
}));

const { default: SmartAlbumBuilder } = await import("./SmartAlbumBuilder");
const { default: i18n } = await import("../../i18n");
const { ToastContext } = await import("../../hooks/useToast");
const { resetAccountCaches } = await import("../../lib/resource");

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const lifers = {
  id: "lifers",
  kind: "lifers",
  label: null,
  name: "Lifers",
  rules: { version: 2, query: { excludeVideo: "1", includeRaw: "0", q: "lifers" } },
  photoCount: 12,
  previewPhotoIds: [],
};

const liferName = () => i18n.t("albums.suggestions.names.lifers");
const openCardMenu = async () =>
  fireEvent.click(
    within(await screen.findByRole("region", { name: liferName() })).getByRole("button", {
      name: i18n.t("ui.moreOptions"),
    }),
  );

beforeEach(() => {
  // Each test starts from its own answers, not the last test's kept copy.
  resetAccountCaches();
  get.mockReset();
  post.mockReset();
  toast.error.mockReset();
  get.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/albums/suggestions"
        ? { suggestions: [lifers], dismissedCount: 0 }
        : { items: [], total: 0, tags: [], places: [] },
    ),
  );
  post.mockResolvedValue({ id: "new1" });
});

const renderBuilder = (props: Partial<Parameters<typeof SmartAlbumBuilder>[0]> = {}) => {
  const onSaved = vi.fn();
  render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <SmartAlbumBuilder onClose={() => {}} onSaved={onSaved} {...props} />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
  return onSaved;
};

describe("SmartAlbumBuilder", () => {
  it("creates a suggestion straight from its card", async () => {
    const onSaved = renderBuilder();
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("albums.suggestions.createNamed", { name: liferName() }) }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new1"));
    expect(post).toHaveBeenCalledWith("/albums", { name: liferName(), rules: lifers.rules });
  });

  it("customizes a suggestion, keeping its name and rules", async () => {
    const onSaved = renderBuilder();
    await openCardMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("albums.suggestions.customize") }));
    await waitFor(() =>
      expect((screen.getByLabelText(i18n.t("gallery.toolbar.searchLabel")) as HTMLInputElement).value).toBe("lifers"),
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("albums.smart.create") }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new1"));
    expect(post).toHaveBeenCalledWith("/albums", {
      name: i18n.t("albums.suggestions.names.lifers"),
      rules: lifers.rules,
    });
  });

  it("offers no suggestions when editing an album's rules", async () => {
    renderBuilder({ albumId: "a1", rules: lifers.rules as never });
    await screen.findByLabelText(i18n.t("gallery.toolbar.searchLabel"));
    expect(screen.queryByRole("heading", { name: i18n.t("albums.suggestions.title") })).toBeNull();
    expect(screen.queryByText(i18n.t("albums.smart.ownRules"))).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/albums/suggestions", expect.anything());
  });

  it("dismisses a suggestion at once, and says so if that fails", async () => {
    post.mockRejectedValue(new Error("offline"));
    renderBuilder();
    await openCardMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("albums.suggestions.dismiss") }));
    expect(screen.queryByRole("region", { name: liferName() })).toBeNull();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("albums.suggestions.dismissFailed")));
    expect(post).toHaveBeenCalledWith("/albums/suggestions/lifers/dismiss");
  });

  it("shows dismissed suggestions on request and restores one", async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/albums/suggestions"
          ? { suggestions: [], dismissedCount: 1 }
          : path === "/albums/suggestions?dismissed=true"
            ? { suggestions: [lifers], dismissedCount: 1 }
            : { items: [], total: 0, tags: [], places: [] },
      ),
    );
    renderBuilder();
    expect(screen.queryByRole("region", { name: liferName() })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("albums.suggestions.showDismissed") }));
    await openCardMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("albums.suggestions.restore") }));
    expect(screen.queryByRole("region", { name: liferName() })).toBeNull();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/albums/suggestions/lifers/restore"));
  });

  it("opens with the starting count the suggestions carry, and keeps it dimmed while a change counts", async () => {
    let answer: (v: unknown) => void = () => {};
    get.mockImplementation((path: string) =>
      path === "/albums/suggestions"
        ? Promise.resolve({
            suggestions: [lifers],
            dismissedCount: 0,
            startMatches: { photoCount: 59183, previewPhotoIds: ["s1"] },
          })
        : path.startsWith("/gallery/search")
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve({ items: [], total: 0, tags: [], places: [] }),
    );
    renderBuilder();
    const started = await screen.findByText(i18n.t("albums.smart.matches", { count: 59183 }));
    expect(document.querySelector('img[src="/api/photos/s1/thumb"]')).not.toBeNull();
    // Past the count delay, the starting rules were never counted again.
    await new Promise((r) => setTimeout(r, 400));
    expect(get.mock.calls.some((c) => /^\/gallery(\?|\/search)/.test(String(c[0])))).toBe(false);

    fireEvent.change(screen.getByLabelText(i18n.t("gallery.toolbar.searchLabel")), { target: { value: "owls" } });
    await waitFor(() => expect(get.mock.calls.some((c) => String(c[0]).startsWith("/gallery/search"))).toBe(true));
    expect(started.closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(i18n.t("albums.smart.matches", { count: 59183 }))).toBeTruthy();
    expect(screen.getByRole("button", { name: i18n.t("albums.smart.create") })).not.toHaveProperty("disabled", true);
    answer({ items: [{ photoId: "o1" }] });
    await screen.findByText(i18n.t("albums.smart.matches", { count: 1 }));
  });

  it("shows the match count and the first matches at the top, with repeated filter values", async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/albums/suggestions"
          ? { suggestions: [], dismissedCount: 0 }
          : { items: [{ photoId: "p1" }, { photoId: "p2" }], total: 2, tags: [], places: [] },
      ),
    );
    renderBuilder({ albumId: "a1", rules: { version: 2, query: { regionId: ["r1", "r2"] } } as never });
    await screen.findByText(i18n.t("albums.smart.matches", { count: 2 }));
    expect(
      document.querySelectorAll('img[src="/api/photos/p1/thumb"], img[src="/api/photos/p2/thumb"]').length,
    ).toBeGreaterThan(0);
    const listing = get.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/gallery?"))!;
    expect(new URLSearchParams(listing.split("?")[1]).getAll("regionId")).toEqual(["r1", "r2"]);
  });
});
