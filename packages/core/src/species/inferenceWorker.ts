// Every local model (CLIP and identification image encoders, the YOLOv8n animal detector, CLIP's
// text encoder) and its preprocessing, run on a worker thread because onnxruntime blocks the
// calling thread. inference.ts is the main-thread side (queue, priorities, timeouts).
//
// Imports only config-free modules (logging, image limits) so the desktop inference sidecar can
// reuse it as is.
import { existsSync, readdirSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import sharp, { type FormatEnum } from "sharp";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import type { PreTrainedTokenizer, CLIPTextModelWithProjection } from "@huggingface/transformers";
import { log } from "../lib/log.js";
import { maxImagePixels } from "../lib/imageLimits.js";
import { summarizeScene, type SceneShares } from "./sceneSummary.js";

// Loading sharp on this thread turns libvips' process-wide cache back on, undoing image.ts on the
// main thread; that cache keeps originals open, which on Windows blocks editing them.
sharp.cache(false);

// ---------------------------------------------------------------------------------------------
// Protocol shared with inference.ts
// ---------------------------------------------------------------------------------------------

/** Either the file's bytes or a path the worker reads itself (keeps big buffers off the queue). */
export type ImageInput = { bytes: Uint8Array } | { path: string };

/** An encoded photo: its bytes, or a file path sharp opens itself (never read whole into memory). */
type ImageData = Uint8Array | string;

function openImage(image: ImageData) {
  return sharp(image, { limitInputPixels: maxImagePixels() });
}

// sharp can't decode HEIC, so a HEIC path is decoded to JPEG here (already rotated by libheif).
async function decodableInput(filePath: string): Promise<ImageData> {
  const fh = await open(filePath, "r");
  const head = Buffer.alloc(12);
  try {
    await fh.read(head, 0, 12, 0);
  } finally {
    await fh.close();
  }
  if (
    head.toString("latin1", 4, 8) !== "ftyp" ||
    !/^(heic|heix|hevc|hevx|heim|heis)$/.test(head.toString("latin1", 8, 12))
  )
    return filePath;
  const decode = createRequire(import.meta.url)("heic-decode") as (input: {
    buffer: Uint8Array;
  }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  const { width, height, data } = await decode({ buffer: await readFile(filePath) });
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
    limitInputPixels: false,
  })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/** An ONNX Runtime execution provider: "cpu", "cuda", "webgpu", "dml", or one with options. */
export type ProviderSpec = string | { name: string; [option: string]: unknown };

export interface EmbedTarget {
  /** The .onnx file of a CLIP-family image encoder (224 px input, CLIP normalization). */
  modelPath: string;
  /** Where it runs (acceleration.ts); the CPU when absent. */
  providers?: ProviderSpec[];
  /** Thrown for this target when the file isn't there. */
  missingMessage: string;
  /** Crop to the detected animal first (suggestion-time vectors), else the whole photo. */
  crop: boolean;
  /** Grey out the detected animal and read what's left (the background vector). Fails for a photo
   *  with no animal found, or one the animal fills too much of to leave a background. */
  maskSubject?: boolean;
}

export interface TextModelSpec {
  modelId: string;
  revision: string;
  cacheDir: string;
  missingMessage: string;
}

export interface SubjectPresence {
  /** Best "person" score anywhere in the frame (COCO class 0). */
  person: number;
  /** Share of the photo the best person box covers, 0 to 1. */
  personArea: number;
  /** Best score for any animal class this detector knows (see ANIMAL_CLASS_INDICES). */
  animal: number;
  /** Confident animal boxes left after NMS, of any animal class. */
  count: number;
}

/** The subject box and light of one photo, for Gallery search by composition and light. */
export interface PhotoFrame {
  /** Best animal box [x1, y1, x2, y2] as fractions of the upright photo, or null. */
  box: [number, number, number, number] | null;
  unsure: boolean;
  /** 0 to 1: how much to trust the box for framing (see SUBJECT_FRAMING_MIN). 0 with no box. */
  confidence: number;
  /** Upright width / height. */
  aspect: number;
  light: { luma: number; warmth: number; highlights: number; shadows: number; saturation: number };
}

export interface CardCrop {
  x: number;
  y: number;
  size: number;
}

export type InferenceRequest =
  | {
      op: "analyze";
      image: ImageInput;
      /** Content hash, for the detection memo. Null skips it. */
      key: string | null;
      targets: EmbedTarget[];
      detectorPath: string;
      detectorProviders?: ProviderSpec[];
      presence: boolean;
      cardCrop: boolean;
      /** Run detection (or reuse it) only to report subjectUnsure. */
      subject?: boolean;
      /** Report the subject box and light stats (PhotoFrame). */
      frame?: boolean;
    }
  | { op: "text"; texts: string[]; model: TextModelSpec; allowDownload: boolean }
  | {
      op: "warm";
      models: Array<{ modelPath: string; providers?: ProviderSpec[] }>;
      detector: { modelPath: string; providers?: ProviderSpec[] } | null;
      text: TextModelSpec | null;
    }
  | { op: "release"; modelPath: string | null }
  /** Scene classes and colours of the whole photo (sceneModel.ts). Always on the CPU. */
  | { op: "scene"; image: ImageInput; modelPath: string; missingMessage: string }
  /** Times a model on a backend and returns its output for a fixed input (accelerationSelect.ts). */
  | { op: "probe"; modelPath: string; providers: ProviderSpec[]; dims: number[]; runs: number };

export interface ProbeResult {
  probe: true;
  /** Median milliseconds per run. */
  ms: number;
  vector: Float32Array;
}

export interface AnalyzeResult {
  /** One per target, in order: the L2-normalized vector, or why it couldn't be computed. */
  vectors: Array<Float32Array | { error: string }>;
  presence: SubjectPresence | null;
  cardCrop: CardCrop | null;
  /** Whether the detector was unsure of the subject (see DetectionOutcome), when it ran. */
  subjectUnsure: boolean | null;
  /** With `frame`: the subject box and light stats. */
  frame?: PhotoFrame | null;
}

export interface SceneResult {
  /** Percent of the frame per ADE20K class (SCENE_LABELS), 1% and up. */
  labels: SceneShares;
  /** Percent of the frame per colour name (SCENE_COLORS), 1% and up. */
  colors: SceneShares;
}

export type InferenceResult = AnalyzeResult | Float32Array[] | ProbeResult | SceneResult | null;

export interface RunHooks {
  /** Called right before and after every model run, so the caller can time just the run. */
  runStarted(label: string): void;
  runEnded(): void;
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "result"; id: number; result: InferenceResult }
  | { type: "error"; id: number; message: string }
  | { type: "run-start"; id: number; label: string }
  | { type: "run-end"; id: number };

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

// Loading a session takes seconds, so it stays loaded while in use and is released when idle.
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
// One model runs at a time, so it gets every core but one, leaving one for the API thread.
const INTRA_OP_THREADS = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1);

type Ort = typeof import("onnxruntime-node");
let ortModule: Promise<Ort> | null = null;
const ort = () => {
  // Lifer never phones home; onnxruntime-node's usage data is on unless disabled before loading.
  process.env.ORT_DISABLE_TELEMETRY = "1";
  return (ortModule ??= process.env.LIFER_ORT_MODULE
    ? Promise.resolve(createRequire(import.meta.url)(process.env.LIFER_ORT_MODULE) as Ort)
    : import("onnxruntime-node"));
};

interface SessionEntry {
  session: Promise<InferenceSession>;
  timer: ReturnType<typeof setTimeout> | null;
}
const sessions = new Map<string, SessionEntry>();

async function createSession(
  modelPath: string,
  providers: ProviderSpec[],
  extra: InferenceSession.SessionOptions = {},
): Promise<InferenceSession> {
  const { InferenceSession } = await ort();
  return InferenceSession.create(modelPath, {
    intraOpNumThreads: INTRA_OP_THREADS,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
    // The CPU is always listed last, so a step the GPU can't run falls back to it.
    executionProviders: [...providers.filter((p) => p !== "cpu"), "cpu"] as never,
    ...extra,
  });
}

const sessionKey = (modelPath: string, providers?: ProviderSpec[]) =>
  `${modelPath}|${JSON.stringify(providers ?? ["cpu"])}`;

function getSession(modelPath: string, missingMessage: string, providers?: ProviderSpec[]): Promise<InferenceSession> {
  const key = sessionKey(modelPath, providers);
  const hit = sessions.get(key);
  if (hit) {
    if (hit.timer) clearTimeout(hit.timer);
    hit.timer = null;
    return hit.session;
  }
  const session = (async () => {
    if (!existsSync(modelPath)) throw new Error(missingMessage);
    if (!providers?.some((p) => p !== "cpu")) return createSession(modelPath, []);
    try {
      return await createSession(modelPath, providers);
    } catch (err) {
      // A backend that passed the self-test can stop loading (a driver update); the CPU gives the
      // same answers, only slower.
      log.warn(
        `[inference] Couldn't load ${modelPath} on the GPU, using the CPU: ${(err as Error).message.split("\n")[0]}`,
      );
      return createSession(modelPath, []);
    }
  })();
  const entry: SessionEntry = { session, timer: null };
  sessions.set(key, entry);
  // A failed load isn't cached, so the next call retries (the file may have just arrived).
  session.catch(() => {
    if (sessions.get(key) === entry) sessions.delete(key);
  });
  return session;
}

// Jobs never overlap, so arming this after each one can't unload a session mid-run.
function armIdleUnload(modelPath: string, providers?: ProviderSpec[]): void {
  const key = sessionKey(modelPath, providers);
  const entry = sessions.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => releaseSessionKey(key), IDLE_UNLOAD_MS);
  entry.timer.unref?.();
}

function releaseSessionKey(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  sessions.delete(key);
  entry.session.then((s) => s.release()).catch(() => {});
}

/** Every session of this model file, on any backend. */
function releaseSession(modelPath: string): void {
  for (const key of [...sessions.keys()]) if (key.startsWith(`${modelPath}|`)) releaseSessionKey(key);
}

/** Every output of one run, in session.outputNames order. */
async function runOutputs(
  session: InferenceSession,
  input: Float32Array,
  dims: number[],
  hooks: RunHooks,
  label: string,
): Promise<Tensor[]> {
  const { Tensor } = await ort();
  const tensor = new Tensor("float32", input, dims);
  hooks.runStarted(label);
  try {
    const results = await session.run({ [session.inputNames[0]]: tensor });
    return session.outputNames.map((name) => results[name]);
  } finally {
    hooks.runEnded();
  }
}

async function run(
  session: InferenceSession,
  input: Float32Array,
  dims: number[],
  hooks: RunHooks,
  label: string,
): Promise<Tensor> {
  return (await runOutputs(session, input, dims, hooks, label))[0];
}

// ---------------------------------------------------------------------------------------------
// CLIP-family image encoders
// ---------------------------------------------------------------------------------------------

const CLIP_INPUT_SIZE = 224;
// CLIP's published normalization constants, expected by every CLIP-family encoder.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

/** HWC uint8 RGB into normalized NCHW float32. */
function normalizedTensor(data: Uint8Array, mean: number[], std: number[]): Float32Array {
  const pixelCount = data.length / 3;
  const floats = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[i * 3 + c] / 255;
      floats[c * pixelCount + i] = (value - mean[c]) / std[c];
    }
  }
  return floats;
}

/** 224x224 HWC uint8 RGB into CLIP-normalized NCHW float32. */
const clipTensor = (data: Uint8Array) => normalizedTensor(data, CLIP_MEAN, CLIP_STD);

// A grayscale file decodes to one channel; the tensor loops expect three.
function toRgb(data: Buffer, channels: number): Buffer {
  if (channels === 3) return data;
  if (channels !== 1) throw new Error(`Unexpected ${channels}-channel image`);
  const out = Buffer.alloc(data.length * 3);
  for (let i = 0; i < data.length; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = data[i];
  return out;
}

/** The whole photo resized/cropped to 224x224, exactly as the stored vectors were computed. */
export async function preprocessImage(bytes: ImageData): Promise<Float32Array> {
  const { data, info } = await openImage(bytes)
    .rotate()
    .resize(CLIP_INPUT_SIZE, CLIP_INPUT_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return clipTensor(toRgb(data, info.channels));
}

export function l2Normalize(vec: ArrayLike<number>): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vec.length; i++) sumSquares += vec[i] * vec[i];
  const norm = Math.sqrt(sumSquares) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function embedTensor(target: EmbedTarget, floats: Float32Array, hooks: RunHooks): Promise<Float32Array> {
  const session = await getSession(target.modelPath, target.missingMessage, target.providers);
  const out = await run(session, floats, [1, 3, CLIP_INPUT_SIZE, CLIP_INPUT_SIZE], hooks, "embed");
  return l2Normalize(out.data as Float32Array);
}

// ---------------------------------------------------------------------------------------------
// Animal detection (YOLOv8n, COCO)
// ---------------------------------------------------------------------------------------------
// A whole-image embedding blends in background and lighting, so the query photo is cropped to the
// animal. Only the query is cropped, never stored reference or gallery photos.

const DETECT_SIZE = 640;
// Gates only the "any class" fallback. Animal-class boxes use the much lower ANIMAL_FLOOR, since
// missing a borderline score means no crop at all.
const CONF_THRESHOLD = 0.25;
// Screens out anchors with no signal; distant birds can score this low.
const ANIMAL_FLOOR = 0.03;
const CROP_PADDING_FRACTION = 0.125;
// A box under this share of the photo is too small to trust on its own (a speck, or a fragment).
const UNSURE_BOX_SHARE = 0.02;
// A card crop is a framing shown at a glance, so it gets more breathing room than the tight crop.
const CARD_CROP_PADDING_FRACTION = 0.3;
// @lifer/shared's MIN_CARD_CROP_PERCENT, repeated because this file imports nothing from the app
// (a test checks the two match).
export const MIN_CARD_CROP_PERCENT = 8;
// The animal detector's one "animal" class (any animal at all), given an index past COCO's 80 so
// both detectors' boxes share one numbering.
const ANY_ANIMAL_CLASS_INDEX = 80;
// bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe (COCO order), and any animal
const ANIMAL_CLASS_INDICES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, ANY_ANIMAL_CLASS_INDEX]);
const PERSON_CLASS_INDEX = 0;
// The animal detector's classes (animal, person, vehicle) in that numbering; a vehicle counts as a car.
const ANIMAL_DETECTOR_CLASSES = [ANY_ANIMAL_CLASS_INDEX, PERSON_CLASS_INDEX, 2];
// A 640 px pass shrinks a large photo so much that a small bird vanishes. Overlapping 3x3 tiles
// give it more pixels; tried only when the whole pass isn't confident.
const TILE_GRID = 3;
const TILE_OVERLAP = 0.25;
// The animal detector already finds small subjects at 640 px, so it tiles only a photo with well over
// that many pixels to give it (each of its passes costs several of the basic detector's).
const ANIMAL_DETECTOR_TILE_MIN_SIDE = 2 * DETECT_SIZE;
// Its clear subjects score 0.8 and up; below this the whole-frame pass is likely a guess, and a
// small animal in a big photo is found more surely on the tiles.
const ANIMAL_DETECTOR_TILE_BELOW = 0.5;

export interface Detection {
  score: number;
  classIndex: number;
  /** xyxy in the upright original photo's pixel space. */
  box: [number, number, number, number];
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Letterboxes an image into a gray-padded 640x640 canvas (ultralytics' preprocessing), returning
 * [0,1] CHW floats and how to map boxes back. width and height are the upright size. */
async function letterbox(
  bytes: ImageData,
  width: number,
  height: number,
): Promise<{ floats: Float32Array; scale: number; padX: number; padY: number }> {
  const scale = Math.min(DETECT_SIZE / width, DETECT_SIZE / height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  const padX = Math.floor((DETECT_SIZE - newWidth) / 2);
  const padY = Math.floor((DETECT_SIZE - newHeight) / 2);
  const { data, info } = await openImage(bytes)
    .rotate()
    .resize(newWidth, newHeight, { fit: "fill" })
    .extend({
      top: padY,
      bottom: DETECT_SIZE - newHeight - padY,
      left: padX,
      right: DETECT_SIZE - newWidth - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = toRgb(data, info.channels);
  const floats = new Float32Array(3 * DETECT_SIZE * DETECT_SIZE);
  const pixelCount = DETECT_SIZE * DETECT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) floats[c * pixelCount + i] = rgb[i * 3 + c] / 255;
  }
  return { floats, scale, padX, padY };
}

/** Subject candidates in one pass, best first: animal-class boxes over ANIMAL_FLOOR after NMS that
 * score close enough to the best one to be the subject, else the top box of any class over
 * CONF_THRESHOLD, else none. Coordinates are in the 640 px letterboxed canvas. */
function pickDetections(output: Float32Array, numAnchors: number, numClasses: number): Detection[] {
  const animals: Detection[] = [];
  let bestAny: Detection | null = null;
  for (let i = 0; i < numAnchors; i++) {
    let bestClassScore = -Infinity;
    let bestClassIndex = -1;
    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * numAnchors + i];
      if (score > bestClassScore) {
        bestClassScore = score;
        bestClassIndex = c;
      }
    }
    const isAnimal = ANIMAL_CLASS_INDICES.has(bestClassIndex);
    if (bestClassScore < (isAnimal ? ANIMAL_FLOOR : CONF_THRESHOLD)) continue;
    const cx = output[0 * numAnchors + i];
    const cy = output[1 * numAnchors + i];
    const w = output[2 * numAnchors + i];
    const h = output[3 * numAnchors + i];
    const detection: Detection = {
      score: bestClassScore,
      classIndex: bestClassIndex,
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    };
    if (isAnimal) animals.push(detection);
    else if (!bestAny || bestClassScore > bestAny.score) bestAny = detection;
  }
  return subjectCandidates(animals, bestAny);
}

/** Animal boxes that score close enough to the best one to be the subject, after NMS; else the
 *  best box of any other class, else none. */
function subjectCandidates(animals: Detection[], bestAny: Detection | null): Detection[] {
  if (animals.length === 0) return bestAny ? [bestAny] : [];
  animals.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const d of animals) {
    if (d.score < animals[0].score * RIVAL_MIN_RATIO || kept.length === MAX_RIVALS) break;
    if (kept.every((k) => iou(k.box, d.box) < COUNT_IOU)) kept.push(d);
  }
  return kept;
}

// Other animals scoring at least this share of the best one compete to be the subject.
const RIVAL_MIN_RATIO = 0.4;
const MAX_RIVALS = 5;
// Below this share of the sharpest candidate's detail, a candidate counts as out of focus.
const SHARP_SHARE = 0.5;
const EDGE_MARGIN = 0.005;
// The Compare view zooms to the box only from this confidence up; below it shows the whole frame.
export const SUBJECT_FRAMING_MIN = 0.15;
// Two candidates ranking this close are both plausible subjects (a flock): no single framing.
const RIVAL_TIE = 0.85;

/** Where a candidate's box sits in the photo, as the subject ranking weighs it. */
function placement(box: Detection["box"], size: { width: number; height: number }) {
  const [x1, y1, x2, y2] = [box[0] / size.width, box[1] / size.height, box[2] / size.width, box[3] / size.height];
  const share = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const offCentre = Math.hypot((x1 + x2) / 2 - 0.5, (y1 + y2) / 2 - 0.5) / Math.SQRT1_2;
  const atEdge = x1 <= EDGE_MARGIN || y1 <= EDGE_MARGIN || x2 >= 1 - EDGE_MARGIN || y2 >= 1 - EDGE_MARGIN;
  return { share, offCentre: Math.min(1, offCentre), atEdge };
}

/** Ranks subject candidates: the detector's score, weighed toward the sharp, the larger, the
 * central and those clear of the frame edge (a fragment cut off by it, or a stray at the margin).
 * `detail` is each box's Laplacian variance, compared with the sharpest's. Returns the pick and
 * how much to trust it for framing. */
export function pickSubject(
  candidates: Detection[],
  detail: number[],
  size: { width: number; height: number },
): { subject: Detection; confidence: number } | null {
  if (candidates.length === 0) return null;
  const sharpest = Math.max(...detail, 0);
  const ranked = candidates
    .map((d, i) => {
      const { share, offCentre, atEdge } = placement(d.box, size);
      const sharp = sharpest > 0 ? Math.max(0.1, Math.min(1, detail[i] / sharpest / SHARP_SHARE)) : 1;
      const edge = atEdge ? 0.5 : 1;
      const rank = d.score * sharp * edge * (1 - 0.5 * offCentre) * (0.8 + 0.2 * Math.min(1, share / 0.05));
      return { d, rank, edge };
    })
    .sort((a, b) => b.rank - a.rank);
  const [best, rival] = ranked;
  const animal = ANIMAL_CLASS_INDICES.has(best.d.classIndex);
  const tied = rival && rival.rank >= best.rank * RIVAL_TIE && iou(best.d.box, rival.d.box) === 0;
  return { subject: best.d, confidence: animal && !tied ? best.d.score * best.edge : 0 };
}

/** Variance of the Laplacian of a single-channel image inside a box: high for sharp detail. */
export function laplacianVariance(
  grey: Uint8Array,
  width: number,
  height: number,
  box: [number, number, number, number],
): number {
  const x0 = Math.max(1, Math.floor(box[0]));
  const y0 = Math.max(1, Math.floor(box[1]));
  const x1 = Math.min(width - 1, Math.ceil(box[2]));
  const y1 = Math.min(height - 1, Math.ceil(box[3]));
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const l = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - width] - grey[i + width];
      sum += l;
      sumSq += l * l;
      n++;
    }
  return n > 0 ? sumSq / n - (sum / n) ** 2 : 0;
}

// Sharpness is read on a copy this size: enough to tell a soft background bird from a sharp one.
const DETAIL_SIZE = 1024;

/** laplacianVariance of each box (in the photo's pixel space), on one greyscale decode. */
async function boxDetail(
  bytes: ImageData,
  size: { width: number; height: number },
  boxes: Detection["box"][],
): Promise<number[]> {
  const scale = Math.min(1, DETAIL_SIZE / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const { data } = await openImage(bytes)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return boxes.map((b) => laplacianVariance(data, width, height, b.map((v) => v * scale) as Detection["box"]));
}

/** Animal-class first, then score: the same preference pickDetections uses within a pass. */
function isBetterDetection(candidate: Detection, current: Detection): boolean {
  const candidateAnimal = ANIMAL_CLASS_INDICES.has(candidate.classIndex);
  const currentAnimal = ANIMAL_CLASS_INDICES.has(current.classIndex);
  if (candidateAnimal !== currentAnimal) return candidateAnimal;
  return candidate.score > current.score;
}

function buildTiles(width: number, height: number): Rect[] {
  const stepX = width / TILE_GRID;
  const stepY = height / TILE_GRID;
  const tileWidth = Math.min(width, Math.ceil(stepX * (1 + TILE_OVERLAP)));
  const tileHeight = Math.min(height, Math.ceil(stepY * (1 + TILE_OVERLAP)));
  const tiles: Rect[] = [];
  for (let row = 0; row < TILE_GRID; row++) {
    for (let col = 0; col < TILE_GRID; col++) {
      const left = Math.min(Math.round(col * stepX), width - tileWidth);
      const top = Math.min(Math.round(row * stepY), height - tileHeight);
      tiles.push({ left: Math.max(0, left), top: Math.max(0, top), width: tileWidth, height: tileHeight });
    }
  }
  return tiles;
}

interface DetectionOutcome {
  /** Best subject box in the upright original photo's pixel space, or null. */
  box: [number, number, number, number] | null;
  /** The detector wasn't sure the box is the animal: it came from the tile fallback or is tiny. */
  unsure: boolean;
  /** See PhotoFrame.confidence. */
  confidence: number;
  width: number;
  height: number;
  presence: SubjectPresence;
}

/** The animal detector (MegaDetector v6, RT-DETR) has two outputs, logits and boxes; the basic
 *  one has a single YOLO tensor. */
const isAnimalDetector = (session: InferenceSession) => session.outputNames.length === 2;

/** The photo squashed to 640x640 (how the animal detector was trained), as [0,1] CHW floats. */
async function squashed(bytes: ImageData): Promise<Float32Array> {
  const { data, info } = await openImage(bytes)
    .rotate()
    .resize(DETECT_SIZE, DETECT_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = toRgb(data, info.channels);
  const pixelCount = DETECT_SIZE * DETECT_SIZE;
  const floats = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) for (let c = 0; c < 3; c++) floats[c * pixelCount + i] = rgb[i * 3 + c] / 255;
  return floats;
}

// The animal detector scores some query "animal" up to about this in any photo (foliage, water), so
// the presence reading starts here, where the basic detector's reads near zero on an empty scene.
const ANIMAL_NOISE = 0.15;

/** A box under UNSURE_BOX_SHARE of the frame, cut by its edge (fractions of the image): the bow of
 *  the boat, a post at the margin. It doesn't count as an animal in the photo. */
const edgeSpeck = (cx: number, cy: number, w: number, h: number) =>
  w * h < UNSURE_BOX_SHARE &&
  (cx - w / 2 <= EDGE_MARGIN ||
    cy - h / 2 <= EDGE_MARGIN ||
    cx + w / 2 >= 1 - EDGE_MARGIN ||
    cy + h / 2 >= 1 - EDGE_MARGIN);

/** The animal detector's output: per query, class logits and a (cx, cy, w, h) box as fractions of
 *  the image. Returns the subject candidates in the image's pixel space and the presence reading. */
export function readAnimalDetector(
  logits: Float32Array,
  boxes: Float32Array,
  size: { width: number; height: number },
): { detections: Detection[]; presence: SubjectPresence } {
  const queries = boxes.length / 4;
  const classes = logits.length / queries;
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const animals: Detection[] = [];
  let bestAny: Detection | null = null;
  const presence: SubjectPresence = { person: 0, personArea: 0, animal: 0, count: 0 };
  const counted: Array<{ score: number; box: Detection["box"] }> = [];
  for (let q = 0; q < queries; q++) {
    const [cx, cy, w, h] = [boxes[q * 4], boxes[q * 4 + 1], boxes[q * 4 + 2], boxes[q * 4 + 3]];
    const box: Detection["box"] = [
      (cx - w / 2) * size.width,
      (cy - h / 2) * size.height,
      (cx + w / 2) * size.width,
      (cy + h / 2) * size.height,
    ];
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < classes; c++) {
      const score = sigmoid(logits[q * classes + c]);
      const kind = ANIMAL_DETECTOR_CLASSES[c];
      if (kind === ANY_ANIMAL_CLASS_INDEX && score >= ANIMAL_NOISE && !edgeSpeck(cx, cy, w, h))
        presence.animal = Math.max(presence.animal, score);
      if (kind === PERSON_CLASS_INDEX && score > presence.person) {
        presence.person = score;
        presence.personArea = Math.min(1, w * h);
      }
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    const classIndex = ANIMAL_DETECTOR_CLASSES[best] ?? -1;
    const animal = classIndex === ANY_ANIMAL_CLASS_INDEX;
    if (animal && bestScore >= CONF_THRESHOLD) counted.push({ score: bestScore, box });
    if (bestScore < (animal ? ANIMAL_FLOOR : CONF_THRESHOLD)) continue;
    const detection: Detection = { score: bestScore, classIndex, box };
    if (animal) animals.push(detection);
    else if (!bestAny || bestScore > bestAny.score) bestAny = detection;
  }
  presence.count = countBoxes(counted);
  return { detections: subjectCandidates(animals, bestAny), presence };
}

/** One pass over an encoded image (the photo, or one tile of it at `offset`). Returns the subject
 * candidates mapped into the photo's space, plus the presence reading. */
async function detectPass(
  session: InferenceSession,
  bytes: ImageData,
  size: { width: number; height: number },
  offset: Rect | null,
  hooks: RunHooks,
): Promise<{ detections: Detection[]; presence: SubjectPresence }> {
  const offsetX = offset?.left ?? 0;
  const offsetY = offset?.top ?? 0;
  const shift = (d: Detection, f: (v: number, axis: 0 | 1) => number): Detection => ({
    ...d,
    box: [f(d.box[0], 0) + offsetX, f(d.box[1], 1) + offsetY, f(d.box[2], 0) + offsetX, f(d.box[3], 1) + offsetY],
  });
  if (isAnimalDetector(session)) {
    const [logits, boxes] = await runOutputs(
      session,
      await squashed(bytes),
      [1, 3, DETECT_SIZE, DETECT_SIZE],
      hooks,
      "detect",
    );
    const read = readAnimalDetector(logits.data as Float32Array, boxes.data as Float32Array, size);
    return { detections: read.detections.map((d) => shift(d, (v) => v)), presence: read.presence };
  }
  const { floats, scale, padX, padY } = await letterbox(bytes, size.width, size.height);
  const out = await run(session, floats, [1, 3, DETECT_SIZE, DETECT_SIZE], hooks, "detect");
  const [, numAttrs, numAnchors] = out.dims as [number, number, number];
  const data = out.data as Float32Array;
  const detections = pickDetections(data, numAnchors, numAttrs - 4).map((d) =>
    shift(d, (v, axis) => (v - (axis === 0 ? padX : padY)) / scale),
  );
  // Boxes are in the 640 px canvas; the photo itself fills (width * scale) x (height * scale).
  const imageArea = Math.max(1, size.width * scale * size.height * scale);
  return { detections, presence: readPresence(data, numAnchors, numAttrs - 4, imageArea) };
}

/** Person and animal scores from the basic detector's whole-frame pass. It knows only ten animal
 * kinds, so the useful signal is a confident person with no animal. */
function readPresence(data: Float32Array, numAnchors: number, numClasses: number, imageArea: number): SubjectPresence {
  let person = 0;
  let personArea = 0;
  let animal = 0;
  for (let i = 0; i < numAnchors; i++) {
    const p = data[(4 + PERSON_CLASS_INDEX) * numAnchors + i];
    if (p > person) {
      person = p;
      personArea = Math.min(1, (data[2 * numAnchors + i] * data[3 * numAnchors + i]) / imageArea);
    }
    for (const c of ANIMAL_CLASS_INDICES) {
      if (c >= numClasses) continue;
      const a = data[(4 + c) * numAnchors + i];
      if (a > animal) animal = a;
    }
  }
  return { person, personArea, animal, count: countAnimals(data, numAnchors, numClasses) };
}

// Overlap at which two animal boxes are taken as one animal (ultralytics' NMS default).
const COUNT_IOU = 0.45;

/** Animals in one pass: animal-class boxes over CONF_THRESHOLD after class-agnostic NMS, since
 * the detector names a deer horse in one box and cow in the next. */
export function countAnimals(data: Float32Array, numAnchors: number, numClasses: number): number {
  const boxes: Array<{ score: number; box: [number, number, number, number] }> = [];
  for (let i = 0; i < numAnchors; i++) {
    let score = 0;
    for (const c of ANIMAL_CLASS_INDICES) if (c < numClasses) score = Math.max(score, data[(4 + c) * numAnchors + i]);
    if (score < CONF_THRESHOLD) continue;
    const cx = data[i];
    const cy = data[numAnchors + i];
    const w = data[2 * numAnchors + i];
    const h = data[3 * numAnchors + i];
    boxes.push({ score, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
  }
  return countBoxes(boxes);
}

/** Animals among confident boxes after class-agnostic NMS. */
function countBoxes(boxes: Array<{ score: number; box: [number, number, number, number] }>): number {
  boxes.sort((a, b) => b.score - a.score);
  const kept: Array<[number, number, number, number]> = [];
  for (const { box } of boxes) if (kept.every((k) => iou(k, box) < COUNT_IOU)) kept.push(box);
  return kept.length;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const overlap = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap;
  return union > 0 ? overlap / union : 0;
}

// Each tile is re-encoded in the photo's own format; the photo is decoded once for all tiles.
async function encodeTiles(bytes: ImageData, tiles: Rect[]): Promise<Uint8Array[]> {
  const format = (await openImage(bytes).metadata()).format;
  const { data, info } = await openImage(bytes).rotate().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
  return Promise.all(
    tiles.map(async (tile) => {
      const cut = sharp(data, raw).extract(tile);
      try {
        return await cut.toFormat(format as keyof FormatEnum).toBuffer();
      } catch {
        return await sharp(data, raw).extract(tile).png().toBuffer();
      }
    }),
  );
}

// An animal across a tile edge, or behind a branch, comes back in pieces. Pieces of the same
// class within one piece's length of each other are joined into one box; faint guesses stay out.
const TILE_MERGE_MIN_SCORE = 0.1;

/** The chosen (else the best) tile detection, grown to take in the other pieces of the same animal. */
export function mergeTileDetections(found: Detection[], chosen?: Detection): Detection | null {
  let best: Detection | null = chosen ?? null;
  if (!best) for (const d of found) if (!best || isBetterDetection(d, best)) best = d;
  if (!best) return null;
  const box = [...best.box] as Detection["box"];
  const longest = (b: Detection["box"]) => Math.max(b[2] - b[0], b[3] - b[1]);
  const pieces = found.filter(
    (d) => d !== best && d.classIndex === best!.classIndex && d.score >= TILE_MERGE_MIN_SCORE,
  );
  for (let grew = true; grew;) {
    grew = false;
    for (let i = pieces.length - 1; i >= 0; i--) {
      const b = pieces[i].box;
      // Reach is from the best piece, not the growing box, so joins can't chain across the photo.
      const reach = Math.max(longest(best.box), longest(b));
      const gapX = Math.max(0, Math.max(box[0], b[0]) - Math.min(box[2], b[2]));
      const gapY = Math.max(0, Math.max(box[1], b[1]) - Math.min(box[3], b[3]));
      if (gapX > reach || gapY > reach) continue;
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
      pieces.splice(i, 1);
      grew = true;
    }
  }
  return { ...best, box };
}

async function detect(
  bytes: ImageData,
  detectorPath: string,
  hooks: RunHooks,
  providers?: ProviderSpec[],
): Promise<DetectionOutcome> {
  const session = await getSession(detectorPath, "The animal detector model is missing", providers);
  try {
    const size = await originalSize(bytes);
    const whole = await detectPass(session, bytes, size, null, hooks);
    const presence = whole.presence;
    // Sharpness is only read when there is a choice to make.
    const choose = async (candidates: Detection[]) =>
      pickSubject(
        candidates,
        candidates.length > 1
          ? await boxDetail(
              bytes,
              size,
              candidates.map((d) => d.box),
            )
          : [],
        size,
      );
    let picked = await choose(whole.detections);
    let fromTiles = false;
    // Also tile after a weak whole-pass guess, since a small subject almost always scores faintly.
    // Whichever result looks better wins.
    const tileable = !isAnimalDetector(session) || Math.max(size.width, size.height) >= ANIMAL_DETECTOR_TILE_MIN_SIDE;
    const tileBelow = isAnimalDetector(session) ? ANIMAL_DETECTOR_TILE_BELOW : CONF_THRESHOLD;
    if (tileable && (!whole.detections[0] || whole.detections[0].score < tileBelow)) {
      const tiles = buildTiles(size.width, size.height);
      const tileBytes = await encodeTiles(bytes, tiles);
      const found: Detection[] = [];
      for (let i = 0; i < tiles.length; i++) {
        const { detections } = await detectPass(session, tileBytes[i], tiles[i], tiles[i], hooks);
        if (detections[0]) found.push(detections[0]);
      }
      const tiledPick = await choose(found);
      const tiled = tiledPick && mergeTileDetections(found, tiledPick.subject);
      if (tiled && (!picked || isBetterDetection(tiled, picked.subject))) {
        picked = { subject: tiled, confidence: tiledPick.confidence };
        fromTiles = true;
      }
    }
    const box = picked?.subject.box ?? null;
    const boxShare = box ? ((box[2] - box[0]) * (box[3] - box[1])) / Math.max(1, size.width * size.height) : 0;
    const unsure = !box || fromTiles || boxShare < UNSURE_BOX_SHARE;
    return {
      box,
      unsure,
      confidence: picked?.confidence ?? 0,
      width: size.width,
      height: size.height,
      presence,
    };
  } finally {
    armIdleUnload(detectorPath, providers);
  }
}

// Detection is the slowest step and the same photo is detected several times during an import,
// so results are remembered by content hash.
const DETECTION_MEMO_SIZE = 200;
const detectionMemo = new Map<string, DetectionOutcome>();

function rememberDetection(key: string, outcome: DetectionOutcome): void {
  detectionMemo.set(key, outcome);
  if (detectionMemo.size > DETECTION_MEMO_SIZE) detectionMemo.delete(detectionMemo.keys().next().value!);
}

/** Upright pixel size of the original photo (orientations 5-8 are stored a quarter turn off). */
async function originalSize(bytes: ImageData): Promise<{ width: number; height: number }> {
  const meta = await openImage(bytes).metadata();
  const turned = (meta.orientation ?? 1) >= 5;
  return { width: (turned ? meta.height : meta.width) ?? 0, height: (turned ? meta.width : meta.height) ?? 0 };
}

/** The padded subject crop in the original photo's pixel space, or null when not worth cropping.
 * Made square by taking in more of the photo, so the square model input doesn't cut the subject. */
export function subjectCropRect(outcome: DetectionOutcome): Rect | null {
  const orig = { width: outcome.width, height: outcome.height };
  if (!outcome.box || orig.width < 1 || orig.height < 1) return null;
  const [x1, y1, x2, y2] = outcome.box;
  const padX = (x2 - x1) * CROP_PADDING_FRACTION;
  const padY = (y2 - y1) * CROP_PADDING_FRACTION;
  const side = Math.min(Math.max(x2 - x1 + 2 * padX, y2 - y1 + 2 * padY), orig.width, orig.height);
  if (side < 10) return null; // degenerate box, not worth cropping to
  const size = Math.floor(side);
  const left = Math.round(Math.min(Math.max((x1 + x2) / 2 - size / 2, 0), orig.width - size));
  const top = Math.round(Math.min(Math.max((y1 + y2) / 2 - size / 2, 0), orig.height - size));
  return { left, top, width: size, height: size };
}

/** A square card crop centered on the subject, as percentages of the photo's width (the crop
 * editor's format). */
export function cardCropFor(outcome: DetectionOutcome): CardCrop | null {
  if (!outcome.box) return null;
  const [x1, y1, x2, y2] = outcome.box;
  const { width, height } = outcome;
  const boxWidth = x2 - x1;
  const boxHeight = y2 - y1;
  const centerX = x1 + boxWidth / 2;
  const centerY = y1 + boxHeight / 2;
  const maxSquare = Math.min(width, height);
  const minPx = (MIN_CARD_CROP_PERCENT / 100) * width;
  const sizePx = Math.min(Math.max(Math.max(boxWidth, boxHeight) * (1 + CARD_CROP_PADDING_FRACTION), minPx), maxSquare);
  const left = Math.min(Math.max(centerX - sizePx / 2, 0), width - sizePx);
  const top = Math.min(Math.max(centerY - sizePx / 2, 0), height - sizePx);
  return { x: (left / width) * 100, y: (top / width) * 100, size: (sizePx / width) * 100 };
}

// The crop is cut from the full-resolution photo and resized once, with no JPEG re-encode between.
async function cropTensor(bytes: ImageData, rect: Rect): Promise<Float32Array> {
  const { data, info } = await openImage(bytes)
    .rotate()
    .extract(rect)
    .resize(CLIP_INPUT_SIZE, CLIP_INPUT_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return clipTensor(toRgb(data, info.channels));
}

async function analyze(req: Extract<InferenceRequest, { op: "analyze" }>, hooks: RunHooks): Promise<AnalyzeResult> {
  const bytes = "bytes" in req.image ? req.image.bytes : await decodableInput(req.image.path);
  const needsDetection =
    req.presence || req.cardCrop || !!req.subject || !!req.frame || req.targets.some((t) => t.crop || t.maskSubject);

  let outcome: DetectionOutcome | null = null;
  let cropRect: Rect | null = null;
  if (needsDetection) {
    const memo = req.key ? detectionMemo.get(req.key) : undefined;
    try {
      if (memo) outcome = memo;
      else {
        outcome = await detect(bytes, req.detectorPath, hooks, req.detectorProviders);
        if (req.key) rememberDetection(req.key, outcome);
      }
      if (req.targets.some((t) => t.crop) && outcome.box) cropRect = subjectCropRect(outcome);
    } catch {
      // Best effort: without a detection the photo is matched whole.
      outcome = null;
      cropRect = null;
    }
  }

  let fullFrame: Float32Array | null = null;
  const fullFrameTensor = async () => (fullFrame ??= await preprocessImage(bytes));
  let cropFloats: Promise<Float32Array> | null = null;

  const vectors: AnalyzeResult["vectors"] = [];
  for (const target of req.targets) {
    try {
      let floats: Float32Array;
      if (target.maskSubject) {
        const bg = outcome && backgroundBox(outcome);
        if (!bg) throw new Error("No background to read");
        floats = await maskedTensor(bytes, bg, outcome!);
      } else if (target.crop && cropRect) floats = await (cropFloats ??= cropTensor(bytes, cropRect));
      else floats = await fullFrameTensor();
      vectors.push(await embedTensor(target, floats, hooks));
    } catch (err) {
      vectors.push({ error: (err as Error).message });
    } finally {
      armIdleUnload(target.modelPath, target.providers);
    }
  }

  return {
    vectors,
    presence: req.presence ? (outcome?.presence ?? null) : null,
    cardCrop: req.cardCrop && outcome ? cardCropFor(outcome) : null,
    subjectUnsure: needsDetection ? (outcome?.unsure ?? true) : null,
    ...(req.frame ? { frame: await photoFrame(bytes, outcome) } : {}),
  };
}

// The background vector needs the animal to leave this much of the frame, or there's nothing to read.
const BACKGROUND_MAX_SUBJECT_SHARE = 0.6;
// Greyed out a little past the box, so the animal's edges don't count as background.
const BACKGROUND_MASK_PADDING = 0.1;
const LIGHT_SAMPLE_SIZE = 64;

/** The subject box as fractions of the upright photo, padded for masking, or null when there's no
 *  box or it leaves too little background. */
function backgroundBox(outcome: DetectionOutcome): [number, number, number, number] | null {
  if (!outcome.box || outcome.width < 1 || outcome.height < 1) return null;
  const [x1, y1, x2, y2] = outcome.box;
  const share = ((x2 - x1) * (y2 - y1)) / (outcome.width * outcome.height);
  if (share > BACKGROUND_MAX_SUBJECT_SHARE) return null;
  const padX = (x2 - x1) * BACKGROUND_MASK_PADDING;
  const padY = (y2 - y1) * BACKGROUND_MASK_PADDING;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp((x1 - padX) / outcome.width),
    clamp((y1 - padY) / outcome.height),
    clamp((x2 + padX) / outcome.width),
    clamp((y2 + padY) / outcome.height),
  ];
}

/** The whole photo as the stored vectors see it (224 px, centre cover crop), with the box filled
 *  with CLIP's mean colour, which normalizes to zero. */
async function maskedTensor(
  bytes: ImageData,
  box: [number, number, number, number],
  size: { width: number; height: number },
): Promise<Float32Array> {
  const { data, info } = await openImage(bytes)
    .rotate()
    .resize(CLIP_INPUT_SIZE, CLIP_INPUT_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = toRgb(data, info.channels);
  // Where the cover crop put the photo: scaled to cover, then centred.
  const scale = Math.max(CLIP_INPUT_SIZE / size.width, CLIP_INPUT_SIZE / size.height);
  const offX = (size.width * scale - CLIP_INPUT_SIZE) / 2;
  const offY = (size.height * scale - CLIP_INPUT_SIZE) / 2;
  const px = (f: number, side: number, off: number) =>
    Math.min(CLIP_INPUT_SIZE, Math.max(0, Math.round(f * side * scale - off)));
  const [left, top] = [px(box[0], size.width, offX), px(box[1], size.height, offY)];
  const [right, bottom] = [px(box[2], size.width, offX), px(box[3], size.height, offY)];
  const fill = CLIP_MEAN.map((m) => Math.round(m * 255));
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) for (let c = 0; c < 3; c++) rgb[(y * CLIP_INPUT_SIZE + x) * 3 + c] = fill[c];
  return clipTensor(rgb);
}

/** Light stats of a small downscale of the whole photo (see PhotoFrame). */
export function lightStats(rgb: Uint8Array): PhotoFrame["light"] {
  const n = rgb.length / 3;
  let luma = 0;
  let warmth = 0;
  let highlights = 0;
  let shadows = 0;
  let saturation = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    luma += l;
    warmth += (r - b) / 255;
    if (l > 0.9) highlights++;
    if (l < 0.1) shadows++;
    const max = Math.max(r, g, b);
    if (max > 0) saturation += (max - Math.min(r, g, b)) / max;
  }
  const round = (v: number) => Math.round((v / Math.max(1, n)) * 1000) / 1000;
  return {
    luma: round(luma),
    warmth: round(warmth),
    highlights: round(highlights),
    shadows: round(shadows),
    saturation: round(saturation),
  };
}

async function photoFrame(bytes: ImageData, outcome: DetectionOutcome | null): Promise<PhotoFrame> {
  const size = outcome ?? (await originalSize(bytes));
  const { data, info } = await openImage(bytes)
    .rotate()
    .resize(LIGHT_SAMPLE_SIZE, LIGHT_SAMPLE_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const box = outcome?.box ?? null;
  const frac = (v: number, side: number) => Math.round(Math.min(1, Math.max(0, v / side)) * 10000) / 10000;
  return {
    box: box && [
      frac(box[0], size.width),
      frac(box[1], size.height),
      frac(box[2], size.width),
      frac(box[3], size.height),
    ],
    unsure: outcome?.unsure ?? true,
    confidence: Math.round((outcome?.confidence ?? 0) * 1000) / 1000,
    aspect: size.width / Math.max(1, size.height),
    light: lightStats(toRgb(data, info.channels)),
  };
}

// ---------------------------------------------------------------------------------------------
// Scene segmentation (UperNet ConvNeXt-tiny, ADE20K): a class per pixel
// ---------------------------------------------------------------------------------------------

const SCENE_INPUT_SIZE = 512;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

async function scene(req: Extract<InferenceRequest, { op: "scene" }>, hooks: RunHooks): Promise<SceneResult> {
  const bytes = "bytes" in req.image ? req.image.bytes : await decodableInput(req.image.path);
  // Squashed rather than cropped, so the edges of the frame count too.
  const { data, info } = await openImage(bytes)
    .rotate()
    .resize(SCENE_INPUT_SIZE, SCENE_INPUT_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = toRgb(data, info.channels);
  const session = await getSession(req.modelPath, req.missingMessage);
  try {
    const dims = [1, 3, SCENE_INPUT_SIZE, SCENE_INPUT_SIZE];
    const out = await run(session, normalizedTensor(rgb, IMAGENET_MEAN, IMAGENET_STD), dims, hooks, "scene");
    return summarizeScene(out.data as Uint8Array, rgb);
  } finally {
    armIdleUnload(req.modelPath);
  }
}

// ---------------------------------------------------------------------------------------------
// CLIP text encoder (@huggingface/transformers ships the tokenizer and the paired text model)
// ---------------------------------------------------------------------------------------------

interface TextModel {
  tokenizer: PreTrainedTokenizer;
  textModel: CLIPTextModelWithProjection;
}
let textModel: { key: string; model: Promise<TextModel>; timer: ReturnType<typeof setTimeout> | null } | null = null;

// Everything the text encoder loads, relative to its revision's cache folder.
const TEXT_MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/text_model_quantized.onnx"];

export function isTextCachePopulated(cacheDir: string): boolean {
  return existsSync(cacheDir) && readdirSync(cacheDir).length > 0;
}

function getTextModel(spec: TextModelSpec, allowDownload: boolean): Promise<TextModel> {
  // Never auto-downloads on ordinary use: the model is an opt-in download (Settings > Offline Data).
  if (!allowDownload && !isTextCachePopulated(spec.cacheDir)) throw new Error(spec.missingMessage);
  const key = `${spec.modelId}@${spec.revision}:${spec.cacheDir}`;
  if (textModel && textModel.key === key) {
    if (textModel.timer) clearTimeout(textModel.timer);
    textModel.timer = null;
    return textModel.model;
  }
  releaseText();
  const model = (async () => {
    const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import("@huggingface/transformers");
    env.cacheDir = spec.cacheDir;
    // A cached revision loads from its folder: the library's tokenizer lookup ignores `revision`
    // and would otherwise go to the network (or fail offline) for a file that's already here.
    const revisionDir = path.join(spec.cacheDir, spec.modelId, spec.revision);
    const cached = TEXT_MODEL_FILES.every((f) => existsSync(path.join(revisionDir, f)));
    const source = cached ? revisionDir : spec.modelId;
    const [tokenizer, loaded] = await Promise.all([
      AutoTokenizer.from_pretrained(source, { revision: spec.revision }),
      CLIPTextModelWithProjection.from_pretrained(source, {
        revision: spec.revision,
        // The int8 file installs have always used, on the CPU like the image models.
        device: "cpu",
        dtype: "q8",
        // "all", like the image models: its fused int8 attention lands closest to the
        // full-precision model (0.990 cosine on average, 0.971 worst), where the onnxruntime 1.14
        // vectors of clip-vit-l14-text-v1 averaged 0.887. The level changes the vectors, so
        // changing it needs a new TEXT_MODEL_VERSION and a backfill of species_text_embeddings.
        session_options: { graphOptimizationLevel: "all", intraOpNumThreads: INTRA_OP_THREADS, interOpNumThreads: 1 },
      }),
    ]);
    return { tokenizer, textModel: loaded };
  })();
  const entry = { key, model, timer: null };
  textModel = entry;
  model.catch(() => {
    if (textModel === entry) textModel = null;
  });
  return model;
}

function armTextIdleUnload(): void {
  if (!textModel) return;
  if (textModel.timer) clearTimeout(textModel.timer);
  textModel.timer = setTimeout(releaseText, IDLE_UNLOAD_MS);
  textModel.timer.unref?.();
}

function releaseText(): void {
  const entry = textModel;
  textModel = null;
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.model.then(({ textModel: m }) => m.dispose()).catch(() => {});
}

async function embedTexts(req: Extract<InferenceRequest, { op: "text" }>, hooks: RunHooks): Promise<Float32Array[]> {
  try {
    const { tokenizer, textModel: model } = await getTextModel(req.model, req.allowDownload);
    const out: Float32Array[] = [];
    for (const text of req.texts) {
      const inputs = tokenizer(text, { padding: true, truncation: true });
      hooks.runStarted("text");
      let output: { text_embeds: { data: ArrayLike<number> } };
      try {
        output = await model(inputs);
      } finally {
        hooks.runEnded();
      }
      out.push(l2Normalize(output.text_embeds.data));
    }
    return out;
  } finally {
    armTextIdleUnload();
  }
}

// ---------------------------------------------------------------------------------------------
// Probe: one model on one backend, for the hardware self-test
// ---------------------------------------------------------------------------------------------

/** A fixed input with photo-like variety, the same on every machine. */
function probeInput(dims: number[]): Float32Array {
  const input = new Float32Array(dims.reduce((a, b) => a * b, 1));
  for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 0.37) * 1.5;
  return input;
}

async function probe(req: Extract<InferenceRequest, { op: "probe" }>, hooks: RunHooks): Promise<ProbeResult> {
  // Not cached with the sessions in use, and no CPU fallback: a backend under test may fail or misbehave.
  const session = await createSession(req.modelPath, req.providers, { logSeverityLevel: 3 });
  try {
    const input = probeInput(req.dims);
    let out: Tensor | null = null;
    for (let i = 0; i < 2; i++) out = await run(session, input, req.dims, hooks, "probe");
    const times: number[] = [];
    for (let i = 0; i < req.runs; i++) {
      const start = performance.now();
      out = await run(session, input, req.dims, hooks, "probe");
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
      probe: true,
      ms: times[Math.floor(times.length / 2)],
      vector: l2Normalize(Float32Array.from(out!.data as Float32Array)),
    };
  } finally {
    await session.release().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export async function handleRequest(req: InferenceRequest, hooks: RunHooks): Promise<InferenceResult> {
  switch (req.op) {
    case "analyze":
      return analyze(req, hooks);
    case "text":
      return embedTexts(req, hooks);
    case "probe":
      return probe(req, hooks);
    case "scene":
      return scene(req, hooks);
    case "warm": {
      // Each best effort: a model that isn't downloaded simply isn't warmed.
      for (const m of [...req.models, ...(req.detector ? [req.detector] : [])]) {
        if (!existsSync(m.modelPath)) continue;
        await getSession(m.modelPath, "missing", m.providers).catch(() => {});
        armIdleUnload(m.modelPath, m.providers);
      }
      if (req.text && isTextCachePopulated(req.text.cacheDir)) {
        await getTextModel(req.text, false).catch(() => {});
        armTextIdleUnload();
      }
      return null;
    }
    case "release":
      if (req.modelPath) releaseSession(req.modelPath);
      else {
        for (const key of [...sessions.keys()]) releaseSessionKey(key);
        releaseText();
      }
      return null;
  }
}

/** Buffers to hand over instead of copy when posting a result back. */
export function transferablesOf(result: InferenceResult): ArrayBuffer[] {
  if (!result || "labels" in result) return [];
  const vectors = Array.isArray(result) ? result : "probe" in result ? [result.vector] : result.vectors;
  const out: ArrayBuffer[] = [];
  for (const v of vectors) if (v instanceof Float32Array && v.buffer instanceof ArrayBuffer) out.push(v.buffer);
  return out;
}

// Serve requests only when started by inference.ts, not in a test runner's own worker thread.
export const WORKER_MARKER = "lifer-inference-worker";
if (process.send && process.env.LIFER_INFERENCE_CHILD === WORKER_MARKER) {
  // A separate process, for a GPU runtime that needs its own library path (inference.ts).
  const send = (msg: WorkerMessage) => process.send!(msg);
  process.on("message", async (msg: { id: number; request: InferenceRequest }) => {
    const hooks: RunHooks = {
      runStarted: (label) => send({ type: "run-start", id: msg.id, label }),
      runEnded: () => send({ type: "run-end", id: msg.id }),
    };
    try {
      send({ type: "result", id: msg.id, result: await handleRequest(msg.request, hooks) });
    } catch (err) {
      send({ type: "error", id: msg.id, message: (err as Error)?.message ?? String(err) });
    }
  });
  // Exits with the API: a leftover process would hold the GPU.
  process.on("disconnect", () => process.exit(0));
  send({ type: "ready" });
} else if (parentPort && (workerData as { marker?: string } | null)?.marker === WORKER_MARKER) {
  const port = parentPort;
  port.on("message", async (msg: { id: number; request: InferenceRequest }) => {
    const hooks: RunHooks = {
      runStarted: (label) => port.postMessage({ type: "run-start", id: msg.id, label } satisfies WorkerMessage),
      runEnded: () => port.postMessage({ type: "run-end", id: msg.id } satisfies WorkerMessage),
    };
    try {
      const result = await handleRequest(msg.request, hooks);
      port.postMessage({ type: "result", id: msg.id, result } satisfies WorkerMessage, transferablesOf(result));
    } catch (err) {
      port.postMessage({
        type: "error",
        id: msg.id,
        message: (err as Error)?.message ?? String(err),
      } satisfies WorkerMessage);
    }
  });
  port.postMessage({ type: "ready" } satisfies WorkerMessage);
}
