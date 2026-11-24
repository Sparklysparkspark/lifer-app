import { describe, expect, it } from "vitest";
import { batchPairs, joinPairs, type PairFacts } from "./batchPairs";
import type { ReviewRowBase } from "./useImportReview";

const AT = "2026-11-20T07:12:33.000Z";
const file = (key: string, name: string, extra: Partial<PairFacts> = {}): PairFacts => ({
  key,
  name,
  isRaw: /\.(cr3|nef|arw|dng)$/i.test(name),
  takenAt: AT,
  documentId: null,
  press: null,
  ...extra,
});

describe("batchPairs", () => {
  it("pairs a RAW with its JPG by name and time, the RAW first", () => {
    expect(batchPairs([file("jpg", "6F9A8074.jpg"), file("raw", "6F9A8074.CR3")])).toEqual([["raw", "jpg"]]);
  });

  it("pairs an edit with a suffix on the same press", () => {
    const press = { press: "p1" };
    expect(batchPairs([file("edit", "IMG_1-Edit.jpg", press), file("orig", "IMG_1.jpg", press)])).toEqual([
      ["orig", "edit"],
    ]);
  });

  it("pairs a shared XMP document whatever the names", () => {
    const doc = { documentId: "abc123def" };
    expect(batchPairs([file("a", "Kingfisher final.tif", doc), file("b", "6F9A8074.jpg", doc)])).toEqual([["a", "b"]]);
  });

  it("leaves the same stem from different cards alone", () => {
    expect(
      batchPairs([file("raw", "DSC_0001.NEF"), file("jpg", "DSC_0001.jpg", { takenAt: "2026-11-21T09:00:00.000Z" })]),
    ).toEqual([]);
  });

  it("leaves two JPGs alone on name and time only", () => {
    expect(batchPairs([file("a", "IMG_1.jpg"), file("b", "IMG_1-2.jpg")])).toEqual([]);
  });

  it("leaves two different documents alone", () => {
    expect(
      batchPairs([
        file("raw", "IMG_1.CR3", { documentId: "doc0001aa" }),
        file("jpg", "IMG_1.jpg", { documentId: "doc0002bb" }),
      ]),
    ).toEqual([]);
  });

  it("pairs nothing when the evidence points three ways", () => {
    const press = { press: "p1" };
    expect(
      batchPairs([
        file("raw", "IMG_1.CR3", press),
        file("jpg", "IMG_1.jpg", press),
        file("edit", "IMG_1-Edit.jpg", press),
      ]),
    ).toEqual([]);
  });

  it("matches a Windows path and a different case", () => {
    expect(batchPairs([file("raw", "C:\\DCIM\\100CANON\\6F9A8074.CR3"), file("jpg", "6f9a8074.JPG")])).toEqual([
      ["raw", "jpg"],
    ]);
  });
});

describe("joinPairs", () => {
  const row = (key: string, extra: Partial<ReviewRowBase> = {}): ReviewRowBase => ({
    key,
    speciesId: null,
    speciesLabel: null,
    suggestions: [
      { id: "turkey", scientific_name: "Meleagris ocellata", common_name: "Ocellated Turkey", score: 0.89 },
    ],
    ...extra,
  });

  it("gives the partner the species and hides its own suggestions", () => {
    const [raw, jpg] = joinPairs(
      [row("raw", { speciesId: "peafowl", speciesLabel: "Indian Peafowl" }), row("jpg")],
      [["raw", "jpg"]],
      (r) => `${r.key}.file`,
    );
    expect(raw).toMatchObject({ partnerKey: "jpg", speciesId: "peafowl" });
    expect(jpg).toMatchObject({
      partnerKey: "raw",
      samePhotoAs: "raw.file",
      speciesId: "peafowl",
      speciesLabel: "Indian Peafowl",
      suggestions: [],
    });
  });

  it("takes the species from whichever file has it", () => {
    const [raw] = joinPairs(
      [row("raw"), row("jpg", { speciesId: "peafowl", speciesLabel: "Indian Peafowl" })],
      [["raw", "jpg"]],
      (r) => r.key,
    );
    expect(raw.speciesId).toBe("peafowl");
  });
});
