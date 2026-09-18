// Crops a photo down to just the animal before it's embedded for species auto-suggest — see
// embeddings.ts's own module comment for why: CLIP's whole-image embedding otherwise blends in
// background/lighting/"photographic genre" signal that has nothing to do with the actual
// subject, which is what let a user's own Red Fox/Bumble Bee photos outrank a genuine Cedar
// Waxwing reference match earlier in this investigation. Measured live against real BC checklist
// data + real test photos: cropping alone took Great Blue Heron's match from 0.777 -> 0.870, and
// took Cedar Waxwing from not even cracking the top 10 to a clean #1 once blended with
// textEmbedding.ts's zero-shot signal (see rankSpeciesByEmbedding's TEXT_BLEND_WEIGHT).
//
// Uses `yolov8n.onnx` (Ultralytics, COCO-trained, ~12MB) — small enough to check into the repo
// directly rather than build a whole opt-in-download flow for it the way the ~307MB CLIP vision
// model needs (see embeddings.ts's downloadModel). Bundled under apps/api/src so it ships with
// both the Docker image (COPY . . in the Dockerfile) and the desktop app (prepare-resources.js
// copies apps/api/src wholesale) with zero extra plumbing.
//
// Deliberately only ever applied to the INCOMING query photo at suggestion time, never to the
// stored reference/gallery images — that's the exact scope validated in the real evaluation
// (re-cropping the reference database was a much bigger, unvalidated change with no measured
// benefit over cropping the query alone).
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as ort from "onnxruntime-node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, "models", "yolov8n.onnx");

const INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.25;
const CROP_PADDING_FRACTION = 0.125;
// Standard COCO class order (index -> name) that ultralytics' YOLOv8 export uses. Only the
// subset relevant to wildlife photography is named here; every other index just isn't in
// ANIMAL_CLASS_INDICES below.
const ANIMAL_CLASS_INDICES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 23]); // bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe

// A single 640x640 pass shrinks a 6000px-wide photo down by ~9x — a bird that's genuinely only
// a few dozen pixels wide (a real, common case: a distant perched or flying bird in a landscape
// frame, not every photo is a full-frame closeup) shrinks to just 2-3 pixels and the detector
// never sees it at all. Confirmed live: two real photos this way scored a 0.15 and a 0.05 "bird"
// confidence, both far under CONF_THRESHOLD, so the whole-image pass silently fell back to
// embedding the untouched (background-dominated) frame — the exact failure this file exists to
// prevent. Splitting into overlapping tiles and re-running detection on each gives a small
// subject a real chance: a tile covering 1/3 of the width at native resolution only needs ~3x
// downscaling to fit 640px, not ~9x, so that same bird arrives at the detector 3x larger.
// Deliberately only a FALLBACK (tried only when the whole-image pass finds nothing) — the common
// case (an obvious, frame-filling subject) is unaffected and still costs exactly one pass.
const TILE_GRID = 3;
const TILE_OVERLAP = 0.25;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_PATH).catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

interface Detection {
  score: number;
  classIndex: number;
  // xyxy, already mapped back into the ORIGINAL image's own full-frame pixel coordinates —
  // every caller of runDetection gets box coordinates in this one consistent space, regardless
  // of whether that particular pass ran on the whole image or on one extracted tile.
  box: [number, number, number, number];
}

/** Letterbox-resizes `buffer` into a 640x640 canvas (aspect ratio preserved, gray-padded — the
 * exact preprocessing ultralytics' own exporter assumes) and returns the tensor data plus the
 * scale/offset needed to map a detected box back out of that canvas. */
async function letterbox(buffer: Buffer): Promise<{ floats: Float32Array; scale: number; padX: number; padY: number; width: number; height: number }> {
  const meta = await sharp(buffer).rotate().metadata();
  const width = meta.width ?? INPUT_SIZE;
  const height = meta.height ?? INPUT_SIZE;
  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  const padX = Math.floor((INPUT_SIZE - newWidth) / 2);
  const padY = Math.floor((INPUT_SIZE - newHeight) / 2);

  const { data } = await sharp(buffer)
    .rotate()
    .resize(newWidth, newHeight, { fit: "fill" })
    .extend({ top: padY, bottom: INPUT_SIZE - newHeight - padY, left: padX, right: INPUT_SIZE - newWidth - padX, background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floats = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  // HWC uint8 [0,255] -> CHW float32 [0,1] — ultralytics' own export normalizes to [0,1] only,
  // no ImageNet/CLIP-style mean/std subtraction.
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) floats[c * pixelCount + i] = data[i * 3 + c] / 255;
  }
  return { floats, scale, padX, padY, width, height };
}

/** Finds the single best detection in one letterboxed pass: the highest-confidence ANIMAL-class
 * box if one clears the confidence threshold, else the highest-confidence box of any class (a
 * generic "something distinct from background" box still beats no cropping at all), else null.
 * Only the single best box is ever needed — unlike a general object detector, this never returns
 * multiple boxes, so no NMS pass is required (argmax over a class subset serves the same purpose
 * more simply). Returned box coordinates are still in the LETTERBOXED 640x640 space — callers
 * undo that themselves, since a tile pass needs an extra offset step a whole-image pass doesn't. */
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
    if (bestClassScore < CONF_THRESHOLD) continue;
    const cx = output[0 * numAnchors + i];
    const cy = output[1 * numAnchors + i];
    const w = output[2 * numAnchors + i];
    const h = output[3 * numAnchors + i];
    const box: [number, number, number, number] = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    const detection: Detection = { score: bestClassScore, classIndex: bestClassIndex, box };
    if (!bestAny || bestClassScore > bestAny.score) bestAny = detection;
    if (ANIMAL_CLASS_INDICES.has(bestClassIndex) && (!bestAnimal || bestClassScore > bestAnimal.score)) bestAnimal = detection;
  }
  return bestAnimal ?? bestAny;
}

/** Runs one full detection pass on `regionBuffer` (either the whole original image, or one
 * extracted tile of it) and maps the result into the ORIGINAL image's full-frame coordinates by
 * adding `offsetX`/`offsetY` (0,0 for a whole-image pass). */
async function runDetection(regionBuffer: Buffer, offsetX: number, offsetY: number): Promise<Detection | null> {
  const { floats, scale, padX, padY } = await letterbox(regionBuffer);
  const session = await getSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor("float32", floats, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await session.run({ [inputName]: tensor });
  const outputTensor = results[outputName];
  const [, numAttrs, numAnchors] = outputTensor.dims as [number, number, number];
  const numClasses = numAttrs - 4;
  const detection = pickBestDetection(outputTensor.data as Float32Array, numAnchors, numClasses);
  if (!detection) return null;

  let [x1, y1, x2, y2] = detection.box;
  // Undo the letterbox (subtract pad, divide by scale) to land in `regionBuffer`'s own pixel
  // space, then add this region's own offset to land in the ORIGINAL full-frame image's space.
  x1 = (x1 - padX) / scale + offsetX;
  y1 = (y1 - padY) / scale + offsetY;
  x2 = (x2 - padX) / scale + offsetX;
  y2 = (y2 - padY) / scale + offsetY;
  return { score: detection.score, classIndex: detection.classIndex, box: [x1, y1, x2, y2] };
}

interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A TILE_GRID x TILE_GRID set of overlapping regions covering the whole image — see this
 * file's own TILE_GRID/TILE_OVERLAP comment for why overlap matters (a subject straddling where
 * two non-overlapping tiles would have met should still land fully inside at least one). */
function buildTiles(width: number, height: number): TileRect[] {
  const stepX = width / TILE_GRID;
  const stepY = height / TILE_GRID;
  const tileWidth = Math.min(width, Math.ceil(stepX * (1 + TILE_OVERLAP)));
  const tileHeight = Math.min(height, Math.ceil(stepY * (1 + TILE_OVERLAP)));
  const tiles: TileRect[] = [];
  for (let row = 0; row < TILE_GRID; row++) {
    for (let col = 0; col < TILE_GRID; col++) {
      const left = Math.min(Math.round(col * stepX), width - tileWidth);
      const top = Math.min(Math.round(row * stepY), height - tileHeight);
      tiles.push({ left: Math.max(0, left), top: Math.max(0, top), width: tileWidth, height: tileHeight });
    }
  }
  return tiles;
}

/** Only called when the whole-image pass found nothing at all — runs detection on each of a
 * TILE_GRID x TILE_GRID overlapping grid of crops (each much closer to native resolution than
 * the whole image was) and returns the single best detection across all of them, already mapped
 * into full-image coordinates, or null if every tile also came up empty. */
async function detectByTiling(buffer: Buffer, width: number, height: number): Promise<Detection | null> {
  const tiles = buildTiles(width, height);
  let best: Detection | null = null;
  for (const tile of tiles) {
    const tileBuffer = await sharp(buffer).rotate().extract(tile).toBuffer();
    const detection = await runDetection(tileBuffer, tile.left, tile.top);
    if (!detection) continue;
    const isBestAnimal = best && ANIMAL_CLASS_INDICES.has(best.classIndex);
    const isThisAnimal = ANIMAL_CLASS_INDICES.has(detection.classIndex);
    // Same animal-class-first preference pickBestDetection uses within one pass, applied again
    // ACROSS tiles — a lower-confidence animal detection in one tile still beats a higher-
    // confidence non-animal detection in another.
    if (!best || (isThisAnimal && !isBestAnimal) || (isThisAnimal === isBestAnimal && detection.score > best.score)) best = detection;
  }
  return best;
}

interface SubjectBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  origWidth: number;
  origHeight: number;
}

/** Shared by cropToSubject and detectDefaultCardCrop below — runs the whole-image pass, falling
 * back to tiled detection, and returns the winning box in original-image pixel space, or null on
 * no detection or any failure. Never throws. */
async function detectSubjectBox(buffer: Buffer): Promise<SubjectBox | null> {
  try {
    const meta = await sharp(buffer).rotate().metadata();
    const origWidth = meta.width ?? INPUT_SIZE;
    const origHeight = meta.height ?? INPUT_SIZE;

    let detection = await runDetection(buffer, 0, 0);
    if (!detection) detection = await detectByTiling(buffer, origWidth, origHeight);
    if (!detection) return null;

    const [x1, y1, x2, y2] = detection.box;
    return { x1, y1, x2, y2, origWidth, origHeight };
  } catch {
    return null;
  }
}

/** Crops `buffer` to the best-detected animal (falling back to tiled detection when the whole
 * image finds nothing at all, then to the whole untouched image if even that fails or errors —
 * this must never throw and never block a suggestion request on a model/inference problem). */
export async function cropToSubject(buffer: Buffer): Promise<Buffer> {
  const box = await detectSubjectBox(buffer);
  if (!box) return buffer;
  try {
    const { x1, y1, x2, y2, origWidth, origHeight } = box;
    const boxWidth = x2 - x1;
    const boxHeight = y2 - y1;
    const padX = boxWidth * CROP_PADDING_FRACTION;
    const padY = boxHeight * CROP_PADDING_FRACTION;
    const left = Math.max(0, Math.floor(x1 - padX));
    const top = Math.max(0, Math.floor(y1 - padY));
    const right = Math.min(origWidth, Math.ceil(x2 + padX));
    const bottom = Math.min(origHeight, Math.ceil(y2 + padY));
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth < 10 || cropHeight < 10) return buffer; // degenerate box — not worth cropping to

    return await sharp(buffer).rotate().extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer();
  } catch {
    // Best-effort, same reasoning as every other embedding-adjacent step in this feature —
    // detection failing just means matching proceeds against the whole image, same as today.
    return buffer;
  }
}

// A card crop is a comfortable framing shown at a glance, not a tight subject-only crop meant to
// strip background noise before embedding — hence more breathing room than CROP_PADDING_FRACTION.
const CARD_CROP_PADDING_FRACTION = 0.3;

/** Detects the subject and returns a default square card-crop — x, y, size as percentages of the
 * photo's OWN WIDTH, matching CardCropEditor's save format and cropToImageStyle's render format
 * (see migration 006) — centered on it, in place of the dead-center square SpeciesCard/
 * cropToImageStyle falls back to today when no crop has been saved. Returns null on no detection
 * or any failure; callers should fall back to leaving the crop columns unset in that case, same
 * as today, never block on this. */
export async function detectDefaultCardCrop(buffer: Buffer): Promise<{ x: number; y: number; size: number } | null> {
  const box = await detectSubjectBox(buffer);
  if (!box) return null;
  try {
    const { x1, y1, x2, y2, origWidth, origHeight } = box;
    const boxWidth = x2 - x1;
    const boxHeight = y2 - y1;
    const centerX = x1 + boxWidth / 2;
    const centerY = y1 + boxHeight / 2;
    // The crop is a square in pixel space (the card container is aspect-square), so its side
    // can never exceed the shorter of the photo's two dimensions.
    const maxSquare = Math.min(origWidth, origHeight);
    const sizePx = Math.min(Math.max(boxWidth, boxHeight) * (1 + CARD_CROP_PADDING_FRACTION), maxSquare);
    const left = Math.min(Math.max(centerX - sizePx / 2, 0), origWidth - sizePx);
    const top = Math.min(Math.max(centerY - sizePx / 2, 0), origHeight - sizePx);
    return { x: (left / origWidth) * 100, y: (top / origWidth) * 100, size: (sizePx / origWidth) * 100 };
  } catch {
    return null;
  }
}
