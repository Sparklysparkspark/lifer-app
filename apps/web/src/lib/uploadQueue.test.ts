import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../api/client", () => ({
  api: { post: (...args: unknown[]) => post(...args) },
  ApiError: class ApiError extends Error {},
}));

const { enqueueUploads, resolveDuplicate, getUploadQueueState } = await import("./uploadQueue");

const dup = { captureId: "c1", speciesName: "Cedar Waxwing", takenAt: null, exact: true };

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

describe("upload queue duplicate prompts", () => {
  beforeEach(() => post.mockReset());

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
    expect(post.mock.calls.filter(([path]) => path === "/uploads")).toHaveLength(2);
    expect(getUploadQueueState().pendingDuplicates).toEqual([]);
  });
});
