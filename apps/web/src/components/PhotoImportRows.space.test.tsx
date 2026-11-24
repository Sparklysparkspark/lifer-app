// @vitest-environment jsdom
// A nearly full disk: the import goes one photo at a time when space is tight, pauses with what
// was imported kept when the drive fills, and Continue checks again and imports the rest.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import { ConfirmContext } from "../hooks/useConfirm";
import type { ImportSpace } from "../lib/importSpace";
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
vi.mock("../hooks/useJobPoll", () => ({ useJobPoll: () => ({ status: null }) }));
vi.mock("../lib/tusUpload", () => ({ uploadFile: vi.fn(async () => "up-1"), discardUpload: vi.fn() }));
vi.mock("../lib/localInference", () => ({
  computeClientVectors: vi.fn(async () => null),
  recordServerMatching: vi.fn(),
  shouldMatchLocally: () => false,
  prepareLocalInference: () => {},
  useLocalInferenceReady: () => false,
}));

const GB = 1e9;
const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const heron = { id: "sp-heron", scientific_name: "Ardea herodias", common_name: "Great Blue Heron", score: 0.6 };
const jpeg = (name: string) => new File([`bytes of ${name}`], name, { type: "image/jpeg" });

let space: ImportSpace;
/** What each POST /uploads answers, in turn. */
let uploads: Array<() => Promise<unknown>>;

beforeEach(() => {
  resetAccountCaches();
  localStorage.clear();
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  space = { tier: "ok", free: 400 * GB, toFree: 0 };
  uploads = [];
  get.mockImplementation((path: string) =>
    path === "/settings"
      ? Promise.resolve({ deploymentMode: "server", dataDir: "/data", libraryRoots: [] })
      : Promise.reject(new Error(`unexpected GET ${path}`)),
  );
  post.mockImplementation((path: string) => {
    if (path === "/uploads/space") return Promise.resolve(space);
    if (path === "/uploads/known") return Promise.resolve({ known: [] });
    if (path === "/uploads/inspect")
      return Promise.resolve({ possibleDuplicate: null, suggestions: [heron], previewDataUrl: null });
    if (path === "/uploads") return uploads.shift()!();
    if (path === "/uploads/skipped") return Promise.resolve({ ok: true });
    if (path === "/trips/matching") return Promise.resolve({ trips: [] });
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

function renderRows() {
  const { container } = render(
    <MemoryRouter>
      <ConfirmContext.Provider value={vi.fn(async () => true)}>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows />
        </ToastContext.Provider>
      </ConfirmContext.Provider>
    </MemoryRouter>,
  );
  return container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
}

async function addAndPick(names: string[]) {
  fireEvent.change(renderRows(), { target: { files: names.map(jpeg) } });
  for (const name of names) await screen.findByText(name);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /Great Blue Heron.*match/ })).toHaveLength(names.length),
  );
  for (const b of screen.getAllByRole("button", { name: /Great Blue Heron.*match/ })) fireEvent.click(b);
}

const uploadCalls = () => post.mock.calls.filter((c) => c[0] === "/uploads").length;

describe("PhotoImportRows on a nearly full disk", () => {
  it("asks about the batch when files are added and says so calmly when space is tight", async () => {
    space = { tier: "tight", free: 20 * GB, toFree: 0 };
    await addAndPick(["a.jpg", "b.jpg"]);
    const asked = post.mock.calls.find((c) => c[0] === "/uploads/space")![1];
    expect(asked).toEqual({ files: 2, bytes: jpeg("a.jpg").size + jpeg("b.jpg").size });
    expect(screen.getByText(/Your disk is nearly full, so Lifer will match photos in smaller batches/)).toBeTruthy();
  });

  it("pauses when the drive fills, keeps what was imported, and Continue imports the rest", async () => {
    await addAndPick(["a.jpg", "b.jpg"]);
    uploads = [
      async () => ({ captureId: "cap-1" }),
      async () => {
        space = { tier: "critical", free: 2.1 * GB, toFree: 6 * GB };
        throw new ApiError(507, "Not enough free space", "disk_full");
      },
    ];
    fireEvent.click(screen.getByRole("button", { name: "Import 2 photos" }));

    expect(
      await screen.findByText(
        "Lifer paused the import with 2.1 GB free so your library isn't harmed. 1 of 2 photos were imported; the rest are still where they were. Free at least 6 GB and press Continue.",
      ),
    ).toBeTruthy();
    // The held-back photo is ready again, not failed.
    expect(screen.getByRole("button", { name: "Import 1 photo" })).toBeTruthy();

    // Still full: Continue checks again and stays paused.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(post.mock.calls.filter((c) => c[0] === "/uploads/space").length).toBeGreaterThan(3));
    expect(uploadCalls()).toBe(2);
    expect(screen.getByText(/Lifer paused the import/)).toBeTruthy();

    // Room again: the rest goes in.
    space = { tier: "ok", free: 400 * GB, toFree: 0 };
    uploads = [async () => ({ captureId: "cap-2" })];
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(uploadCalls()).toBe(3));
    await waitFor(() => expect(screen.queryByText(/Lifer paused the import/)).toBeNull());
  });

  it("too full to start: nothing is sent, and the page says how much to free", async () => {
    await addAndPick(["a.jpg"]);
    space = { tier: "critical", free: 2.5 * GB, toFree: 1.5 * GB };
    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
    expect(
      await screen.findByText(
        "Your disk is too full to import with 2.5 GB free. Free at least 1.5 GB and press Continue.",
      ),
    ).toBeTruthy();
    expect(uploadCalls()).toBe(0);
  });
});
