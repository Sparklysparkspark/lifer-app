// clientVectors from a desktop app are trusted only when they're exactly what this server would
// compute: every check below falls back to server-side compute, never to a half-trusted vector.
import { describe, expect, it } from "vitest";
import {
  CLIENT_VECTOR_DIMS,
  MAX_CLIENT_VECTORS_BYTES,
  decodeVector,
  encodeVector,
  parseClientVectors,
  type ClientVectors,
} from "./clientVectors.js";

const HASH = "a".repeat(64);
const expected = {
  pipelineVersion: 1,
  contentHash: HASH,
  modelVersions: { clip: "clip-v1", "clip-crop": "clip-v1", id: "bio-v1", "id-crop": "bio-v1" },
};

function unit(seed: number): Float32Array {
  const v = new Float32Array(CLIENT_VECTOR_DIMS);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.sin(seed * 31 + i);
    s += v[i] * v[i];
  }
  const n = Math.sqrt(s);
  return v.map((x) => x / n);
}

const payload = (over: Partial<ClientVectors> = {}): ClientVectors => ({
  pipelineVersion: 1,
  contentHash: HASH,
  clipFull: { modelVersion: "clip-v1", b64f32: encodeVector(unit(1)) },
  idCrop: { modelVersion: "bio-v1", b64f32: encodeVector(unit(2)) },
  ...over,
});

describe("encodeVector / decodeVector", () => {
  it("round-trips bit for bit", () => {
    const v = unit(3);
    expect(Array.from(decodeVector(encodeVector(v))!)).toEqual(Array.from(v));
  });

  it("rejects the wrong size, non-finite values, non-unit length and junk", () => {
    expect(decodeVector(encodeVector(unit(1).subarray(0, 512)))).toBeNull();
    const nan = unit(1);
    nan[5] = NaN;
    expect(decodeVector(encodeVector(nan))).toBeNull();
    const inf = unit(1);
    inf[5] = Infinity;
    expect(decodeVector(encodeVector(inf))).toBeNull();
    expect(decodeVector(encodeVector(unit(1).map((x) => x * 1.01)))).toBeNull();
    expect(decodeVector(encodeVector(new Float32Array(CLIENT_VECTOR_DIMS)))).toBeNull();
    expect(decodeVector("not base64!")).toBeNull();
    expect(decodeVector(42)).toBeNull();
  });

  it("allows float rounding within 1e-3 of unit length", () => {
    expect(decodeVector(encodeVector(unit(1).map((x) => x * 1.0005)))).not.toBeNull();
  });
});

describe("parseClientVectors", () => {
  it("accepts matching vectors and maps fields to vector kinds", () => {
    const res = parseClientVectors(JSON.stringify(payload()), expected);
    expect("vectors" in res).toBe(true);
    if (!("vectors" in res)) return;
    expect(Object.keys(res.vectors).sort()).toEqual(["clip", "id-crop"]);
    expect(Array.from(res.vectors.clip!)).toEqual(Array.from(unit(1)));
    expect(Array.from(res.vectors["id-crop"]!)).toEqual(Array.from(unit(2)));
  });

  it("accepts an upper-case hash", () => {
    expect(
      "vectors" in parseClientVectors(JSON.stringify(payload({ contentHash: HASH.toUpperCase() })), expected),
    ).toBe(true);
  });

  it.each([
    ["pipeline version", payload({ pipelineVersion: 2 })],
    ["content hash", payload({ contentHash: "b".repeat(64) })],
    ["clip model version", payload({ clipFull: { modelVersion: "clip-v0", b64f32: encodeVector(unit(1)) } })],
    ["id model version", payload({ idCrop: { modelVersion: "clip-v1", b64f32: encodeVector(unit(2)) } })],
    [
      "a bad vector alongside a good one",
      payload({ idCrop: { modelVersion: "bio-v1", b64f32: encodeVector(new Float32Array(CLIENT_VECTOR_DIMS)) } }),
    ],
    ["no vectors at all", { pipelineVersion: 1, contentHash: HASH }],
  ])("rejects a mismatched %s", (_what, body) => {
    expect("rejected" in parseClientVectors(JSON.stringify(body), expected)).toBe(true);
  });

  it("rejects malformed JSON, non-objects and oversized fields", () => {
    expect("rejected" in parseClientVectors("{", expected)).toBe(true);
    expect("rejected" in parseClientVectors("null", expected)).toBe(true);
    expect("rejected" in parseClientVectors(JSON.stringify({ ...payload(), clipFull: "x" }), expected)).toBe(true);
    const big = JSON.stringify({ ...payload(), pad: "x".repeat(MAX_CLIENT_VECTORS_BYTES) });
    expect(parseClientVectors(big, expected)).toEqual({ rejected: "too large" });
  });

  it("fits all three vectors well under the size cap", () => {
    const all = payload({ clipCrop: { modelVersion: "clip-v1", b64f32: encodeVector(unit(4)) } });
    expect(JSON.stringify(all).length).toBeLessThan(MAX_CLIENT_VECTORS_BYTES);
  });
});
