import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migratedDb } from "../store/testDb";
import {
  CHUNK_BYTES,
  ensureModel,
  loadModelState,
  modelBytes,
  removeModel,
  type Manifest,
  type ModelFs,
} from "./modelDownload";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ENCODER = Buffer.alloc(CHUNK_BYTES * 2 + 1000, 7);
const TOKENIZER = Buffer.from('{"model":{}}');
const manifest = (version = "v1", enc = ENCODER): Manifest => ({
  available: true,
  textModelVersion: version,
  imageModelVersion: "i1",
  dimension: 768,
  files: [
    { name: "encoder", size: enc.length, sha256: sha(enc), url: "/api/companion/v1/model/text/encoder" },
    {
      name: "tokenizer",
      size: TOKENIZER.length,
      sha256: sha(TOKENIZER),
      url: "/api/companion/v1/model/text/tokenizer",
    },
  ],
});

/** A phone folder in memory and a hub that serves ranges of the buffers; `die` drops the connection at the Nth request. */
function world(m: Manifest, enc: Buffer = ENCODER, die = Infinity) {
  const files = new Map<string, Buffer>();
  const ranges: [string, number, number][] = [];
  let requests = 0;
  const bodies: Record<string, Buffer> = {
    "/companion/v1/model/text/encoder": enc,
    "/companion/v1/model/text/tokenizer": TOKENIZER,
  };
  const fs: ModelFs = {
    prepare: async () => undefined,
    size: async (n) => files.get(n)?.length ?? null,
    fetchRange: async (target, from, to, name) => {
      if (++requests > die) throw new Error("network dropped");
      const path = target.url.replace("https://hub/api", "");
      ranges.push([path, from, to]);
      const slice = bodies[path].subarray(from, to + 1);
      files.set(name, from === 0 ? Buffer.from(slice) : Buffer.concat([files.get(name) ?? Buffer.alloc(0), slice]));
      return 206;
    },
    sha256: async (n) => sha(files.get(n)!),
    rename: async (a, b) => (files.set(b, files.get(a)!), void files.delete(a)),
    remove: async (n) => void files.delete(n),
    clear: async () => files.clear(),
  };
  const api = { get: async <T>() => m as T, target: (p: string) => ({ url: `https://hub/api${p}`, headers: {} }) };
  return { fs, api, files, ranges };
}

describe("model download", () => {
  it("downloads in ranges, verifies each file and records the model", async () => {
    const db = await migratedDb();
    const w = world(manifest());
    const progress: number[] = [];
    expect(
      await ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => true, onProgress: (d) => progress.push(d) }),
    ).toBe("ready");
    expect(w.ranges.filter(([p]) => p.endsWith("encoder")).map(([, f, t]) => [f, t])).toEqual([
      [0, CHUNK_BYTES - 1],
      [CHUNK_BYTES, 2 * CHUNK_BYTES - 1],
      [2 * CHUNK_BYTES, 2 * CHUNK_BYTES + 999],
    ]);
    expect(w.files.get("encoder")!.equals(ENCODER)).toBe(true);
    expect(w.files.has("encoder.part")).toBe(false);
    expect(await loadModelState(db)).toMatchObject({ textModelVersion: "v1", complete: true });
    expect(progress.at(-1)).toBe(ENCODER.length + TOKENIZER.length);
    expect(await modelBytes(db, w.fs)).toBe(ENCODER.length + TOKENIZER.length);
  });

  it("resumes a dropped download from the bytes already saved", async () => {
    const db = await migratedDb();
    const w = world(manifest(), ENCODER, 2);
    await expect(ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => true })).rejects.toThrow("dropped");
    expect(w.files.get("encoder.part")!.length).toBe(2 * CHUNK_BYTES);
    const again = world(manifest());
    again.files.set("encoder.part", w.files.get("encoder.part")!);
    expect(await ensureModel({ db, fs: again.fs, api: again.api, allowed: async () => true })).toBe("ready");
    expect(again.ranges[0].slice(1)).toEqual([2 * CHUNK_BYTES, 2 * CHUNK_BYTES + 999]);
    expect(again.files.get("encoder")!.equals(ENCODER)).toBe(true);
  });

  it("throws away a file that fails its checksum", async () => {
    const db = await migratedDb();
    const w = world(manifest(), Buffer.alloc(ENCODER.length, 9));
    await expect(ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => true })).rejects.toThrow("checksum");
    expect(w.files.has("encoder.part")).toBe(false);
    expect(await loadModelState(db)).toBeNull();
  });

  it("downloads nothing over a metered connection, and nothing when the hub has no model", async () => {
    const db = await migratedDb();
    const w = world(manifest());
    expect(await ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => false })).toBe("waiting");
    expect(w.ranges).toHaveLength(0);
    const none = world({ ...manifest(), available: false });
    expect(await ensureModel({ db, fs: none.fs, api: none.api, allowed: async () => true })).toBe("unavailable");
  });

  it("does nothing when current, and fetches only the changed file when the version moves", async () => {
    const db = await migratedDb();
    const w = world(manifest());
    await ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => true });
    w.ranges.length = 0;
    expect(await ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => false })).toBe("ready");
    expect(w.ranges).toHaveLength(0);
    const newer = Buffer.alloc(5000, 3);
    const next = world(manifest("v2", newer), newer);
    for (const [k, v] of w.files) next.files.set(k, v);
    expect(await ensureModel({ db, fs: next.fs, api: next.api, allowed: async () => true })).toBe("ready");
    expect(next.ranges.map(([p]) => p)).toEqual(["/companion/v1/model/text/encoder"]);
    expect(next.files.get("encoder")!.equals(newer)).toBe(true);
    expect((await loadModelState(db))?.textModelVersion).toBe("v2");
  });

  it("removing the model clears the files and the record", async () => {
    const db = await migratedDb();
    const w = world(manifest());
    await ensureModel({ db, fs: w.fs, api: w.api, allowed: async () => true });
    await removeModel(db, w.fs);
    expect(w.files.size).toBe(0);
    expect(await loadModelState(db)).toBeNull();
  });
});
