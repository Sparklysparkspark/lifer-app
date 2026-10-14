// Per-photo vectors: one inference job per photo for whichever models are wanted, remembered by
// content hash so checking a photo and then saving it never runs the models twice.
//
// Vectors stay Float32Array in here. The number[] helpers exist for callers that write straight
// to Postgres, which would send a typed array as bytea rather than real[].
import { EMBED_PIPELINE_VERSION } from "@lifer/shared";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { clipModel } from "./clipModel.js";
import { parseClientVectors, type PhotoVectorKind } from "./clientVectors.js";
import { idModel } from "./idModel.js";
import { analyzeImage, contentHash, type ImageSource, type Priority, type SubjectPresence } from "./inference.js";
import type { OnnxImageModel } from "./onnxImageModel.js";

export type { PhotoVectorKind };

const modelFor = (kind: PhotoVectorKind): OnnxImageModel => (kind === "id" || kind === "id-crop" ? idModel : clipModel);
const isCropKind = (kind: PhotoVectorKind) => kind === "clip-crop" || kind === "id-crop";
const KIND_VERSION: Record<PhotoVectorKind, string> = {
  clip: EMBEDDING_MODEL_VERSION,
  "clip-crop": `${EMBEDDING_MODEL_VERSION}:p${EMBED_PIPELINE_VERSION}`,
  id: ID_MODEL_VERSION,
  "id-crop": `${ID_MODEL_VERSION}:p${EMBED_PIPELINE_VERSION}`,
};
/** The whole-photo vector that backs up each crop kind. */
const WHOLE_KIND = { "clip-crop": "clip", "id-crop": "id" } as const;
const memoKey = (kind: PhotoVectorKind, hash: string) => `${kind}:${KIND_VERSION[kind]}:${hash}`;

// Importing a photo needs the same vectors while checking it and again after saving it, so
// results are remembered by content hash. Keyed by model and pipeline version so an update
// never reuses old vectors.
const VECTOR_MEMO_BYTES = 64 * 1024 * 1024;
const ESTIMATED_VECTOR_BYTES = 768 * 4;
interface MemoEntry {
  value: Promise<Float32Array>;
  bytes: number;
}
const vectorMemo = new Map<string, MemoEntry>();
let vectorMemoBytes = 0;

function memoGet(key: string): Promise<Float32Array> | null {
  const hit = vectorMemo.get(key);
  if (!hit) return null;
  vectorMemo.delete(key); // move to the newest end
  vectorMemo.set(key, hit);
  return hit.value;
}

function memoDelete(key: string, entry: MemoEntry): void {
  if (vectorMemo.get(key) !== entry) return;
  vectorMemo.delete(key);
  vectorMemoBytes -= entry.bytes;
}

function memoSet(key: string, value: Promise<Float32Array>): void {
  const old = vectorMemo.get(key);
  if (old) memoDelete(key, old);
  const entry: MemoEntry = { value, bytes: ESTIMATED_VECTOR_BYTES };
  vectorMemo.set(key, entry);
  vectorMemoBytes += entry.bytes;
  value.then(
    (v) => {
      if (vectorMemo.get(key) !== entry) return;
      vectorMemoBytes += v.byteLength - entry.bytes;
      entry.bytes = v.byteLength;
    },
    () => memoDelete(key, entry), // a failure isn't worth remembering
  );
  while (vectorMemoBytes > VECTOR_MEMO_BYTES && vectorMemo.size > 1) {
    const [oldestKey, oldest] = vectorMemo.entries().next().value!;
    memoDelete(oldestKey, oldest);
  }
}

/** Whether a vector for this photo is already remembered (so committing it needs no image). */
export function hasRememberedVector(kind: PhotoVectorKind, key: string): boolean {
  return vectorMemo.has(memoKey(kind, key));
}

/** Seeds the memo with a vector computed elsewhere, e.g. by a desktop client. */
export function rememberPhotoVector(kind: PhotoVectorKind, key: string, vector: Float32Array): void {
  memoSet(memoKey(kind, key), Promise.resolve(vector));
}

/** Seeds the memo from a desktop client's clientVectors field for the photo whose sha256 is
 * `hash`. Returns why they were ignored, or null when they were taken. */
export function rememberClientVectors(raw: string, hash: string): string | null {
  const parsed = parseClientVectors(raw, {
    pipelineVersion: EMBED_PIPELINE_VERSION,
    contentHash: hash,
    modelVersions: {
      clip: EMBEDDING_MODEL_VERSION,
      "clip-crop": EMBEDDING_MODEL_VERSION,
      id: ID_MODEL_VERSION,
      "id-crop": ID_MODEL_VERSION,
    },
  });
  if ("rejected" in parsed) return parsed.rejected;
  for (const [kind, vector] of Object.entries(parsed.vectors))
    rememberPhotoVector(kind as PhotoVectorKind, hash, vector);
  if (parsed.subjectUnsure !== undefined) rememberSubjectUnsure(hash, parsed.subjectUnsure);
  return null;
}

// Whether the detector was unsure of each photo's subject, by content hash, so remembered
// photos don't need detection again.
const SUBJECT_MEMO_SIZE = 2000;
const subjectMemo = new Map<string, boolean>();
function rememberSubjectUnsure(hash: string, unsure: boolean): void {
  subjectMemo.delete(hash);
  subjectMemo.set(hash, unsure);
  if (subjectMemo.size > SUBJECT_MEMO_SIZE) subjectMemo.delete(subjectMemo.keys().next().value!);
}

const isBytes = (image: ImageSource): image is Uint8Array => image instanceof Uint8Array;

/** Any of `kinds` for one photo, computed in a single worker job unless already remembered.
 * `key` is the photo's sha256 when known. Every promise is safe to ignore. */
export function photoVectors(
  image: ImageSource,
  opts: { kinds: PhotoVectorKind[]; key?: string | null; presence?: boolean; subject?: boolean; priority: Priority },
): {
  vectors: Record<PhotoVectorKind, Promise<Float32Array>>;
  presence: Promise<SubjectPresence | null>;
  /** With `subject`: whether the detector was unsure it found the animal. */
  subjectUnsure: Promise<boolean | null>;
} {
  const hash = opts.key ?? (isBytes(image) ? contentHash(image) : null);
  const vectors = {} as Record<PhotoVectorKind, Promise<Float32Array>>;
  const missing: PhotoVectorKind[] = [];
  for (const kind of new Set(opts.kinds)) {
    const hit = hash ? memoGet(memoKey(kind, hash)) : null;
    if (hit) vectors[kind] = hit;
    else if (!modelFor(kind).isDownloaded())
      vectors[kind] = Promise.reject(new Error(modelFor(kind).target(false).missingMessage));
    else missing.push(kind);
  }
  let presence: Promise<SubjectPresence | null> = Promise.resolve(null);
  const knownUnsure = hash ? subjectMemo.get(hash) : undefined;
  let subjectUnsure: Promise<boolean | null> = Promise.resolve(knownUnsure ?? null);
  const askSubject = !!opts.subject && knownUnsure === undefined;
  if (missing.length > 0 || opts.presence || askSubject) {
    const job = analyzeImage(image, {
      targets: missing.map((kind) => modelFor(kind).target(isCropKind(kind))),
      key: hash,
      presence: opts.presence,
      subject: askSubject || missing.some(isCropKind),
      priority: opts.priority,
    });
    const unsure = job.then((r) => {
      if (hash && r.subjectUnsure != null) rememberSubjectUnsure(hash, r.subjectUnsure);
      return r.subjectUnsure;
    });
    unsure.catch(() => {});
    if (askSubject) subjectUnsure = unsure.catch(() => null);
    missing.forEach((kind, i) => {
      const vector = job.then((r) => {
        const v = r.vectors[i];
        if (v instanceof Float32Array) return v;
        throw new Error(v.error);
      });
      vectors[kind] = vector;
      if (hash) memoSet(memoKey(kind, hash), vector);
    });
    if (opts.presence)
      presence = job.then(
        (r) => r.presence,
        () => null,
      );
  }
  for (const v of Object.values(vectors)) v.catch(() => {});
  return { vectors, presence, subjectUnsure };
}

/** The vectors a photo's suggestions rank from: its subject crop, plus the whole photo when the
 * detector was unsure, so a wrong crop can't decide alone. */
export async function suggestionVectors(
  image: ImageSource,
  kind: "clip-crop" | "id-crop",
  opts: { key?: string | null; priority: Priority },
): Promise<Float32Array[]> {
  const { vectors, subjectUnsure } = photoVectors(image, {
    kinds: [kind],
    key: opts.key,
    subject: true,
    priority: opts.priority,
  });
  const crop = await vectors[kind];
  if (!(await subjectUnsure)) return [crop];
  const whole = await photoVector(WHOLE_KIND[kind], image, opts).catch(() => null);
  return whole ? [crop, whole] : [crop];
}

/** One photo vector (see PhotoVectorKind). */
export function photoVector(
  kind: PhotoVectorKind,
  image: ImageSource,
  opts: { key?: string | null; priority: Priority },
): Promise<Float32Array> {
  return photoVectors(image, { kinds: [kind], key: opts.key, priority: opts.priority }).vectors[kind];
}

/** L2-normalized CLIP embedding of the whole photo, as a plain array. Background priority. */
export async function computeEmbedding(buffer: Buffer): Promise<number[]> {
  return Array.from(await photoVector("clip", buffer, { priority: "background" }));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // both vectors are L2-normalized, so the dot product is the cosine similarity
}
