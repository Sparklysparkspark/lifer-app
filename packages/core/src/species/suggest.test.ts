// The identification model falls back to CLIP only when it can't run on the photo; a database
// failure while ranking is not hidden behind a CLIP answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("../lib/log.js", () => ({ log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const fakeModel = (family: string) => ({
  isDownloaded: () => true,
  isStuck: () => false,
  target: () => ({ family }),
});
vi.mock("./idModel.js", () => ({ idModel: fakeModel("id") }));
vi.mock("./clipModel.js", () => ({ clipModel: fakeModel("clip"), isModelDownloaded: () => true }));

const analyzeImage = vi.fn();
vi.mock("./inference.js", () => ({
  analyzeImage: (...args: unknown[]) => analyzeImage(...args),
  contentHash: () => "hash",
  warmModels: async () => {},
}));

const { suggestSpecies, resetIdModelReadiness, invalidateSuggestionCache } = await import("./suggest.js");
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

  it("lets a database error while ranking propagate rather than retrying with CLIP", async () => {
    analyzeImage.mockReturnValue(vectorJob([1, 0]));
    const pool = fakePool((params) => params[0] === ID_SPACE.modelVersion);
    await expect(suggestSpecies(pool, "u1", Buffer.from("b"), null)).rejects.toThrow("connection terminated");
    expect(analyzeImage).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(ID_SPACE.modelVersion).not.toBe(CLIP_SPACE.modelVersion);
  });
});
