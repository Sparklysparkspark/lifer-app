// The identification model falls back to CLIP only when it can't run on the photo; a database
// failure while ranking is not hidden behind a CLIP answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("../lib/log.js", () => ({ log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const fakeModel = (family: string) => ({
  isDownloaded: () => true,
  isStuck: () => false,
  target: (crop: boolean) => ({ family, crop }),
});
vi.mock("./idModel.js", () => ({ idModel: fakeModel("id") }));
vi.mock("./clipModel.js", () => ({ clipModel: fakeModel("clip"), isModelDownloaded: () => true }));

const analyzeImage = vi.fn();
vi.mock("./inference.js", () => ({
  analyzeImage: (...args: unknown[]) => analyzeImage(...args),
  contentHash: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
  warmModels: async () => {},
}));

const { suggestSpecies, resetIdModelReadiness, invalidateSuggestionCache, probableGroup, rankCandidates } =
  await import("./suggest.js");
const { ID_SPACE, CLIP_SPACE } = await import("./vectorSpaces.js");

// Answers a no-region ranking: the user's one species, its reference vector, no own photos.
function fakePool(failOn?: (params: unknown[]) => boolean) {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM id_model_text_embeddings")) return { rows: [{ ok: true }] };
    if (sql.includes("FROM user_species")) return { rows: [{ species_id: "a" }] };
    if (sql.includes("WHERE s.id = ANY")) {
      if (failOn?.(params)) throw new Error("connection terminated");
      return {
        rows: [
          {
            species_id: "a",
            common_name: null,
            scientific_name: "A a",
            ref_embedding: [1, 0],
            gallery_embeddings: null,
            text_embedding: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  return { query } as never;
}

const vectorJob = (vector: number[]) =>
  Promise.resolve({ vectors: [Float32Array.from(vector)], subjectUnsure: false, presence: null });

describe("suggestSpecies with the identification model", () => {
  beforeEach(() => {
    warn.mockClear();
    analyzeImage.mockReset();
    resetIdModelReadiness();
    invalidateSuggestionCache();
  });

  it("logs an inference failure and suggests with CLIP instead", async () => {
    analyzeImage.mockReturnValueOnce(Promise.reject(new Error("onnx session failed")));
    analyzeImage.mockReturnValueOnce(vectorJob([1, 0]));
    const result = await suggestSpecies(fakePool(), "u1", Buffer.from("a"), null);
    expect(result[0]?.id).toBe("a");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(analyzeImage.mock.calls[1][1].targets[0].family).toBe("clip");
  });

  it("ranks from the subject crop and the whole photo, computed in one job", async () => {
    // The crop matches nothing; the whole photo matches species a.
    analyzeImage.mockReturnValueOnce(
      Promise.resolve({ vectors: [Float32Array.from([0, 1]), Float32Array.from([1, 0])], subjectUnsure: false, presence: null }),
    );
    const result = await suggestSpecies(fakePool(), "u1", Buffer.from("c"), null);
    expect(analyzeImage).toHaveBeenCalledTimes(1);
    expect(analyzeImage.mock.calls[0][1].targets).toEqual([
      { family: "id", crop: true },
      { family: "id", crop: false },
    ]);
    expect(result[0]?.score).toBeCloseTo(1);
  });

  it("lets a database error while ranking propagate rather than retrying with CLIP", async () => {
    analyzeImage.mockReturnValue(vectorJob([1, 0]));
    const pool = fakePool((params) => params[0] === ID_SPACE.modelVersion);
    await expect(suggestSpecies(pool, "u1", Buffer.from("b"), null)).rejects.toThrow("connection terminated");
    expect(analyzeImage).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(ID_SPACE.modelVersion).not.toBe(CLIP_SPACE.modelVersion);
  });
});

describe("probableGroup", () => {
  const taxa = new Map([
    ["a", { genus: "Lithobates", family: "Ranidae", taxon_class: "amphibia" }],
    ["b", { genus: "Lithobates", family: "Ranidae", taxon_class: "amphibia" }],
    ["c", { genus: "Rana", family: "Ranidae", taxon_class: "amphibia" }],
    ["d", { genus: "Bufo", family: "Bufonidae", taxon_class: "amphibia" }],
  ]);
  const ranked = (...pairs: Array<[string, number]>) =>
    pairs.map(([id, score]) => ({ id, score, common_name: null, scientific_name: id, source: "reference_photo" as const }));

  it("offers the genus when the close runners-up share it", () => {
    expect(probableGroup(ranked(["a", 0.8], ["b", 0.795], ["d", 0.7]), taxa)).toEqual({
      rank: "genus",
      name: "Lithobates",
      taxonClass: "amphibia",
    });
  });

  it("falls back to the family when the genus is split", () => {
    expect(probableGroup(ranked(["a", 0.8], ["c", 0.799], ["d", 0.7]), taxa)?.name).toBe("Ranidae");
  });

  it("offers nothing when the close candidates disagree, or the top one stands alone", () => {
    expect(probableGroup(ranked(["a", 0.8], ["d", 0.8]), taxa)).toBeNull();
    expect(probableGroup(ranked(["a", 0.8], ["d", 0.6]), taxa)).toBeNull();
  });
});

describe("rankCandidates with bats", () => {
  const entry = (id: string, ref: number[], genus: string, taxon_order: string) => ({
    species: {
      species_id: id,
      common_name: null,
      scientific_name: id,
      ref_embedding: Float32Array.from(ref),
      gallery_embeddings: null,
      text_embedding: null,
      ref_license: null,
      gallery_licenses: null,
      genus,
      family: "Phyllostomidae",
      taxon_class: "mammalia",
      taxon_order,
    },
    is_vagrant: null,
    local_tier: null,
    seasonality: null,
  });
  // a clearly beats b (margin 0.04), and both share a genus.
  const rank = (order: string) =>
    rankCandidates(
      [entry("a", [1, 0], "Artibeus", order), entry("b", [0.96, 0.28], "Artibeus", order), entry("c", [0, 1], "Other", order)],
      new Map(),
      [Float32Array.from([1, 0])],
      5,
      null,
      ID_SPACE,
      null,
      false,
    );

  it("never makes a bat a confident pick, offering its genus instead", () => {
    const [top, next] = rank("Chiroptera");
    expect(top.id).toBe("a");
    expect(top.confident).toBe(false);
    expect(top.probably).toEqual({ rank: "genus", name: "Artibeus", taxonClass: "mammalia" });
    expect(next.id).toBe("b");
  });

  it("leaves other mammals confident", () => {
    const [top] = rank("Rodentia");
    expect(top.confident).toBe(true);
    expect(top.probably).toBeUndefined();
  });
});
