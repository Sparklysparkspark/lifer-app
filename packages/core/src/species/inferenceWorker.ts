// Every local model (CLIP and identification image encoders, the YOLOv8n animal detector, CLIP's
// text encoder) and its preprocessing, run on a worker thread because onnxruntime blocks the
// calling thread. inference.ts is the main-thread side (queue, priorities, timeouts).
//
// Imports nothing from the rest of the app so the desktop inference sidecar can reuse it as is.
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

// ---------------------------------------------------------------------------------------------
// Protocol shared with inference.ts
// ---------------------------------------------------------------------------------------------

/** Either the file's bytes or a path the worker reads itself (keeps big buffers off the queue). */
export type ImageInput = { bytes: Uint8Array } | { path: string };

/** An encoded photo: its bytes, or a file path sharp opens itself (never read whole into memory). */
type ImageData = Uint8Array | string;

// The same pixel limit uploads use (lib/imageLimits.ts), repeated because this file imports
// nothing from the app.
function imagePixelLimit(): number | false {
  const raw = process.env.LIFER_MAX_IMAGE_PIXELS?.trim().toLowerCase();
  if (raw === "0" || raw === "false") return false;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : 2_000_000_000;
}

function openImage(image: ImageData) {
  return sharp(image, { limitInputPixels: imagePixelLimit() });
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
    }
  | { op: "text"; texts: string[]; model: TextModelSpec; allowDownload: boolean }
  | {
      op: "warm";
      models: Array<{ modelPath: string; providers?: ProviderSpec[] }>;
      detector: { modelPath: string; providers?: ProviderSpec[] } | null;
      text: TextModelSpec | null;
    }
  | { op: "release"; modelPath: string | null }
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
}

export type InferenceResult = AnalyzeResult | Float32Array[] | ProbeResult | null;

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
const ort = () =>
  (ortModule ??= process.env.LIFER_ORT_MODULE
    ? Promise.resolve(createRequire(import.meta.url)(process.env.LIFER_ORT_MODULE) as Ort)
    : import("onnxruntime-node"));

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

async function run(
  session: InferenceSession,
  input: Float32Array,
  dims: number[],
  hooks: RunHooks,
  label: string,
): Promise<Tensor> {
  const { Tensor } = await ort();
  const tensor = new Tensor("float32", input, dims);
  hooks.runStarted(label);
  try {
    const results = await session.run({ [session.inputNames[0]]: tensor });
    return results[session.outputNames[0]];
  } finally {
    hooks.runEnded();
  }
}

// ---------------------------------------------------------------------------------------------
// CLIP-family image encoders
// ---------------------------------------------------------------------------------------------

const CLIP_INPUT_SIZE = 224;
// CLIP's published normalization constants, expected by every CLIP-family encoder.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

/** 224x224 HWC uint8 RGB into normalized NCHW float32. */
function clipTensor(data: Uint8Array): Float32Array {
  const floats = new Float32Array(3 * CLIP_INPUT_SIZE * CLIP_INPUT_SIZE);
  const pixelCount = CLIP_INPUT_SIZE * CLIP_INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[i * 3 + c] / 255;
      floats[c * pixelCount + i] = (value - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }
  return floats;
}

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
// bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe (COCO order)
const ANIMAL_CLASS_INDICES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const PERSON_CLASS_INDEX = 0;
// A 640 px pass shrinks a large photo so much that a small bird vanishes. Overlapping 3x3 tiles
// give it more pixels; tried only when the whole pass isn't confident.
const TILE_GRID = 3;
const TILE_OVERLAP = 0.25;

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

/** Best box in one pass: the top animal-class box over ANIMAL_FLOOR, else the top box of any
 * class over CONF_THRESHOLD, else null. Only one box is ever needed, so no NMS. Coordinates are
 * in the 640 px letterboxed canvas. */
function pickBestDetection(output: Float32Array, numAnchors: number, numClasses: number): Detection | null {
  let bestAnimal: Detection | null = null;
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
    if (isAnimal) {
      if (!bestAnimal || bestClassScore > bestAnimal.score) bestAnimal = detection;
    } else if (!bestAny || bestClassScore > bestAny.score) {
      bestAny = detection;
    }
  }
  return bestAnimal ?? bestAny;
}

/** Animal-class first, then score: the same preference pickBestDetection uses within a pass. */
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
  width: number;
  height: number;
  presence: SubjectPresence;
}

/** One pass over an encoded image (the photo, or one tile of it at `offset`). Returns the best
 * detection mapped into the photo's space, plus the raw output for the presence reading. */
async function detectPass(
  session: InferenceSession,
  bytes: ImageData,
  size: { width: number; height: number },
  offset: Rect | null,
  hooks: RunHooks,
) {
  const { floats, scale, padX, padY } = await letterbox(bytes, size.width, size.height);
  const out = await run(session, floats, [1, 3, DETECT_SIZE, DETECT_SIZE], hooks, "detect");
  const [, numAttrs, numAnchors] = out.dims as [number, number, number];
  const data = out.data as Float32Array;
  const detection = pickBestDetection(data, numAnchors, numAttrs - 4);
  const offsetX = offset?.left ?? 0;
  const offsetY = offset?.top ?? 0;
  const mapped: Detection | null = detection && {
    score: detection.score,
    classIndex: detection.classIndex,
    box: [
      (detection.box[0] - padX) / scale + offsetX,
      (detection.box[1] - padY) / scale + offsetY,
      (detection.box[2] - padX) / scale + offsetX,
      (detection.box[3] - padY) / scale + offsetY,
    ],
  };
  return { detection: mapped, data, numAnchors, numClasses: numAttrs - 4, scale };
}

/** Person and animal scores from the whole-frame pass. The detector knows only ten animal kinds,
 * so the useful signal is a confident person with no animal. */
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
  return { person, personArea, animal };
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

/** The best tile detection, grown to take in the other pieces of the same animal. */
export function mergeTileDetections(found: Detection[]): Detection | null {
  let best: Detection | null = null;
  for (const d of found) if (!best || isBetterDetection(d, best)) best = d;
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
    // Boxes are in the 640 px canvas; the photo itself fills (width * scale) x (height * scale).
    const imageArea = Math.max(1, size.width * whole.scale * size.height * whole.scale);
    const presence = readPresence(whole.data, whole.numAnchors, whole.numClasses, imageArea);
    let detection = whole.detection;
    let fromTiles = false;
    // Also tile after a weak whole-pass guess, since a small subject almost always scores faintly.
    // Whichever result looks better wins.
    if (!detection || detection.score < CONF_THRESHOLD) {
      const tiles = buildTiles(size.width, size.height);
      const tileBytes = await encodeTiles(bytes, tiles);
      const found: Detection[] = [];
      for (let i = 0; i < tiles.length; i++) {
        const { detection: hit } = await detectPass(session, tileBytes[i], tiles[i], tiles[i], hooks);
        if (hit) found.push(hit);
      }
      const tiled = mergeTileDetections(found);
      if (tiled && (!detection || isBetterDetection(tiled, detection))) {
        detection = tiled;
        fromTiles = true;
      }
    }
    const box = detection?.box ?? null;
    const boxShare = box ? ((box[2] - box[0]) * (box[3] - box[1])) / Math.max(1, size.width * size.height) : 0;
    const unsure = !box || fromTiles || boxShare < UNSURE_BOX_SHARE;
    return { box, unsure, width: size.width, height: size.height, presence };
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
  const needsDetection = req.presence || req.cardCrop || !!req.subject || req.targets.some((t) => t.crop);

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
      if (target.crop && cropRect) floats = await (cropFloats ??= cropTensor(bytes, cropRect));
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
  };
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
  if (!result) return [];
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
