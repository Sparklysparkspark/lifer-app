import { describe, expect, it, vi } from "vitest";
import { commitImport, importFields, resetUndoneRows, undoImports, type ImportTarget } from "./importCommit";

const photo: ImportTarget = {
  speciesId: "sp1",
  isVideo: false,
  cullOption: "skip",
  tripId: "trip1",
  regionId: "r1",
  locationLabel: "  Prince George ",
};

describe("importFields", () => {
  it("sends store mode and cull marks for photos only, and trims the place name", () => {
    expect(importFields(photo)).toEqual([
      ["mode", "store"],
      ["cullMarks", "skip"],
      ["speciesId", "sp1"],
      ["tripId", "trip1"],
      ["regionId", "r1"],
      ["locationLabel", "Prince George"],
    ]);
    expect(importFields({ ...photo, isVideo: true, tripId: undefined, regionId: null, locationLabel: " " })).toEqual([
      ["speciesId", "sp1"],
    ]);
  });
});

describe("commitImport", () => {
  it("posts the reused upload to the endpoint for its kind", async () => {
    const post = vi.fn().mockResolvedValue({ captureId: "c1" });
    const outcome = await commitImport({ ...photo, isVideo: true }, { ensureUploaded: async () => "up1", post });
    expect(outcome).toEqual({ kind: "imported", captureId: "c1" });
    expect(post).toHaveBeenCalledWith("/uploads/video", "up1", expect.any(Function));
    const form = new FormData();
    post.mock.calls[0][2](form);
    expect(form.get("speciesId")).toBe("sp1");
  });

  it("reports a photo the server skipped as a culling reject", async () => {
    const post = vi.fn().mockResolvedValue({ skipped: "rejected" });
    await expect(commitImport(photo, { ensureUploaded: async () => "up1", post })).resolves.toEqual({
      kind: "rejected",
    });
  });

  it("fails without posting when the upload fails", async () => {
    const post = vi.fn();
    await expect(
      commitImport(photo, { ensureUploaded: () => Promise.reject(new Error("too large")), post }),
    ).rejects.toThrow("too large");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("undo", () => {
  const batch = [
    { key: "a", captureId: "c1" },
    { key: "b", captureId: "c2" },
    { key: "c", captureId: "c3" },
  ];

  it("splits deleted captures from ones still on the server", async () => {
    const deleteCapture = vi.fn((id: string) => (id === "c2" ? Promise.reject(new Error("500")) : Promise.resolve()));
    const result = await undoImports(batch, deleteCapture, 2);
    expect(deleteCapture).toHaveBeenCalledTimes(3);
    expect(result.undone.map((u) => u.key)).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ key: "b", captureId: "c2" }]);
  });

  it("puts only undone rows back to ready, so a failed one can't be imported twice", () => {
    const rows = batch.map((b) => ({ key: b.key, status: "done" as string, captureId: b.captureId }));
    const next = resetUndoneRows(rows, [batch[0], batch[2]]);
    expect(next.map((r) => [r.key, r.status, r.captureId])).toEqual([
      ["a", "ready", undefined],
      ["b", "done", "c2"],
      ["c", "ready", undefined],
    ]);
  });
});
