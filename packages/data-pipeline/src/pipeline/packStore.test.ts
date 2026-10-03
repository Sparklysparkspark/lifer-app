import { createHash } from "node:crypto";
import { mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACK_SHARD_PREFIX, writePackStore } from "./packStore.js";
import type { IndexPack, PackIndex } from "./packs.js";

const entry = (id: string, extra: Partial<IndexPack> = {}): IndexPack => ({
  id,
  type: "region",
  sizeBytes: 0,
  speciesCount: 1,
  contentVersion: id,
  scientificNames: [],
  url: "",
  ...extra,
});

const readRange = (file: string, [offset, length]: [number, number]) => {
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  readSync(fd, buf, 0, length, offset);
  return buf;
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writePackStore", () => {
  it("puts rebuilt packs in a new shard and keeps unchanged ones where they are", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-store-"));
    const bytes = { a: Buffer.from("pack-a-".repeat(30)), b: Buffer.from("pack-b-".repeat(11)) };
    writeFileSync(path.join(dir, "a.pack.tar.gz"), bytes.a);
    writeFileSync(path.join(dir, "b.pack.tar.gz"), bytes.b);
    const kept = entry("c", { url: `https://example.org/${PACK_SHARD_PREFIX}old-0.bin`, range: [0, 5], sha256: "x", format: 3 });
    const index: PackIndex = { generatedAt: "", packs: [entry("a"), kept, entry("b")] };

    const shards = writePackStore(dir, index, new Set(["a.pack.tar.gz", "b.pack.tar.gz"]));

    expect(shards).toHaveLength(1);
    for (const [id, buf] of Object.entries(bytes)) {
      const p = index.packs.find((x) => x.id === id)!;
      expect(p.url.endsWith(path.basename(shards[0]))).toBe(true);
      expect(readRange(shards[0], p.range!)).toEqual(buf);
      expect(p.sha256).toBe(createHash("sha256").update(buf).digest("hex"));
      expect(p.sizeBytes).toBe(buf.length);
    }
    expect(index.packs.find((x) => x.id === "c")).toEqual(kept);
  });

  it("refuses a pack that wasn't rebuilt and isn't in the store", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-store-"));
    const index: PackIndex = { generatedAt: "", packs: [entry("old", { url: "https://example.org/packs-europe/old.pack.tar.gz" })] };
    expect(() => writePackStore(dir, index, new Set())).toThrow(/isn't in the pack store/);
  });
});
