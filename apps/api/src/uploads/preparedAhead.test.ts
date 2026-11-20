import { describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/uploads/image.js", () => ({
  generateDerivatives: vi.fn(async (_path: string, photoId: string) => ({
    displayPath: `/d/${photoId}.webp`,
    thumbPath: `/t/${photoId}.webp`,
    width: 10,
    height: 10,
  })),
}));
vi.mock("./workingImage.js", () => ({
  prepareWorkingImage: vi.fn(async (p: string) => ({ decodePath: p, release: async () => {} })),
}));
vi.mock("../species/detectAndCrop.js", () => ({ detectDefaultCardCrop: vi.fn(async () => ({ x: 1, y: 2, size: 3 })) }));
vi.mock("node:fs/promises", async (orig) => ({ ...(await orig()), readFile: vi.fn(async () => Buffer.from("x")) }));

const { prepareAhead, takePreparedAhead, whileImporting } = await import("./preparedAhead.js");

describe("prepareAhead", () => {
  it("hands the import the previews and crop made in the background, once", async () => {
    prepareAhead("u1", "f1", "/staged/f1", "jpeg");
    const ready = await takePreparedAhead("u1", "f1");
    expect(ready?.cardCrop).toEqual({ x: 1, y: 2, size: 3 });
    expect(ready?.derivatives.displayPath).toBe(`/d/${ready?.photoId}.webp`);
    expect(await takePreparedAhead("u1", "f1")).toBeNull();
    // Another user's import of the same file doesn't get it.
    prepareAhead("u1", "f2", "/staged/f2", "jpeg");
    expect(await takePreparedAhead("u2", "f2")).toBeNull();
  });

  it("waits while photos are checked, and an import never waits behind the queue", async () => {
    const { generateDerivatives } = await import("@lifer/core/uploads/image.js");
    vi.mocked(generateDerivatives).mockClear();
    await whileImporting(async () => {
      prepareAhead("u1", "q1", "/staged/q1", "jpeg");
      prepareAhead("u1", "q2", "/staged/q2", "jpeg");
      // Not started while busy, so the import gets nothing and makes its own previews.
      expect(await takePreparedAhead("u1", "q1")).toBeNull();
      expect(generateDerivatives).not.toHaveBeenCalled();
    });
    // Idle again: the rest of the queue runs.
    expect((await takePreparedAhead("u1", "q2"))?.cardCrop).toEqual({ x: 1, y: 2, size: 3 });
    expect(generateDerivatives).toHaveBeenCalledTimes(1);
  });
});
