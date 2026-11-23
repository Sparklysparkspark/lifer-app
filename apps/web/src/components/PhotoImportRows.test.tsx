// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import { resetAccountCaches } from "../lib/resource";
import PhotoImportRows from "./PhotoImportRows";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

// The tus transfer itself is out of scope: the upload just finishes with a known id.
const uploadFile = vi.fn();
// The species-matching download's status, set per test.
const matchingJob = vi.hoisted(() => ({ status: null as { running: boolean } | null }));
vi.mock("../hooks/useJobPoll", () => ({ useJobPoll: () => ({ status: matchingJob.status }) }));
vi.mock("../lib/tusUpload", () => ({
  uploadFile: (...a: unknown[]) => uploadFile(...a),
  discardUpload: vi.fn(),
}));

// On-device matching needs the desktop shell and ONNX models; the server does the matching here.
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
const egret = {
  id: "sp-egret",
  scientific_name: "Egretta thula",
  common_name: "Snowy Egret",
  score: 0.3,
  matchPercent: 30,
};

function formFields(form: unknown): Record<string, string> {
  return Object.fromEntries([...(form as FormData).entries()].map(([k, v]) => [k, String(v)]));
}

beforeEach(() => {
  matchingJob.status = null;
  resetAccountCaches();
  localStorage.clear();
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  get.mockImplementation((path: string) => {
    if (path === "/settings") {
      return Promise.resolve({ deploymentMode: "server", dataDir: "/data", libraryRoots: [] });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  uploadFile.mockResolvedValue("up-1");
  post.mockImplementation((path: string) => {
    if (path === "/uploads/inspect") {
      return Promise.resolve({ possibleDuplicate: null, suggestions: [heron, egret], previewDataUrl: null });
    }
    if (path === "/uploads") return Promise.resolve({ captureId: "cap-1" });
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

describe("PhotoImportRows", () => {
  it("says matching is still downloading, then checks a waiting photo again once it's done", async () => {
    localStorage.setItem("lifer:lastRegionId", "bc");
    matchingJob.status = { running: true };
    get.mockImplementation((path: string) => {
      if (path === "/settings")
        return Promise.resolve({
          deploymentMode: "server",
          dataDir: "/data",
          libraryRoots: [],
          speciesSuggestEnabled: true,
        });
      if (path === "/regions") return Promise.resolve({ regions: [] });
      if (path.startsWith("/places")) return Promise.resolve({ places: [] });
      if (path === "/offline-packs/index") return Promise.resolve({ generatedAt: "", packs: [] });
      return Promise.resolve({});
    });
    post.mockImplementation((path: string) =>
      path === "/uploads/inspect"
        ? Promise.resolve({ possibleDuplicate: null, suggestions: [], previewDataUrl: null })
        : Promise.reject(new Error(`unexpected POST ${path}`)),
    );
    const page = () => (
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows />
        </ToastContext.Provider>
      </MemoryRouter>
    );
    const { container, rerender } = render(page());
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    fireEvent.change(input, { target: { files: [new File(["jpeg"], "heron.jpg", { type: "image/jpeg" })] } });
    expect(await screen.findByText(/Species suggestions are still downloading/)).toBeTruthy();
    const inspects = () => post.mock.calls.filter((c) => c[0] === "/uploads/inspect").length;
    await waitFor(() => expect(inspects()).toBe(1));

    matchingJob.status = { running: false };
    rerender(page());
    await waitFor(() => expect(inspects()).toBe(2));
    expect(screen.queryByText(/Species suggestions are still downloading/)).toBeNull();
  });

  it("imports a dropped photo with the species picked from its suggestions", async () => {
    const onImported = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows onImported={onImported} />
        </ToastContext.Provider>
      </MemoryRouter>,
    );

    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    const file = new File(["jpeg bytes"], "heron.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("heron.jpg")).toBeTruthy();
    // The check reuses the finished upload rather than sending the file again.
    const pick = await screen.findByRole("button", { name: /Great Blue Heron.*match/ });
    const inspect = post.mock.calls.find((c) => c[0] === "/uploads/inspect")!;
    expect(formFields(inspect[1]).uploadId).toBe("up-1");

    fireEvent.click(pick);
    const importButton = screen.getByRole("button", { name: "Import 1 photo" });
    fireEvent.click(importButton);

    expect(await screen.findByText("✓ Imported")).toBeTruthy();
    const commit = post.mock.calls.find((c) => c[0] === "/uploads")!;
    expect(formFields(commit[1])).toMatchObject({
      speciesId: "sp-heron",
      uploadId: "up-1",
      fileName: "heron.jpg",
      mode: "store",
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Undo last import (1)" })).toBeTruthy();

    // The result also goes in a toast, whose Undo works after the page is left.
    const [message, options] = vi.mocked(toast.show).mock.calls[0];
    expect(message).toBe("1 photo filed under 1 species");
    del.mockResolvedValue({});
    options!.actions!.find((a) => a.label === "Undo")!.onClick();
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Undo last import/ })).toBeNull());
  });

  it("files an edited copy of a RAW you have with that photo's species, without a duplicate warning", async () => {
    post.mockImplementation((path: string) => {
      if (path === "/uploads/inspect")
        return Promise.resolve({
          possibleDuplicate: null,
          suggestions: [],
          previewDataUrl: null,
          editedVersionOf: {
            captureId: "cap-raw",
            photoId: "ph-raw",
            speciesId: "sp-kingfisher",
            speciesName: "American Pygmy Kingfisher",
            scientificName: "Chloroceryle aenea",
            commonName: "American Pygmy Kingfisher",
            takenAt: "2026-11-11T07:12:33Z",
          },
        });
      if (path === "/uploads") return Promise.resolve({ captureId: "cap-1" });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    const { container } = render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    fireEvent.change(input, { target: { files: [new File(["jpeg"], "6F9A6672.jpg", { type: "image/jpeg" })] } });

    expect(await screen.findByText("· Edited version of the photo you already have")).toBeTruthy();
    expect(screen.getByText("American Pygmy Kingfisher")).toBeTruthy();
    expect(screen.queryByText(/already imported/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Import anyway" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
    expect(await screen.findByText("✓ Imported")).toBeTruthy();
    const commit = post.mock.calls.find((c) => c[0] === "/uploads")!;
    expect(formFields(commit[1]).speciesId).toBe("sp-kingfisher");
  });
});
