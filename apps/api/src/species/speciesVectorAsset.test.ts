// A text or image model bump changes the version every species vector is stored under. An install
// must never load vectors for a model it doesn't run: until a matching asset is published it
// keeps what it has (ranking reads only rows of its own version), and a file whose header
// disagrees with the manifest is rejected without marking the install up to date.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeSpeciesVectorHeader, encodeSpeciesVectorRecord } from "@lifer/shared/src/speciesVectorFormat.js";
import { applySpeciesVectorFile, fetchAndApplySpeciesVectorAsset, type SpeciesVectorTableSpec } from "./speciesVectorAsset.js";
import type { CatalogManifest } from "./catalogManifest.js";

const spec: SpeciesVectorTableSpec = {
  table: "species_text_embeddings",
  currentModelVersion: "text-v2",
  appliedKey: "species_text_embeddings_version",
  label: "species zero-shot text vectors",
  phase: "downloading",
  applyPhase: "applying",
};
const ctx = { signal: new AbortController().signal, update: () => {}, throwIfCancelled: () => {} };
const manifest: CatalogManifest = { version: 7, publishedAt: "2026-10-01T00:00:00Z" };

// Records every statement; a COPY gets (synchronously, like pg) a sink that accepts the rows.
function fakePool() {
  const sql: string[] = [];
  const query = (q: unknown) => {
    if (typeof q !== "string") return new Writable({ write: (_chunk, _enc, cb) => cb() });
    sql.push(q);
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) };
  return { sql, pool: pool as never };
}

function vectorFile(modelVersion: string): string {
  const dimension = 4;
  const body = Buffer.concat([
    encodeSpeciesVectorHeader({ dimension, rowCount: 1, modelVersion }),
    encodeSpeciesVectorRecord({ speciesId: "00000000-0000-0000-0000-000000000001", embedding: [1, 0, 0, 0] }, dimension),
  ]);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-svec-")), "vectors.bin.gz");
  writeFileSync(file, gzipSync(body));
  return file;
}

describe("species vector assets across a model version bump", () => {
  it("leaves the install alone when the published asset is for another model", async () => {
    const { pool, sql } = fakePool();
    const asset = { url: "text-v1.bin.gz", sha256: "x", bytes: 1, modelVersion: "text-v1", rowCount: 1 };
    const result = await fetchAndApplySpeciesVectorAsset(pool, ctx, spec, manifest, asset as never, false);
    expect(result.status).toBe("unavailable");
    expect(sql).toEqual([]);
  });

  it("stores a matching file under the install's model version", async () => {
    const { pool, sql } = fakePool();
    const result = await applySpeciesVectorFile(pool, spec, vectorFile("text-v2"), "7:text-v2", ctx);
    expect(result.status).toBe("applied");
    expect(sql.some((q) => q.includes("INSERT INTO species_text_embeddings"))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
  });

  it("rejects a file whose header names another model, without recording it as applied", async () => {
    const { pool, sql } = fakePool();
    await expect(applySpeciesVectorFile(pool, spec, vectorFile("text-v1"), "7:text-v2", ctx)).rejects.toThrow(/model text-v1/);
    expect(sql.some((q) => q.includes("INSERT INTO species_text_embeddings"))).toBe(false);
    expect(sql.some((q) => q.includes("install_settings"))).toBe(false);
    expect(sql.at(-1)).toBe("ROLLBACK");
  });
});
