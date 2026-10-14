import { describe, expect, it, vi } from "vitest";
import { log } from "../lib/log.js";
import { tryStoreVector, type VectorStoreTarget } from "./persistReference.js";

function target(overrides: Partial<VectorStoreTarget> = {}): VectorStoreTarget {
  return {
    label: "clip reference",
    isModelDownloaded: () => true,
    embed: async () => [1, 0],
    pendingImage: async () => new URL(import.meta.url).pathname,
    store: async () => undefined,
    ...overrides,
  };
}

describe("tryStoreVector", () => {
  it("stores the vector for a pending image", async () => {
    const store = vi.fn(async () => undefined);
    expect(await tryStoreVector(target({ store }))).toBe(true);
    expect(store).toHaveBeenCalledWith([1, 0]);
  });

  it("skips quietly when the model isn't downloaded or nothing is pending", async () => {
    const warn = vi.spyOn(log, "warn");
    const embed = vi.fn();
    expect(await tryStoreVector(target({ isModelDownloaded: () => false, embed }))).toBe(false);
    expect(await tryStoreVector(target({ pendingImage: async () => null, embed }))).toBe(false);
    expect(embed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs any other failure and leaves it for the backfill", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const failures: Array<Partial<VectorStoreTarget>> = [
      { pendingImage: async () => "/nonexistent/lifer-test.jpg" },
      { embed: async () => Promise.reject(new Error("inference timed out")) },
      { store: async () => Promise.reject(new Error("database is down")) },
    ];
    for (const failure of failures) expect(await tryStoreVector(target(failure), { speciesId: "s1" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][0]).toMatchObject({ speciesId: "s1", vector: "clip reference" });
    warn.mockRestore();
  });
});
