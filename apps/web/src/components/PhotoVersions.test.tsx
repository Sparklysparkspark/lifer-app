// @vitest-environment jsdom
// Photo versions in the UI: the stack badge, the viewer's switcher (keys, rename, use as photo),
// the Gallery's "Show every version" choice and the notice after an import.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("lists a RAW behind its edit to switch to, without counting it", async () => {
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/captures/version-counts")) return { counts: { r1: 1 } };
      if (path.includes("/versions"))
        return {
          groupCaptureId: "r1",
          files: [],
          versions: [
            version("r1", "p1", { labelKind: "raw", isGroup: true, rawOnly: true }),
            version("r2", "p2", { labelKind: "bw", shown: true }),
          ],
          nearby: [],
        };
      if (path.includes("/ebird")) return { checklists: [] };
      return {};
    });
    wrap(
      <Lightbox
        slides={[{ url: "/api/photos/p1/display", captureId: "r1", caption: "Moose" }]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByRole("radio", { name: "RAW" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Black and white" })).toBeTruthy();
    expect(screen.queryByText(/\d versions?/)).toBeNull();
  });

  it("never shows two versions under the same name, and keeps the user's names", async () => {
    get.mockImplementation(async (path: string) => {
      if (path.includes("/versions"))
        return {
          groupCaptureId: "r1",
          files: [],
          versions: [
            version("r1", "p1", { labelKind: "raw", isGroup: true, rawOnly: true }),
            version("e1", "p2", { labelKind: "export", shown: true }),
            version("e2", "p3", { labelKind: "export" }),
            version("e3", "p4", { labelKind: "export", label: "Mine" }),
            version("e4", "p5", { labelKind: "export", label: "Mine" }),
          ],
          nearby: [],
        };
      if (path.startsWith("/captures/version-counts")) return { counts: { r1: 4 } };
      if (path.includes("/ebird")) return { checklists: [] };
      return {};
    });
    wrap(
      <Lightbox
        slides={[{ url: "/api/photos/p2/display", captureId: "r1", caption: "Caiman" }]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("radio", { name: "RAW" });
    const names = screen.getAllByRole("radio").map((r) => r.textContent);
    expect(names).toEqual(["RAW", "Export 1", "Export 2", "Mine", "Mine"]);
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
    fireEvent.click(screen.getByRole("button", { name: "Use as the photo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/g1/versions/show", { captureId: "v2" }));
    expect(toast.show).toHaveBeenCalled();
  });

  it("uses the version on screen as the photo, or splits it out, from the keys", async () => {
    openViewer();
    fireEvent.click(await screen.findByRole("radio", { name: "Black and white" }));
    fireEvent.keyDown(window, { key: "U", code: "KeyU", shiftKey: true });
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

describe("the Versions dialog", () => {
  const file = (originalId: string, captureId: string, extra: object = {}) => ({
    originalId,
    captureId,
    photoId: `p-${captureId}`,
    role: "original",
    kind: "jpeg",
    fileName: `${originalId}.jpg`,
    format: "JPG",
    ref: `/lib/${originalId}.jpg`,
    managed: false,
    fileSize: 1000,
    width: 2560,
    height: 1707,
    isGroup: captureId === "g1",
    shown: false,
    evidence: null,
    ...extra,
  });
  // One capture: the JPG export is the photo, the RAW beside it is not.
  const PAIR = [
    file("6F9A3556-jpg", "g1", { role: "export", shown: true }),
    file("6F9A3556-cr3", "g1", { kind: "raw", fileName: "6F9A3556.cr3", format: "CR3" }),
  ];
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => file(`f${i}`, i === 0 ? "g1" : `v${i}`, { shown: i === 0 }));

  let mounted = false;
  beforeEach(() => {
    mounted = false;
  });
  // Opens (or reopens) the dialog on `files`.
  function openDialog(files: object[]) {
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/captures/version-counts")) return { counts: {} };
      if (path.includes("/versions")) return { groupCaptureId: "g1", files, versions: [], nearby: [] };
      if (path.includes("/ebird")) return { checklists: [] };
      return {};
    });
    act(() => photoVersionsPanel.set(null));
    if (!mounted) wrap(<PhotoVersionsHost />);
    mounted = true;
    act(() => openPhotoVersions("g1"));
  }
  const viewer = () => screen.queryByRole("dialog", { name: "Photo viewer" });
  const viewerSrc = () => viewer()?.querySelector("img")?.getAttribute("src");
  afterEach(() => act(() => photoVersionsPanel.set(null)));

  it("says plainly what the list holds", async () => {
    openDialog(PAIR);
    expect(await screen.findByText("2 files: your camera original and an export")).toBeTruthy();
    openDialog([file("solo", "g1", { shown: true })]);
    expect(await screen.findByText("Only one file")).toBeTruthy();
    // A single file has nothing to switch between.
    expect(screen.queryByRole("group", { name: "Show files as" })).toBeNull();
    openDialog([...PAIR, file("print", "v2"), file("bw", "v3")]);
    expect(await screen.findByText("3 versions, counted as one photo")).toBeTruthy();
    // A RAW of its own, behind its edit, is listed but not counted.
    openDialog([
      file("edit", "g1", { role: "export", shown: true }),
      file("raw", "v2", { kind: "raw", fileName: "raw.cr3", format: "CR3" }),
    ]);
    expect(await screen.findByText("2 files: your camera original and an export")).toBeTruthy();
    expect(screen.getByText("raw.cr3")).toBeTruthy();
    openDialog([
      file("edit", "g1", { role: "export", shown: true }),
      file("raw", "v2", { kind: "raw", fileName: "raw.cr3", format: "CR3" }),
      file("print", "v3", { role: "export" }),
    ]);
    expect(await screen.findByText("2 versions, counted as one photo")).toBeTruthy();
  });

  it("marks only the file that is the photo as shown", async () => {
    openDialog(PAIR);
    await screen.findByText("6F9A3556.cr3");
    // One wording for it everywhere: "Used as the photo", as the viewer says (INAT-24).
    expect(screen.getAllByText("Used as the photo")).toHaveLength(1);
    expect(screen.getByText(/^Export · JPG/)).toBeTruthy();
    // The full path shows in the shared tooltip, never a slow native title (INAT-25).
    expect(screen.getByRole("dialog").querySelector("[title]")).toBeNull();
    expect(screen.getByText("Original · CR3 · 2560 × 1707 · 1 KB")).toBeTruthy();
    // Its own capture is already the photo, so the RAW isn't offered as one.
    fireEvent.click(screen.getAllByRole("button", { name: "More options" })[1]);
    expect(screen.queryByRole("menuitem", { name: "Use as the photo" })).toBeNull();
  });

  it("deletes a version on its own, and the group's file with all its versions", async () => {
    post.mockResolvedValue({});
    const files = [
      file("hawk-jpg", "v2", { role: "export", shown: true, fileName: "hawk.jpg" }),
      file("hawk-cr3", "g1", { kind: "raw", fileName: "hawk.cr3", format: "CR3" }),
    ];
    openDialog(files);
    await screen.findByText("hawk.cr3");
    fireEvent.click(screen.getAllByRole("button", { name: "More options" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Delete/ }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["v2"], deleteRaw: false }),
    );

    post.mockClear();
    openDialog(files);
    await screen.findByText("hawk.cr3");
    fireEvent.click(screen.getAllByRole("button", { name: "More options" })[1]);
    // Only the whole photo: its versions would be left under nothing.
    expect(screen.queryByRole("menuitem", { name: /^Delete (photo|this)/ })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete the photo and its versions" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["v2", "g1"], deleteRaw: false }),
    );
  });

  it("lists a few files and shows many as a grid, and remembers the choice", async () => {
    openDialog(PAIR);
    const list = await screen.findByRole("button", { name: "List" });
    expect(list.getAttribute("aria-pressed")).toBe("true");
    act(() => photoVersionsPanel.set(null));

    openDialog(many(7));
    expect((await screen.findByRole("button", { name: "Grid" })).getAttribute("aria-pressed")).toBe("true");
    // Each tile: a thumbnail that opens it, its name and role, one Shown badge and its own menu.
    expect(screen.getAllByRole("button", { name: /^View f\d\.jpg full size$/ })).toHaveLength(7);
    expect(screen.getAllByText("Original · JPG · 1 KB")).toHaveLength(7);
    expect(screen.getAllByText("Used as the photo")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "More options" })).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(localStorage.getItem("lifer:versions.view")).toBe('"list"');
    act(() => photoVersionsPanel.set(null));

    // The remembered choice wins over the count.
    openDialog(many(7));
    expect((await screen.findByRole("button", { name: "List" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens a file full size, pages with the arrows, and Escape closes only the viewer", async () => {
    localStorage.setItem("lifer:versions.view", '"grid"');
    openDialog(PAIR);
    const rawTile = await screen.findByRole("button", { name: "View 6F9A3556.cr3 full size" });
    rawTile.focus();
    fireEvent.click(rawTile);
    // The RAW shows its own preview, not the JPG beside it.
    await waitFor(() => expect(viewerSrc()).toBe("/api/photos/p-g1/full?original=raw"));
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(viewerSrc()).toBe("/api/photos/p-g1/display"));

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(viewer()).toBeNull();
    expect(screen.getByRole("dialog", { name: "Versions" })).toBeTruthy();
    expect(document.activeElement).toBe(rawTile);
  });

  it("opened from the photo viewer, takes the keys one layer at a time", async () => {
    localStorage.setItem("lifer:versions.view", '"grid"');
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/captures/version-counts")) return { counts: {} };
      if (path.includes("/versions")) return { groupCaptureId: "g1", files: many(3), versions: [], nearby: [] };
      if (path.includes("/ebird")) return { checklists: [] };
      return {};
    });
    const outerIndex = vi.fn();
    wrap(
      <>
        <Lightbox
          slides={[
            { url: "/api/photos/a/display", captureId: "g1" },
            { url: "/api/photos/b/display", captureId: "b" },
          ]}
          index={0}
          onIndexChange={outerIndex}
          onClose={() => {}}
        />
        <PhotoVersionsHost />
      </>,
    );
    act(() => openPhotoVersions("g1"));
    // Arrows over the dialog don't page the photo behind it.
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "View f0.jpg full size" }));
    await waitFor(() => expect(screen.getAllByRole("dialog", { name: "Photo viewer" })).toHaveLength(2));
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight" });
    expect(outerIndex).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.getAllByRole("dialog", { name: "Photo viewer" })).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Versions" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Versions" })).toBeNull());
    expect(screen.getAllByRole("dialog", { name: "Photo viewer" })).toHaveLength(1);
  });
});

describe("the Gallery's View menu", () => {
  it("offers every version as its own photo", () => {
    const onChange = vi.fn();
    render(<PhotoViewMenu sections={["versions"]} activeCount={0} allVersions={{ checked: false, onChange }} />);
    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show every version and RAW as its own photo" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("offers Version labels with the captions, on by default", async () => {
    const { usePhotoCaptionPrefs } = await import("../hooks/usePhotoCaptionPrefs");
    function Menu() {
      return <PhotoViewMenu sections={["captions"]} activeCount={0} captions={usePhotoCaptionPrefs()} />;
    }
    render(<Menu />);
    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    const box = screen.getByRole("checkbox", { name: "Version labels" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(localStorage.getItem("lifer:showVersionLabels")).toBe("false");
    fireEvent.click(box);
  });
});

describe("the notice after an import", () => {
  function Notice() {
    return <VersionNotice notice={useVersionNotice()} />;
  }

  it("says what was grouped, and once dismissed never comes back", async () => {
    wrap(<Notice />);
    expect(await screen.findByText("Found 4 versions of 2 photos. Each counts as one photo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/Found 4 versions/)).toBeNull());
    expect(JSON.parse(localStorage.getItem("lifer:versionNoticeSeen")!)).toBe("2026-11-12T10:00:00.000Z");
    expect(get).toHaveBeenCalledWith(expect.stringContaining("since=2026-11-12"), expect.anything());
  });

  it("stays away after a dismissal even when more versions are grouped", async () => {
    localStorage.setItem("lifer:versionNoticeSeen", JSON.stringify("2026-11-01T00:00:00.000Z"));
    get.mockImplementation(async (path: string) =>
      path.startsWith("/captures/version-summary")
        ? { versions: 3, photos: 3, latest: "2026-11-28T10:00:00.000Z" }
        : {},
    );
    wrap(<Notice />);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("since=2026-11-01"), expect.anything()),
    );
    expect(screen.queryByText(/Found 3 versions/)).toBeNull();
  });
});
