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
  it("removing a photo says so, with Undo putting it back", async () => {
    const { container } = render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    fireEvent.change(input, { target: { files: [new File(["jpeg"], "heron.jpg", { type: "image/jpeg" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.queryByText("heron.jpg")).toBeNull();
    const [message, options] = vi.mocked(toast.show).mock.calls.at(-1)!;
    expect(message).toBe("Removed 1 file from this import. Lifer won't offer it again from this folder.");
    options!.actions![0].onClick();
    expect(await screen.findByText("heron.jpg")).toBeTruthy();
  });

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

    expect(await screen.findByText("Imported")).toBeTruthy();
    // Its species went with it: nothing left to change, compare or tick.
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "heron.jpg" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Great Blue Heron" })).toBeNull();
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

    expect(await screen.findByText("Edited version of the photo you already have")).toBeTruthy();
    expect(screen.getByText("American Pygmy Kingfisher")).toBeTruthy();
    expect(screen.queryByText(/already imported/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Import anyway" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
    expect(await screen.findByText("Imported")).toBeTruthy();
    const commit = post.mock.calls.find((c) => c[0] === "/uploads")!;
    expect(formFields(commit[1]).speciesId).toBe("sp-kingfisher");
  });

  it("treats a RAW and its JPG in one import as one photo, imported in one request", async () => {
    uploadFile.mockImplementation(async (f: File) => `up-${f.name}`);
    post.mockImplementation((path: string) => {
      if (path === "/uploads/inspect")
        return Promise.resolve({
          possibleDuplicate: null,
          suggestions: [heron, egret],
          previewDataUrl: null,
          takenAt: "2026-11-20T07:12:33.000Z",
          versionEvidence: { documentId: null, press: null },
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
    fireEvent.change(input, {
      target: {
        files: [new File(["raw"], "6F9A8074.CR3"), new File(["jpeg"], "6F9A8074.jpg", { type: "image/jpeg" })],
      },
    });

    // The JPG follows the RAW: no suggestions or Compare of its own.
    expect(await screen.findByText("Same photo as 6F9A8074.CR3")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Great Blue Heron.*match/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Compare" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Great Blue Heron.*match/ }));
    expect(screen.getAllByText("Great Blue Heron")).toHaveLength(2);
    expect((screen.getByRole("checkbox", { name: "6F9A8074.jpg" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/1 ready to import/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
    await waitFor(() => expect(screen.getAllByText("Imported")).toHaveLength(2));
    const commits = post.mock.calls.filter((c) => c[0] === "/uploads");
    expect(commits).toHaveLength(1);
    expect(formFields(commits[0][1])).toMatchObject({
      speciesId: "sp-heron",
      uploadId: "up-6F9A8074.jpg",
      rawUploadId: "up-6F9A8074.CR3",
    });
    expect(vi.mocked(toast.show).mock.calls[0][0]).toBe("1 photo filed under 1 species");
  });

  it("keeps the other file of a pair when one is removed", async () => {
    post.mockImplementation((path: string) =>
      path === "/uploads/inspect"
        ? Promise.resolve({
            possibleDuplicate: null,
            suggestions: [heron],
            previewDataUrl: null,
            takenAt: "2026-11-20T07:12:33.000Z",
            versionEvidence: { documentId: null, press: null },
          })
        : Promise.reject(new Error(`unexpected POST ${path}`)),
    );
    const { container } = render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    fireEvent.change(input, {
      target: {
        files: [new File(["raw"], "6F9A8074.CR3"), new File(["jpeg"], "6F9A8074.jpg", { type: "image/jpeg" })],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Great Blue Heron.*match/ }));
    // The RAW row's remove button comes first.
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(screen.queryByText("6F9A8074.CR3")).toBeNull();
    expect(screen.queryByText(/Same photo as/)).toBeNull();
    expect(screen.getByText("Great Blue Heron")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "6F9A8074.jpg" }) as HTMLInputElement).checked).toBe(true);
  });

  describe("started from a species page", () => {
    const kingfisher = { id: "sp-ak", scientific_name: "Chloroceryle amazona", common_name: "Amazon Kingfisher" };
    const hawk = {
      id: "sp-bch",
      scientific_name: "Busarellus nigricollis",
      common_name: "Black-collared Hawk",
      score: 0.8,
      matchPercent: 80,
      confident: true,
    };
    const page = (props: Partial<Parameters<typeof PhotoImportRows>[0]> = {}) => (
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <PhotoImportRows presetSpecies={kingfisher} {...props} />
        </ToastContext.Provider>
      </MemoryRouter>
    );
    const drop = (container: HTMLElement, files: File[]) =>
      fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"][accept]')!, {
        target: { files },
      });
    const cr3 = () => new File(["raw"], "6F9A8042.CR3", { type: "" });

    beforeEach(() => {
      post.mockImplementation((path: string) => {
        if (path === "/uploads/inspect")
          return Promise.resolve({ possibleDuplicate: null, suggestions: [hawk], previewDataUrl: null });
        if (path === "/uploads") return Promise.resolve({ captureId: "cap-1" });
        return Promise.reject(new Error(`unexpected POST ${path}`));
      });
    });

    it("imports a RAW the match disagrees with under the page's species, to the chosen drive", async () => {
      const { container } = render(page({ volumeId: "vol-1" }));
      drop(container, [cr3()]);
      expect(await screen.findByText("Looks like Black-collared Hawk")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Amazon Kingfisher" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
      expect(await screen.findByText("Imported")).toBeTruthy();
      const commit = post.mock.calls.find((c) => c[0] === "/uploads")!;
      expect(formFields(commit[1])).toMatchObject({ speciesId: "sp-ak", volumeId: "vol-1", fileName: "6F9A8042.CR3" });
    });

    it("switches to the match in one click", async () => {
      const { container } = render(page());
      drop(container, [cr3()]);
      fireEvent.click(await screen.findByRole("button", { name: "Use Black-collared Hawk" }));
      expect(screen.queryByText("Looks like Black-collared Hawk")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
      expect(await screen.findByText("Imported")).toBeTruthy();
      expect(formFields(post.mock.calls.find((c) => c[0] === "/uploads")![1]).speciesId).toBe("sp-bch");
    });

    it("names a file it can't import instead of dropping it silently", async () => {
      const { container } = render(page());
      drop(container, [new File(["x"], "notes.txt", { type: "text/plain" }), cr3()]);
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Skipped a file that isn't a photo, RAW or video Lifer can read: notes.txt",
      );
      expect(await screen.findByText("6F9A8042.CR3")).toBeTruthy();
    });

    it("a RAW of a photo filed as another species shows it, and choosing the page's species corrects that photo", async () => {
      post.mockImplementation((path: string) => {
        if (path === "/uploads/inspect")
          return Promise.resolve({
            possibleDuplicate: null,
            suggestions: [],
            previewDataUrl: null,
            rawMatch: {
              captureId: "cap-hawk",
              speciesId: "sp-bch",
              speciesName: "Black-collared Hawk",
              scientificName: "Busarellus nigricollis",
              commonName: "Black-collared Hawk",
            },
          });
        if (path === "/uploads") return Promise.resolve({ captureId: "cap-hawk", linkedExisting: true });
        return Promise.reject(new Error(`unexpected POST ${path}`));
      });
      patch.mockResolvedValue({ ok: true });
      const { container } = render(page());
      drop(container, [cr3()]);
      expect(await screen.findByText("RAW for your photo already in Lifer")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Black-collared Hawk" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Use Amazon Kingfisher" }));
      fireEvent.click(screen.getByRole("button", { name: "Import 1 photo" }));
      expect(await screen.findByText("Imported")).toBeTruthy();
      expect(patch).toHaveBeenCalledWith("/captures/cap-hawk/reassign", { speciesId: "sp-ak" });
    });
  });
});
