import { describe, expect, it } from "vitest";
import { computePhotoVectors, phoneModelsConfigured } from "./phoneOnly";

describe("phone-only vectors", () => {
  it("is not configured until the model host is set", () => {
    expect(phoneModelsConfigured()).toBe(false);
  });

  it("does nothing without the image encoder", async () => {
    expect(await computePhotoVectors({ pending: async () => ["a"], embed: null, store: async () => undefined })).toBe(0);
  });

  it("embeds each added photo in turn with progress, and stops when asked", async () => {
    const stored: string[] = [];
    const progress: string[] = [];
    let stop = false;
    const n = await computePhotoVectors({
      pending: async () => ["a", "b", "c"],
      embed: async (id) => Float32Array.of(id.length),
      store: async (id) => void stored.push(id),
      onProgress: (d, t) => {
        progress.push(`${d}/${t}`);
        stop = d === 2;
      },
      stopped: () => stop,
    });
    expect(n).toBe(2);
    expect(stored).toEqual(["a", "b"]);
    expect(progress).toEqual(["0/3", "1/3", "2/3"]);
  });
});
