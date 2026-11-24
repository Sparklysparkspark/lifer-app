// @vitest-environment jsdom
// A batch going into no trip: a group that looks like part of a trip is asked about, never added.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
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

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const heron = { id: "sp-heron", scientific_name: "Ardea herodias", common_name: "Great Blue Heron", score: 0.6 };
const osa = { id: "trip-osa", name: "Osa Peninsula", from: "2026-05-03T00:00:00Z", to: "2026-05-10T23:59:59Z" };
const peru = { id: "trip-peru", name: "Peru", from: "2026-05-01T00:00:00Z", to: "2026-05-12T23:59:59Z" };
let offers: Array<typeof osa> = [osa];

beforeEach(() => {
  resetAccountCaches();
  localStorage.clear();
  vi.clearAllMocks();
  offers = [osa];
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  get.mockImplementation((path: string) =>
    path === "/settings"
      ? Promise.resolve({ deploymentMode: "server", dataDir: "/data", libraryRoots: [] })
      : Promise.reject(new Error(`unexpected GET ${path}`)),
  );
  post.mockImplementation((path: string, body: { groups?: Array<{ key: string }> }) => {
    if (path === "/uploads/inspect")
      return Promise.resolve({
        possibleDuplicate: null,
        suggestions: [heron],
        previewDataUrl: null,
        takenAt: "2026-05-04T15:00:00Z",
        cameraTime: "2026-05-04T09:00:00",
      });
    if (path === "/trips/import-suggestions")
      return Promise.resolve({ groups: body.groups!.map((g) => ({ key: g.key, trips: offers })) });
    if (path === "/uploads") return Promise.resolve({ captureId: "cap-1" });
    if (path === "/uploads/known") return Promise.resolve({ known: [] });
    if (path === "/uploads/skipped") return Promise.resolve({ ok: true });
    if (path === "/trips/matching") return Promise.resolve({ trips: [] });
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

function pick(tripId?: string) {
  const { container } = render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <PhotoImportRows tripId={tripId} />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
  const files = ["a.jpg", "b.jpg"].map((n) => new File([n], n, { type: "image/jpeg" }));
  fireEvent.change(input, { target: { files } });
}

const imported = () => post.mock.calls.filter((c) => c[0] === "/uploads").map((c) => (c[1] as FormData).get("tripId"));

describe("PhotoImportRows, trip suggestion", () => {
  it("asks about the trip the photos fit, and Add to trip imports them into it", async () => {
    pick();
    expect(
      await screen.findByText(/These 2 photos look like part of Osa Peninsula \(.+\)\. Add them to that trip\?/),
    ).toBeTruthy();
    expect(post.mock.calls.find((c) => c[0] === "/trips/import-suggestions")![1].groups[0]).toMatchObject({
      times: ["2026-05-04T15:00:00Z", "2026-05-04T15:00:00Z"],
      points: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to trip" }));
    expect(screen.getByText("These 2 photos go into Osa Peninsula.")).toBeTruthy();

    for (const b of await screen.findAllByRole("button", { name: /Great Blue Heron/ })) fireEvent.click(b);
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 photos" }));
    await waitFor(() => expect(imported()).toEqual(["trip-osa", "trip-osa"]));
  });

  it("Remove from trip takes them back out before importing", async () => {
    pick();
    fireEvent.click(await screen.findByRole("button", { name: "Add to trip" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from trip" }));
    expect(screen.getByRole("button", { name: "Add to trip" })).toBeTruthy();
    for (const b of await screen.findAllByRole("button", { name: /Great Blue Heron/ })) fireEvent.click(b);
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 photos" }));
    await waitFor(() => expect(imported()).toEqual([null, null]));
  });

  it("offers both trips when two fit, and Not now puts the question away", async () => {
    offers = [osa, peru];
    pick();
    expect(
      await screen.findByText("These 2 photos look like part of one of your trips. Add them to one?"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Add to Osa Peninsula/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Add to Peru/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/look like part of/)).toBeNull();
  });

  it("never asks when the batch already goes into a trip", async () => {
    pick("trip-osa");
    await screen.findByText("a.jpg");
    await new Promise((r) => setTimeout(r, 700));
    expect(post.mock.calls.some((c) => c[0] === "/trips/import-suggestions")).toBe(false);
  });
});
