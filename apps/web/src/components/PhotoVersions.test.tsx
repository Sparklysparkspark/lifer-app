// @vitest-environment jsdom
// Photo versions in the UI: the stack badge, the viewer's switcher (keys, rename, use as photo),
// the Gallery's "Show every version" choice and the notice after an import.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

const openIn = vi.fn();
vi.mock("../hooks/useOpenInEditors", () => ({
  useOpenInEditors: () => ({ editors: [{ id: "ps", name: "Photoshop" }], openIn }),
}));

const { default: PhotoTile } = await import("./PhotoTile");
const { default: Lightbox } = await import("./Lightbox");
const { PhotoViewMenu } = await import("./PhotoGridControls");
const { default: VersionNotice, useVersionNotice } = await import("./VersionNotice");
const { PhotoVersionsHost } = await import("./PhotoVersions");
const { openPhotoVersions, photoVersionsPanel, refreshVersionCounts } = await import("../lib/photoVersions");

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const version = (captureId: string, photoId: string, extra: object) => ({
  captureId,
  photoId,
  width: 300,
  height: 200,
  label: null,
  labelSize: null,
  fileName: `${captureId}-a-very-long-file-name-from-an-export-preset-${"x".repeat(60)}.jpg`,
  isGroup: false,
  shown: false,
  ...extra,
});
const VERSIONS = [
  version("g1", "p1", { labelKind: "original", isGroup: true, shown: true }),
  version("v2", "p2", { labelKind: "bw" }),
  version("v3", "p3", { labelKind: "print", labelSize: "8x10", width: 800, height: 1000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/captures/version-counts")) return { counts: { g1: 3 } };
    if (path.startsWith("/captures/version-summary"))
      return path.includes("since=")
        ? { versions: 0, photos: 0, latest: null }
        : { versions: 4, photos: 2, latest: "2026-11-12T10:00:00.000Z" };
    if (path.includes("/versions")) return { groupCaptureId: "g1", files: [], versions: VERSIONS, nearby: [] };
    if (path.includes("/ebird")) return { checklists: [] };
    return {};
  });
  put.mockResolvedValue({ label: "Gallery print" });
  post.mockResolvedValue({ shownCaptureId: "g1" });
});

const wrap = (ui: React.ReactNode) =>
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>{ui}</ToastContext.Provider>
    </MemoryRouter>,
  );

function tile(extra: { versionCount?: number; versionLabel?: string }) {
  return (
    <PhotoTile
      photoId="p1"
      alt=""
      onOpen={() => {}}
      selectMode={false}
      selected={false}
      onToggleSelect={() => {}}
      menuOpen={false}
      onToggleMenu={() => {}}
      {...extra}
    />
  );
}

describe("the stack badge", () => {
  it("shows how many versions a photo has, and nothing for a single photo", () => {
    const { rerender } = render(tile({ versionCount: 3 }));
    expect(screen.getByText("3 versions")).toBeTruthy();
    rerender(tile({ versionCount: 1 }));
    expect(screen.queryByText(/version/)).toBeNull();
    rerender(tile({}));
    expect(screen.queryByText(/version/)).toBeNull();
  });

  it("names a version listed on its own", () => {
    render(tile({ versionLabel: "Print 8x10" }));
    expect(screen.getByText("Print 8x10")).toBeTruthy();
  });
});

describe("the viewer's version switcher", () => {
  const openViewer = () =>
    wrap(
      <Lightbox
        slides={[{ url: "/api/photos/p1/display", captureId: "g1", caption: "Great Blue Heron" }]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
      />,
    );
  const shownSrc = () => document.querySelector("img[src*='/api/photos/']")?.getAttribute("src");

  it("lists the versions by name and switches with Alt and the arrow keys", async () => {
    openViewer();
    expect(await screen.findByRole("radio", { name: "Original" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Print 8x10" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /3 versions/ })).toBeTruthy();
    expect(shownSrc()).toBe("/api/photos/p1/display");

    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", altKey: true });
    expect(shownSrc()).toBe("/api/photos/p2/display");
    expect(screen.getByRole("radio", { name: "Black and white" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(shownSrc()).toBe("/api/photos/p3/display");
  });

  it("renames a version in place, and Escape only cancels the rename", async () => {
    openViewer();
    fireEvent.doubleClick(await screen.findByRole("radio", { name: "Black and white" }));
    const field = screen.getByRole("textbox", { name: "Version name" });
    fireEvent.change(field, { target: { value: "Gallery print" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(put).toHaveBeenCalledWith("/captures/v2/versions/label", { label: "Gallery print" }));

    fireEvent.doubleClick(screen.getByRole("radio", { name: "Original" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Version name" }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("uses the chosen version as the photo", async () => {
    openViewer();
    fireEvent.click(await screen.findByRole("radio", { name: "Black and white" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this as the photo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/g1/versions/show", { captureId: "v2" }));
    expect(toast.show).toHaveBeenCalled();
  });

  it("uses the version on screen as the photo, or splits it out, from the keys", async () => {
    openViewer();
    fireEvent.click(await screen.findByRole("radio", { name: "Black and white" }));
    fireEvent.keyDown(window, { key: "S", code: "KeyS", shiftKey: true });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/g1/versions/show", { captureId: "v2" }));
    fireEvent.keyDown(window, { key: "G", code: "KeyG", shiftKey: true, ctrlKey: true });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/v2/versions/split"));
  });

  it("opens the version on screen in an editor and names its file", async () => {
    openViewer();
    fireEvent.click(screen.getByRole("button", { name: "Open in Photoshop" }));
    expect(openIn).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ps" }), { captureIds: ["g1"] });
    fireEvent.click(await screen.findByRole("radio", { name: "Black and white" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Photoshop" }));
    expect(openIn).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ps" }), { photoIds: ["p2"] });
    expect(screen.getByText(VERSIONS[1].fileName)).toBeTruthy();
  });
});

describe("linking to any photo", () => {
  it("explains the two-minute list, searches the rest and links with Undo", async () => {
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/captures/version-counts")) return { counts: { far: 3 } };
      if (path.includes("/versions/candidates"))
        return {
          items: [
            {
              captureId: "far",
              photoId: "p9",
              takenAt: "2019-01-02T10:00:00Z",
              fileName: "IMG_9.jpg",
              speciesName: "Moose",
            },
          ],
        };
      if (path.includes("/versions")) return { groupCaptureId: "solo", files: [], versions: [], nearby: [] };
      return {};
    });
    post.mockResolvedValue({ groupCaptureId: "far" });
    await refreshVersionCounts();
    wrap(<PhotoVersionsHost />);
    openPhotoVersions("solo", undefined, true);
    expect(
      await screen.findByText("No photos were taken within two minutes. Search to find any other photo."),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search photos" }), { target: { value: "IMG_9" } });
    // A photo that has versions already is offered, marked as such; this one joins them.
    const target = await screen.findByRole("button", { name: "Link to IMG_9.jpg" });
    expect(target.textContent).toContain("3 versions");
    fireEvent.click(target);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/solo/versions/link", { groupCaptureId: "far" }));
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("/captures/solo/versions/candidates?q=IMG_9"),
      expect.anything(),
    );
    const undo = vi.mocked(toast.show).mock.calls.at(-1)![1]!.actions![0]!;
    undo.onClick();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/solo/versions/split"));
    photoVersionsPanel.set(null);
  });
});

describe("the Gallery's View menu", () => {
  it("offers every version as its own photo", () => {
    const onChange = vi.fn();
    render(<PhotoViewMenu sections={["versions"]} activeCount={0} allVersions={{ checked: false, onChange }} />);
    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show every version as its own photo" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("the notice after an import", () => {
  function Notice() {
    return <VersionNotice notice={useVersionNotice()} />;
  }

  it("says what was grouped and stays dismissed until more is", async () => {
    wrap(<Notice />);
    expect(await screen.findByText("Found 4 versions of 2 photos. Each is grouped as one photo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/Found 4 versions/)).toBeNull());
    expect(JSON.parse(localStorage.getItem("lifer:versionNoticeSeen")!)).toBe("2026-11-12T10:00:00.000Z");
    expect(get).toHaveBeenCalledWith(expect.stringContaining("since=2026-11-12"), expect.anything());
  });
});
