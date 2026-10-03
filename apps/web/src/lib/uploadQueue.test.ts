import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../api/client", () => ({
  api: { post: (...args: unknown[]) => post(...args) },
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const uploadFile = vi.fn();
vi.mock("./tusUpload", () => ({
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  discardUpload: vi.fn(),
}));

const { enqueueUploads, resolveDuplicate, getUploadQueueState, suggestSpeciesFromVideo } = await import("./uploadQueue");
const { ApiError } = await import("../api/client");

const dup = { captureId: "c1", speciesName: "Cedar Waxwing", takenAt: null, exact: true };

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

describe("upload queue duplicate prompts", () => {
  beforeEach(() => {
    post.mockReset();
    uploadFile.mockReset();
    uploadFile.mockImplementation(async (file: File) => `u_${file.name}`);
  });

  it("queues concurrent duplicate prompts and resolves only the answered one", async () => {
    post.mockImplementation(async (path: string) => (path === "/uploads/inspect" ? { possibleDuplicate: dup } : {}));
    const files = ["a.jpg", "b.jpg", "c.jpg"].map((name) => new File(["x"], name, { type: "image/jpeg" }));
    enqueueUploads("species-1", files);

    // All three concurrent jobs hit a duplicate; none may overwrite another's prompt.
    await waitFor(() => getUploadQueueState().pendingDuplicates.length === 3);
    const [first, second, third] = getUploadQueueState().pendingDuplicates;
    expect([first.fileName, second.fileName, third.fileName]).toEqual(["a.jpg", "b.jpg", "c.jpg"]);

    resolveDuplicate(second.jobId, "skip");
    expect(getUploadQueueState().pendingDuplicates.map((d) => d.jobId)).toEqual([first.jobId, third.jobId]);

    resolveDuplicate(first.jobId, "import");
    resolveDuplicate(third.jobId, "import");
    await waitFor(() => getUploadQueueState().jobs.every((j) => j.done));

    const jobs = getUploadQueueState().jobs;
    expect(jobs.filter((j) => j.skipped).map((j) => j.fileName)).toEqual(["b.jpg"]);
    const imports = post.mock.calls.filter(([path]) => path === "/uploads");
    expect(imports).toHaveLength(2);
    // Each file is sent once: the import names the upload the check used.
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(imports.map(([, form]) => (form as FormData).get("uploadId")).sort()).toEqual(["u_a.jpg", "u_c.jpg"]);
    expect(imports.every(([, form]) => !(form as FormData).has("file"))).toBe(true);
    expect(getUploadQueueState().pendingDuplicates).toEqual([]);
  });
});

describe("video species suggestions", () => {
  beforeEach(() => post.mockReset());

  it("asks by uploadId and sends the file again only after a 410", async () => {
    const gone = new ApiError(410, "gone");
    post.mockRejectedValueOnce(gone).mockResolvedValueOnce({ suggestions: [], uploadId: "u2" });
    const upload = vi.fn(async (fresh: boolean) => (fresh ? "u2" : "u1"));
    const res = await suggestSpeciesFromVideo<{ uploadId: string }>(upload, "region-1");
    expect(res.uploadId).toBe("u2");
    expect(upload.mock.calls).toEqual([[false], [true]]);
    const forms = post.mock.calls.map(([path, form]) => [path, (form as FormData).get("uploadId"), (form as FormData).get("regionId"), (form as FormData).has("file")]);
    expect(forms).toEqual([
      ["/captures/suggest-species-from-video", "u1", "region-1", false],
      ["/captures/suggest-species-from-video", "u2", "region-1", false],
    ]);
  });

  it("passes other errors through without resending", async () => {
    post.mockRejectedValueOnce(new ApiError(500, "nope"));
    const upload = vi.fn(async () => "u1");
    await expect(suggestSpeciesFromVideo(upload, null)).rejects.toThrow("nope");
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
