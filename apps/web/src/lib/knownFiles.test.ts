import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quickHash, sortKnownFiles } from "./knownFiles";

const post = vi.fn();
vi.mock("../api/client", () => ({ api: { post: (...a: unknown[]) => post(...a) }, CLIENT_HEADER: {} }));

// The API's quickHash (movedPhotos/fingerprint.ts), restated over bytes.
function serverQuickHash(bytes: Buffer): string {
  const edge = 64 * 1024;
  const hash = createHash("sha1").update(String(bytes.length)).update(bytes.subarray(0, edge));
  if (bytes.length > edge) hash.update(bytes.subarray(Math.max(edge, bytes.length - edge)));
  return hash.digest("hex");
}

const file = (name: string, bytes: Buffer) => new File([new Uint8Array(bytes)], name);

beforeEach(() => {
  post.mockReset();
});

describe("quickHash", () => {
  it("matches the API's fingerprint for small, edge-sized and large files", async () => {
    for (const size of [0, 10, 64 * 1024, 64 * 1024 + 1, 100 * 1024, 300 * 1024]) {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 251;
      expect(await quickHash(file("a.jpg", bytes))).toBe(serverQuickHash(bytes));
    }
  });
});

describe("sortKnownFiles", () => {
  it("sets known files aside batch by batch, small batch first", async () => {
    const files = Array.from({ length: 450 }, (_, i) => file(`p${i}.jpg`, Buffer.from(`photo ${i}`)));
    const knownPrints = new Set(await Promise.all(files.slice(0, 300).map((f) => quickHash(f))));
    post.mockImplementation(async (_path: string, body: { fingerprints: string[] }) => ({
      known: body.fingerprints
        .filter((f) => knownPrints.has(f))
        .map((fingerprint) => ({ fingerprint, status: "imported" })),
    }));
    const batches: Array<[number, number]> = [];
    await sortKnownFiles(files, (fresh, known) => batches.push([fresh.length, known.length]));
    expect(batches).toEqual([
      [0, 200],
      [150, 100],
    ]);
    expect(post.mock.calls.map((c) => c[1].fingerprints.length)).toEqual([200, 250]);
  });

  it("lets a batch through as new when the lookup fails", async () => {
    post.mockRejectedValue(new Error("offline"));
    const fresh: string[] = [];
    await sortKnownFiles([file("a.jpg", Buffer.from("a"))], (f) => fresh.push(...f.map((x) => x.file.name)));
    expect(fresh).toEqual(["a.jpg"]);
  });
});
