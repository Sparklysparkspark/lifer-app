// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegionSummary } from "@lifer/shared";

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
// maplibre-gl needs WebGL, which jsdom lacks.
vi.mock("../components/PacksMap", () => ({ default: () => null }));
// jsdom has no matchMedia; the sidebar layout check only needs an answer.
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const { default: OfflinePacksPage } = await import("./OfflinePacksPage");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ToastContext } = await import("../hooks/useToast");
const { resetAccountCaches } = await import("../lib/resource");
const { AuthContext } = await import("../hooks/useAuth");
const { resetPackDownloadStore } = await import("../lib/packDownloadStore");

function region(id: string, name: string, parentId: string | null): RegionSummary {
  return {
    id,
    name,
    parentId,
    ebirdRegionCode: null,
    boundaryGeoJson: null,
    hasChildren: false,
    hasScopedChecklist: true,
    sovereigntyGroup: null,
    isSovereignDependency: false,
  };
}

const regions = [region("w", "World", null), region("eu", "Europe", "w"), region("fr", "Freedonia", "eu")];

function pack(id: string, taxon: string | null, sizeBytes: number) {
  return {
    id,
    type: "region",
    region: "Freedonia",
    taxon,
    sizeBytes,
    speciesCount: 1,
    contentVersion: "v1",
    url: "",
    downloaded: false,
    updateAvailable: false,
  };
}

// Answers by path prefix, most specific first; anything unlisted never resolves.
function serve(downloadStatus: object = { running: false, finishedAt: null, error: null }) {
  const answers: Array<[string, unknown]> = [
    ["/regions/boundaries", { regions: [] }],
    ["/regions", { regions }],
    ["/offline-packs/index", { packs: [pack("p-all", null, 3000), pack("p-aves", "aves", 1000)] }],
    ["/offline-packs/download/status", downloadStatus],
    ["/settings", { deploymentMode: "server", dataDir: "/library", libraryRoots: [] }],
  ];
  get.mockImplementation((path: string) => {
    const hit = answers.find(([prefix]) => path === prefix || path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

const auth = { user: { id: "u1", email: "a@b.c" }, loading: false, login: vi.fn(), register: vi.fn(), logout: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderPage() {
  return render(
    <AuthContext.Provider value={auth}>
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter initialEntries={["/offline-packs"]}>
            <OfflinePacksPage />
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </AuthContext.Provider>,
  );
}

async function selectFreedonia() {
  fireEvent.click(await screen.findByRole("button", { name: "Europe" }));
  fireEvent.click(await screen.findByRole("button", { name: "Freedonia" }));
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  resetAccountCaches();
  resetPackDownloadStore();
  serve();
});

describe("OfflinePacksPage", () => {
  it("keeps the download button off until a country is picked", async () => {
    renderPage();
    const download = (await screen.findByRole("button", { name: "Download selected" })) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    await selectFreedonia();
    expect(download.disabled).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Birds" }));
    expect(download.disabled).toBe(false);
  });

  it("offers the selected country's animal groups from the pack index", async () => {
    renderPage();
    await selectFreedonia();
    expect(await screen.findByText(/1 region selected/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Birds" })).toBeTruthy();
  });

  it("downloads the picked animal groups, and nothing until one is picked", async () => {
    post.mockResolvedValue({});
    renderPage();
    await selectFreedonia();
    expect((screen.getByRole("button", { name: "Download selected" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Birds" }));
    fireEvent.click(screen.getByRole("button", { name: "Download selected" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/offline-packs/download-batch", {
        regionNames: ["Freedonia"],
        taxa: ["aves"],
        variant: "full",
      }),
    );
  });

  it("adds the selection to a running download's queue", async () => {
    const lane = { currentItem: null, processed: 0, total: 2, downloadedBytes: null, totalBytes: null };
    serve({
      running: true,
      phase: "downloading",
      currentItem: "Freedonia",
      total: 2,
      processed: 0,
      packIds: [],
      lanes: { download: { ...lane, currentItem: "Freedonia" }, setup: { ...lane, step: null }, photos: lane },
    });
    post.mockResolvedValue({ started: false, queued: 1, packIds: ["p-all"] });
    renderPage();
    await selectFreedonia();
    fireEvent.click(await screen.findByRole("button", { name: "Birds" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to queue" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/offline-packs/download-batch", {
        regionNames: ["Freedonia"],
        taxa: ["aves"],
        variant: "full",
      }),
    );
    expect(await screen.findByText("Added 1 region to the queue")).toBeTruthy();
    expect(screen.getByText("Nothing selected")).toBeTruthy();
    expect(screen.getByText("Freedonia, 1 of 2")).toBeTruthy();
  });

  it("shows why a download couldn't start", async () => {
    // A bug's own text never shows; the plain fallback does.
    post.mockRejectedValue(new TypeError("undefined is not a function"));
    renderPage();
    await selectFreedonia();
    fireEvent.click(await screen.findByRole("button", { name: "Birds" }));
    fireEvent.click(screen.getByRole("button", { name: "Download selected" }));
    expect(await screen.findByText("Couldn't start the download")).toBeTruthy();
  });
});
