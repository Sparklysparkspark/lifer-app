// Vectors a desktop app computed on its own machine for a photo it's sending to a server, so the
// server can skip running the models on it (see /uploads/inspect and localInferenceServer.ts).
// Accepted only when they're provably what the server would have computed itself: same
// preprocessing version, same model files (the desktop downloads them by the server's URL and
// sha256), the same photo bytes, and well-formed unit vectors. Anything else is ignored and the
// server computes as usual. Config-free, so the inference-only sidecar can share the encoding.
import type { PhotoVectorKind } from "./embeddings.js";

export const CLIENT_VECTOR_DIMS = 768;
export const MAX_CLIENT_VECTORS_BYTES = 64 * 1024;
const NORM_TOLERANCE = 1e-3;

export interface EncodedVector {
  modelVersion: string;
  /** Little-endian float32, base64. */
  b64f32: string;
}

export interface ClientVectors {
  pipelineVersion: number;
  /** sha256 hex of the photo's bytes (inference.ts contentHash). */
  contentHash: string;
  clipFull?: EncodedVector;
  clipCrop?: EncodedVector;
  idFull?: EncodedVector;
  idCrop?: EncodedVector;
  /** Whether the detector was unsure of the subject; idFull comes with it when true. */
  subjectUnsure?: boolean;
}

export const CLIENT_FIELD_KIND = { clipFull: "clip", clipCrop: "clip-crop", idFull: "id", idCrop: "id-crop" } as const satisfies Record<string, PhotoVectorKind>;
type ClientField = keyof typeof CLIENT_FIELD_KIND;

export function encodeVector(vector: Float32Array): string {
  const bytes = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4);
  return bytes.toString("base64");
}

/** The vector, or null unless it's exactly CLIENT_VECTOR_DIMS finite floats of unit length. */
export function decodeVector(b64: unknown): Float32Array | null {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== CLIENT_VECTOR_DIMS * 4) return null;
  const out = new Float32Array(CLIENT_VECTOR_DIMS);
  let sumSquares = 0;
  for (let i = 0; i < CLIENT_VECTOR_DIMS; i++) {
    const v = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
    sumSquares += v * v;
  }
  return Math.abs(Math.sqrt(sumSquares) - 1) <= NORM_TOLERANCE ? out : null;
}

export interface ClientVectorExpectations {
  pipelineVersion: number;
  contentHash: string;
  /** Model version per kind, as this server tags its own vectors. */
  modelVersions: Record<PhotoVectorKind, string>;
}

export type ParsedClientVectors = { vectors: Partial<Record<PhotoVectorKind, Float32Array>>; subjectUnsure?: boolean } | { rejected: string };

/** Checks a clientVectors field against what this server would compute. All or nothing: one bad
 * vector means none are trusted. */
export function parseClientVectors(raw: string, expected: ClientVectorExpectations): ParsedClientVectors {
  if (Buffer.byteLength(raw) > MAX_CLIENT_VECTORS_BYTES) return { rejected: "too large" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { rejected: "not JSON" };
  }
  if (!body || typeof body !== "object") return { rejected: "not an object" };
  const cv = body as Record<string, unknown>;
  if (cv.pipelineVersion !== expected.pipelineVersion) return { rejected: "pipeline version differs" };
  if (typeof cv.contentHash !== "string" || cv.contentHash.toLowerCase() !== expected.contentHash) return { rejected: "content hash differs" };
  const vectors: Partial<Record<PhotoVectorKind, Float32Array>> = {};
  for (const field of Object.keys(CLIENT_FIELD_KIND) as ClientField[]) {
    const entry = cv[field];
    if (entry === undefined) continue;
    const kind = CLIENT_FIELD_KIND[field];
    if (!entry || typeof entry !== "object") return { rejected: `${field} malformed` };
    const { modelVersion, b64f32 } = entry as Record<string, unknown>;
    if (modelVersion !== expected.modelVersions[kind]) return { rejected: `${field} model version differs` };
    const vector = decodeVector(b64f32);
    if (!vector) return { rejected: `${field} isn't a ${CLIENT_VECTOR_DIMS}-dim unit vector` };
    vectors[kind] = vector;
  }
  if (Object.keys(vectors).length === 0) return { rejected: "no vectors" };
  if (cv.subjectUnsure !== undefined && typeof cv.subjectUnsure !== "boolean") return { rejected: "subjectUnsure malformed" };
  return { vectors, ...(typeof cv.subjectUnsure === "boolean" && { subjectUnsure: cv.subjectUnsure }) };
}
