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
  });
});
