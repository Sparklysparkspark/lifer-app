import { describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/db.js", () => ({ pool: { query: vi.fn() } }));

import { queueReferenceDownload } from "./referencePhotos.js";

describe("queueReferenceDownload", () => {
  it("shares one download between concurrent misses for the same photo", async () => {
    const run = vi.fn(() => new Promise<void>((r) => setTimeout(r, 5)));
    const a = queueReferenceDownload("species:x", run);
    const b = queueReferenceDownload("species:x", run);
    expect(a).toBe(b);
    await a;
    expect(run).toHaveBeenCalledTimes(1);
    // Once finished, a later miss starts a fresh download.
    await queueReferenceDownload("species:x", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never rejects, so a failed download can't crash the process", async () => {
    await expect(queueReferenceDownload("species:y", async () => { throw new Error("offline"); })).resolves.toBeUndefined();
  });

  it("runs at most 3 downloads at once", async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        queueReferenceDownload(`gallery:${i}`, async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });
});
