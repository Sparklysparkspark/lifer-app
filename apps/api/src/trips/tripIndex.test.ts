import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/db.js", () => ({ pool: { query: vi.fn() } }));
const atomicWrite = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../lib/atomicWrite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/atomicWrite.js")>();
  return {
    writeFileAtomicSync: (file: string, data: string) => {
      atomicWrite.calls++;
      actual.writeFileAtomicSync(file, data);
    },
  };
});

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "lifer-trip-index-"));
  atomicWrite.calls = 0;
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("recordTripIndexEntry", () => {
  it("keeps every entry of a burst of imports, written in a few batches rather than once each", async () => {
    const { recordTripIndexEntry } = await import("./tripIndex.js");
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => recordTripIndexEntry(folder, `IMG_${i}.jpg`, `Species ${i % 3}`)),
    );
    const index = JSON.parse(readFileSync(path.join(folder, ".lifer", "index.json"), "utf8"));
    expect(Object.keys(index)).toHaveLength(50);
    expect(index["IMG_7.jpg"]).toEqual({ scientificName: "Species 1" });
    expect(atomicWrite.calls).toBeLessThanOrEqual(2);
  });

  it("adds to an index written earlier", async () => {
    const { recordTripIndexEntry } = await import("./tripIndex.js");
    await recordTripIndexEntry(folder, "a.jpg", "Ardea herodias");
    await recordTripIndexEntry(folder, "b.jpg", "Pica hudsonia");
    const index = JSON.parse(readFileSync(path.join(folder, ".lifer", "index.json"), "utf8"));
    expect(index).toEqual({
      "a.jpg": { scientificName: "Ardea herodias" },
      "b.jpg": { scientificName: "Pica hudsonia" },
    });
  });
});
