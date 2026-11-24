// @vitest-environment jsdom
// Importing a folder again: known files never become rows, and what the user leaves out is remembered.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import { ConfirmContext } from "../hooks/useConfirm";
import { quickHash } from "../lib/knownFiles";
import { resetAccountCaches } from "../lib/resource";
import PhotoImportRows from "./PhotoImportRows";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
const mode = vi.hoisted(() => ({ value: "server" }));
vi.mock("../hooks/useDeploymentMode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useDeploymentMode")>()),
  useDeploymentMode: () => mode.value,
}));
vi.mock("../hooks/useJobPoll", () => ({ useJobPoll: () => ({ status: null }) }));
vi.mock("../lib/tusUpload", () => ({ uploadFile: vi.fn(async () => "up-1"), discardUpload: vi.fn() }));
vi.mock("../lib/localInference", () => ({
  computeClientVectors: vi.fn(async () => null),
  recordServerMatching: vi.fn(),
  shouldMatchLocally: () => false,
  prepareLocalInference: () => {},
  useLocalInferenceReady: () => false,
}));

const confirm = vi.fn(async () => true);
const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const heron = {
  id: "sp-heron",
  scientific_name: "Ardea herodias",
  common_name: "Great Blue Heron",
  score: 0.6,
  matchPercent: 60,
};
const jpeg = (name: string) => new File([`bytes of ${name}`], name, { type: "image/jpeg" });

let knownPrints = new Set<string>();

beforeEach(() => {
  resetAccountCaches();
  localStorage.clear();
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  knownPrints = new Set();
  mode.value = "server";
  get.mockImplementation((path: string) =>
    path === "/settings"
      ? Promise.resolve({ deploymentMode: "server", dataDir: "/data", libraryRoots: [] })
      : Promise.reject(new Error(`unexpected GET ${path}`)),
  );
  post.mockImplementation((path: string, body: { fingerprints?: string[] }) => {
    if (path === "/uploads/known")
      return Promise.resolve({
        known: body
          .fingerprints!.filter((f) => knownPrints.has(f))
          .map((fingerprint) => ({ fingerprint, status: "imported", reason: null })),
      });
    if (path === "/uploads/inspect")
      return Promise.resolve({ possibleDuplicate: null, suggestions: [heron], previewDataUrl: null });
    if (path === "/uploads") return Promise.resolve({ captureId: "cap-1" });
    if (path === "/uploads/skipped") return Promise.resolve({ ok: true });
    if (path === "/trips/matching") return Promise.resolve({ trips: [] });
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

function renderRows() {
  const { container } = render(
    <MemoryRouter>
      <ConfirmContext.Provider value={confirm}>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows />
        </ToastContext.Provider>
      </ConfirmContext.Provider>
    </MemoryRouter>,
  );
  return container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
}

// A desktop folder, imported from before, holding old.jpg (already in Lifer) and new.jpg.
function desktopFolder(extra: (path: string, body: unknown) => Promise<unknown> | undefined = () => undefined) {
  mode.value = "desktop";
  const folder = "/Users/me/Pictures/Tofino";
  get.mockImplementation((path: string) =>
    path === "/uploads/source-folders"
      ? Promise.resolve({ folders: [{ path: folder, lastImportedAt: "2026-11-01T00:00:00Z", photoCount: 1 }] })
      : path === "/settings"
        ? Promise.resolve({ deploymentMode: "desktop", dataDir: "/data", libraryRoots: [] })
        : Promise.reject(new Error(`unexpected GET ${path}`)),
  );
  const base = post.getMockImplementation()!;
  post.mockImplementation((path: string, body: unknown) => {
    if (path === "/uploads/source-folders/new-count") return Promise.resolve({ available: true, newCount: 1 });
    if (path === "/uploads/source-folders/scan")
      return Promise.resolve({
        files: [
          {
            path: `${folder}/old.jpg`,
            name: "old.jpg",
            size: 3,
            mtimeMs: 1,
            fingerprint: "a".repeat(40),
            status: "imported",
            edited: false,
          },
          {
            path: `${folder}/new.jpg`,
            name: "new.jpg",
            size: 3,
            mtimeMs: 2,
            fingerprint: "b".repeat(40),
            status: "new",
            edited: true,
          },
        ],
      });
    return extra(path, body) ?? base(path, body);
  });
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(decodeURIComponent(url.split("path=")[1]));
      return new Response("jpeg");
    }),
  );
  return { folder, fetched };
}

describe("PhotoImportRows, picking a folder again", () => {
  it("skips known files before upload, with one summary line and Import anyway", async () => {
    const files = ["old1.jpg", "old2.jpg", "new.jpg"].map(jpeg);
    knownPrints = new Set([await quickHash(files[0]), await quickHash(files[1])]);
    const input = renderRows();
    fireEvent.change(input, { target: { files } });

    expect(await screen.findByText("new.jpg")).toBeTruthy();
    expect(screen.getByText("2 of 3 files are already in Lifer, 1 is new")).toBeTruthy();
    expect(screen.queryByText("old1.jpg")).toBeNull();
    await waitFor(() => expect(post.mock.calls.filter((c) => c[0] === "/uploads/inspect")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    const list = screen.getByText("old1.jpg").closest("[data-known-row]") as HTMLElement;
    fireEvent.click(within(list).getByRole("button", { name: "Import anyway" }));
    await waitFor(() => expect(post.mock.calls.filter((c) => c[0] === "/uploads/inspect")).toHaveLength(2));
    expect(screen.getByText("1 of 3 files is already in Lifer, 2 are new")).toBeTruthy();
  });

  it("remembers a removed photo once the import starts", async () => {
    const files = [jpeg("keep.jpg"), jpeg("blurry.jpg")];
    const input = renderRows();
    fireEvent.change(input, { target: { files } });
    const blurry = (await screen.findByText("blurry.jpg")).closest("[data-import-row]") as HTMLElement;
    fireEvent.click(within(blurry).getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: /Great Blue Heron.*match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));

    await waitFor(() => expect(post.mock.calls.some((c) => c[0] === "/uploads/skipped")).toBe(true));
    const body = post.mock.calls.find((c) => c[0] === "/uploads/skipped")![1];
    expect(body).toEqual({
      files: [{ fingerprint: await quickHash(files[1]), name: "blurry.jpg", size: files[1].size, reason: "removed" }],
    });
  });

  it("imports a recent folder's new photos in one click (desktop)", async () => {
    const { folder, fetched } = desktopFolder();
    renderRows();
    const chip = await screen.findByRole("button", { name: "Import new photos from Tofino" });
    await waitFor(() => expect(chip.textContent).toContain("1 new photo"));
    expect(post.mock.calls.some((c) => c[0] === "/uploads/source-folders/scan")).toBe(false);

    fireEvent.click(chip);
    expect(await screen.findByText("new.jpg")).toBeTruthy();
    expect(fetched).toEqual([`${folder}/new.jpg`]);
    expect(screen.getByText("1 of 2 files is already in Lifer, 1 is new")).toBeTruthy();
    expect(screen.getByText("1 looks like an edited copy of a photo you imported")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("offers Move photos only on the desktop, off by default", async () => {
    renderRows();
    expect(screen.queryByRole("switch", { name: "Move photos into my library" })).toBeNull();
  });

  it("with Move on, moves each imported file and clears the ones already in Lifer in one pass", async () => {
    const { folder } = desktopFolder((path) => {
      if (path === "/uploads")
        return Promise.resolve({ captureId: "cap-1", sourceMove: { moved: true, reason: null } });
      if (path === "/uploads/source-folders/clear")
        return Promise.resolve({ cleared: 1, trashed: [`${folder}/old.jpg`], kept: [] });
      return undefined;
    });
    renderRows();
    const move = screen.getByRole("switch", { name: "Move photos into my library" });
    expect(move.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(move);
    expect(localStorage.getItem("lifer:import.moveOriginals")).toBe("1");

    fireEvent.click(await screen.findByRole("button", { name: "Import new photos from Tofino" }));
    fireEvent.click(await screen.findByRole("button", { name: /Great Blue Heron.*match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));

    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    const upload = post.mock.calls.find((c) => c[0] === "/uploads")!;
    expect((upload[1] as FormData).get("moveSourcePath")).toBe(`${folder}/new.jpg`);
    expect(post.mock.calls.find((c) => c[0] === "/uploads/source-folders/clear")![1]).toEqual({
      paths: [`${folder}/old.jpg`],
    });
    expect(vi.mocked(toast.show).mock.calls[0][0]).toBe(
      "1 photo filed under 1 species. Moved 1 photo into your library. Cleared 1 already in Lifer.",
    );
  });

  it("says in plain words why an original stayed, and counts it", async () => {
    localStorage.setItem("lifer:import.moveOriginals", "1");
    desktopFolder((path) =>
      path === "/uploads"
        ? Promise.resolve({ captureId: "cap-1", sourceMove: { moved: false, reason: "no_library_copy" } })
        : path === "/uploads/source-folders/clear"
          ? Promise.resolve({ cleared: 0, trashed: [], kept: [] })
          : undefined,
    );
    renderRows();
    fireEvent.click(await screen.findByRole("button", { name: "Import new photos from Tofino" }));
    fireEvent.click(await screen.findByRole("button", { name: /Great Blue Heron.*match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
    expect(
      await screen.findByText(
        "✓ Imported The original stays where it is: Lifer couldn't confirm its copy in your library.",
      ),
    ).toBeTruthy();
    expect(vi.mocked(toast.show).mock.calls[0][0]).toBe(
      "1 photo filed under 1 species. Moved 0 photos into your library. 1 skipped, still where it was.",
    );
  });

  it("clears out the files already in Lifer after saying how many", async () => {
    const { folder } = desktopFolder((path, body) =>
      path === "/uploads/source-folders/clear"
        ? Promise.resolve(
            (body as { dryRun: boolean }).dryRun
              ? { cleared: 1, trashed: [], kept: [] }
              : { cleared: 1, trashed: [`${folder}/old.jpg`], kept: [] },
          )
        : undefined,
    );
    renderRows();
    fireEvent.click(await screen.findByRole("button", { name: "Import new photos from Tofino" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear out the ones already in Lifer" }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Move 1 file to the Trash?" })),
    );
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        "Moved 1 file to the Trash. It's still there if you need it.",
        expect.anything(),
      ),
    );
    expect(screen.queryByText(/already in Lifer, /)).toBeNull();
  });
});
