import { describe, expect, it, vi } from "vitest";
import {
  commitImport,
  importFields,
  placeAssignments,
  resetUndoneRows,
  undoImports,
  type ImportTarget,
} from "./importCommit";
import type { StagedPlace } from "../components/importReview/importGroups";

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

  it("says which file joined a photo already in Lifer", async () => {
    const post = vi.fn().mockResolvedValue({ captureId: "old", linkedExisting: true, linkedOriginalId: "o1" });
    await expect(commitImport(photo, { ensureUploaded: async () => "up1", post })).resolves.toEqual({
      kind: "imported",
      captureId: "old",
      joined: { originalId: "o1" },
    });
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

  const deps = () => ({
    deleteCapture: vi.fn((id: string) => (id === "c2" ? Promise.reject(new Error("500")) : Promise.resolve())),
    undoLink: vi.fn((_id: string) => Promise.resolve()),
    reassign: vi.fn((_capture: string, _species: string) => Promise.resolve()),
  });

  it("splits deleted captures from ones still on the server", async () => {
    const d = deps();
    const result = await undoImports(batch, d, 2);
    expect(d.deleteCapture).toHaveBeenCalledTimes(3);
    expect(result.undone.map((u) => u.key)).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ key: "b", captureId: "c2" }]);
  });

  it("takes only the added RAW off an older photo and puts its species back", async () => {
    const d = deps();
    const result = await undoImports(
      [{ key: "raw", captureId: "old", joined: { originalId: "o1", previousSpeciesId: "sp0" } }],
      d,
      2,
    );
    expect(d.deleteCapture).not.toHaveBeenCalled();
    expect(d.reassign).toHaveBeenCalledWith("old", "sp0");
    expect(d.undoLink).toHaveBeenCalledWith("o1");
    expect(result.undone.map((u) => u.key)).toEqual(["raw"]);
  });

  it("keeps the RAW when its species can't be put back, so undo can be tried again", async () => {
    const d = { ...deps(), reassign: vi.fn(() => Promise.reject(new Error("500"))) };
    const result = await undoImports(
      [{ key: "raw", captureId: "old", joined: { originalId: "o1", previousSpeciesId: "sp0" } }],
      d,
      2,
    );
    expect(d.undoLink).not.toHaveBeenCalled();
    expect(result.failed.map((u) => u.key)).toEqual(["raw"]);
  });

  it("leaves an older photo alone when the server didn't say which file joined it", async () => {
    const d = deps();
    const result = await undoImports([{ key: "raw", captureId: "old", joined: { originalId: null } }], d, 2);
    expect(d.deleteCapture).not.toHaveBeenCalled();
    expect(d.undoLink).not.toHaveBeenCalled();
    expect(result.kept.map((u) => u.key)).toEqual(["raw"]);
  });

  it("trashes a photo this import created once, with a RAW that joined it in the same import", async () => {
    const d = deps();
    const result = await undoImports(
      [
        { key: "jpg", captureId: "c1" },
        { key: "raw", captureId: "c1", joined: { originalId: "o1" } },
      ],
      d,
      2,
    );
    expect(d.deleteCapture).toHaveBeenCalledTimes(1);
    expect(d.undoLink).not.toHaveBeenCalled();
    expect(result.undone.map((u) => u.key)).toEqual(["jpg", "raw"]);
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

describe("placeAssignments", () => {
  const pond: StagedPlace = { source: "spot", name: "Pond", spotId: "s1", regionId: null, point: null };
  const bc: StagedPlace = { source: "region", name: "British Columbia", spotId: null, regionId: "r1", point: null };
  const session: StagedPlace = {
    source: "session",
    name: "Near Prince George",
    spotId: null,
    regionId: "r1",
    point: { lat: 53.9, lon: -122.7 },
  };

  it("sends one entry per place, and nothing for photos without one", () => {
    expect(
      placeAssignments([
        { captureId: "a", place: pond },
        { captureId: "b", place: { ...pond } },
        { captureId: "c", place: bc },
        { captureId: "d", place: session },
        { captureId: "e", place: null },
        { captureId: "f" },
      ]),
    ).toEqual([
      { captureIds: ["a", "b"], spotId: "s1" },
      { captureIds: ["c"], regionId: "r1" },
      { captureIds: ["d"], lat: 53.9, lon: -122.7, regionId: "r1" },
    ]);
  });

  it("keeps a typed label over the spot's name, as its own entry", () => {
    expect(
      placeAssignments([
        { captureId: "a", place: pond, label: "  North shore " },
        { captureId: "b", place: pond, label: "" },
      ]),
    ).toEqual([
      { captureIds: ["a"], spotId: "s1", label: "North shore" },
      { captureIds: ["b"], spotId: "s1" },
    ]);
  });

  it("groups 2,000 photos in 60 places into 60 entries", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      captureId: `c${i}`,
      place: { ...pond, spotId: `s${i % 60}` },
    }));
    const out = placeAssignments(rows);
    expect(out).toHaveLength(60);
    expect(out.reduce((n, p) => n + p.captureIds.length, 0)).toBe(2000);
  });
});
