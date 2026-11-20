// @vitest-environment jsdom
// Importing a folder again: known files never become rows, and what the user leaves out is remembered.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
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
      <ToastContext.Provider value={toast}>
        <PhotoImportRows />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
}

describe("PhotoImportRows, picking a folder again", () => {
  it("skips known files before upload, with one summary line and Import anyway", async () => {
    const files = ["old1.jpg", "old2.jpg", "new.jpg"].map(jpeg);
    knownPrints = new Set([await quickHash(files[0]), await quickHash(files[1])]);
    const input = renderRows();
    fireEvent.change(input, { target: { files } });

    expect(await screen.findByText("new.jpg")).toBeTruthy();
    expect(screen.getByText("2 already imported or skipped before, 1 new")).toBeTruthy();
    expect(screen.queryByText("old1.jpg")).toBeNull();
    await waitFor(() => expect(post.mock.calls.filter((c) => c[0] === "/uploads/inspect")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    const list = screen.getByText("old1.jpg").closest("[data-known-row]") as HTMLElement;
    fireEvent.click(within(list).getByRole("button", { name: "Import anyway" }));
    await waitFor(() => expect(post.mock.calls.filter((c) => c[0] === "/uploads/inspect")).toHaveLength(2));
    expect(screen.getByText("1 already imported or skipped before, 2 new")).toBeTruthy();
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
      return base(path, body);
    });
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(decodeURIComponent(url.split("path=")[1]));
        return new Response("jpeg");
      }),
    );
    renderRows();
    const chip = await screen.findByRole("button", { name: "Import new photos from Tofino" });
    await waitFor(() => expect(chip.textContent).toContain("1 new photo"));
    expect(post.mock.calls.some((c) => c[0] === "/uploads/source-folders/scan")).toBe(false);

    fireEvent.click(chip);
    expect(await screen.findByText("new.jpg")).toBeTruthy();
    expect(fetched).toEqual([`${folder}/new.jpg`]);
    expect(screen.getByText("1 already imported or skipped before, 1 new")).toBeTruthy();
    expect(screen.getByText("1 looks like an edited copy of a photo you imported")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
