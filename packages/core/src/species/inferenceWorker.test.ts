import { MIN_CARD_CROP_PERCENT as SHARED_MIN } from "@lifer/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BASIC_DETECTOR_MODEL_PATH } from "./inference.js";
import {
  cardCropFor,
  countAnimals,
  handleRequest,
  laplacianVariance,
  lightStats,
  pickSubject,
  type AnalyzeResult,
  mergeTileDetections,
  MIN_CARD_CROP_PERCENT,
  readAnimalDetector,
  subjectCropRect,
} from "./inferenceWorker.js";

const outcome = (box: [number, number, number, number], width = 6000, height = 4000) =>
  ({ box, width, height, presence: {} }) as Parameters<typeof cardCropFor>[0];

describe("cardCropFor", () => {
  it("matches the shared minimum", () => {
    expect(MIN_CARD_CROP_PERCENT).toBe(SHARED_MIN);
  });

  it("never frames tighter than the minimum, centred on a tiny subject", () => {
    const crop = cardCropFor(outcome([3000, 2000, 3060, 2040]))!;
    expect(crop.size).toBeCloseTo(MIN_CARD_CROP_PERCENT);
    const centre = ((crop.x + crop.size / 2) / 100) * 6000;
    expect(centre).toBeCloseTo(3030);
  });

  it("pads a larger subject and stays inside the photo", () => {
    const crop = cardCropFor(outcome([5000, 3000, 5900, 3900]))!;
    expect(crop.size).toBeCloseTo((Math.min(900 * 1.3, 4000) / 6000) * 100);
    expect(crop.x + crop.size).toBeLessThanOrEqual(100 + 1e-9);
  });
});

describe("mergeTileDetections", () => {
  // Tile detections of a bird partly hidden by leaves, in pieces.
  const bird = 14;
  const flicker = [
    { score: 0.064, classIndex: bird, box: [2272, 1372, 3082, 2091] as [number, number, number, number] }, // leaves
    { score: 0.327, classIndex: bird, box: [3638, 1602, 4673, 2260] as [number, number, number, number] }, // head
    { score: 0.048, classIndex: bird, box: [2289, 2796, 2768, 3152] as [number, number, number, number] }, // leaves
    { score: 0.402, classIndex: bird, box: [4303, 2799, 4830, 3498] as [number, number, number, number] }, // belly
    { score: 0.186, classIndex: bird, box: [4783, 2946, 5221, 3475] as [number, number, number, number] },
  ];

  it("joins the pieces of one animal and leaves faint guesses out", () => {
    const merged = mergeTileDetections(flicker)!;
    expect(merged.box).toEqual([3638, 1602, 5221, 3498]);
    expect(merged.score).toBe(0.402);
  });

  it("keeps a distant animal out, and a different kind of animal", () => {
    const far = { score: 0.3, classIndex: bird, box: [100, 100, 400, 400] as [number, number, number, number] };
    const dog = { score: 0.3, classIndex: 16, box: [4000, 3500, 4600, 4000] as [number, number, number, number] };
    expect(mergeTileDetections([flicker[3], far, dog])!.box).toEqual(flicker[3].box);
  });
});

describe("pickSubject", () => {
  const bird = 14;
  const size = { width: 1620, height: 1080 };
  const box = (x1: number, y1: number, x2: number, y2: number) =>
    [x1 * 1620, y1 * 1080, x2 * 1620, y2 * 1080] as [number, number, number, number];

  it("prefers a sharp bird to a slightly higher-scoring out-of-focus one behind it", () => {
    const blurred = { score: 0.575, classIndex: bird, box: box(0.367, 0.375, 0.449, 0.432) };
    const sharp = { score: 0.566, classIndex: bird, box: box(0.421, 0.591, 0.535, 0.749) };
    const picked = pickSubject([blurred, sharp], [40, 900], size)!;
    expect(picked.subject).toBe(sharp);
    expect(picked.confidence).toBeGreaterThan(0.5);
  });

  it("prefers a central bird to a stronger guess cut off by the frame edge", () => {
    const log = { score: 0.277, classIndex: bird, box: box(0, 0.588, 0.159, 0.75) };
    const grebe = { score: 0.112, classIndex: bird, box: box(0.462, 0.439, 0.572, 0.519) };
    expect(pickSubject([log, grebe], [500, 500], size)!.subject).toBe(grebe);
  });

  it("has no framing confidence for a box that isn't an animal, or for two equal animals", () => {
    expect(pickSubject([{ score: 0.6, classIndex: 33, box: box(0.4, 0.4, 0.5, 0.5) }], [], size)!.confidence).toBe(0);
    const left = { score: 0.3, classIndex: bird, box: box(0.3, 0.4, 0.4, 0.5) };
    const right = { score: 0.3, classIndex: bird, box: box(0.6, 0.4, 0.7, 0.5) };
    expect(pickSubject([left, right], [500, 500], size)!.confidence).toBeLessThan(0.15);
  });
});

describe("laplacianVariance", () => {
  it("reads detail as high and a flat patch as zero", () => {
    const width = 20;
    const checker = Uint8Array.from({ length: 400 }, (_, i) => (((i % width) + Math.floor(i / width)) % 2 ? 255 : 0));
    expect(laplacianVariance(checker, width, 20, [0, 0, 20, 20])).toBeGreaterThan(1000);
    expect(laplacianVariance(new Uint8Array(400).fill(90), width, 20, [0, 0, 20, 20])).toBe(0);
  });
});

describe("subjectCropRect", () => {
  it("makes a tall subject's crop square around all of it, inside the photo", () => {
    // A standing heron near the right edge: 400 wide, 1600 tall.
    const rect = subjectCropRect(outcome([5500, 1000, 5900, 2600]))!;
    expect(rect.width).toBe(rect.height);
    expect(rect.left).toBeLessThanOrEqual(5500);
    expect(rect.top).toBeLessThanOrEqual(1000);
    expect(rect.left + rect.width).toBeGreaterThanOrEqual(5900);
    expect(rect.top + rect.height).toBeGreaterThanOrEqual(2600);
    expect(rect.left + rect.width).toBeLessThanOrEqual(6000);
  });

  it("caps the square at the photo's shorter side", () => {
    const rect = subjectCropRect(outcome([0, 0, 6000, 4000]))!;
    expect(rect.width).toBe(4000);
    expect(rect.height).toBe(4000);
  });
});

describe("countAnimals", () => {
  // YOLO's layout: 4 box rows then one row per class, each numAnchors long.
  const numClasses = 80;
  function output(anchors: Array<{ box: [number, number, number, number]; cls: number; score: number }>) {
    const n = anchors.length;
    const data = new Float32Array((4 + numClasses) * n);
    anchors.forEach(({ box, cls, score }, i) => {
      box.forEach((v, row) => (data[row * n + i] = v));
      data[(4 + cls) * n + i] = score;
    });
    return { data, n };
  }

  it("counts separate animals of any class once each, and skips people and faint boxes", () => {
    const { data, n } = output([
      { box: [100, 100, 50, 50], cls: 14, score: 0.9 }, // bird
      { box: [102, 101, 50, 50], cls: 19, score: 0.6 }, // same animal, named cow
      { box: [300, 300, 60, 60], cls: 17, score: 0.5 }, // horse elsewhere
      { box: [500, 500, 60, 60], cls: 0, score: 0.9 }, // person
      { box: [400, 100, 40, 40], cls: 14, score: 0.1 }, // too faint
    ]);
    expect(countAnimals(data, n, numClasses)).toBe(2);
  });
});

describe("readAnimalDetector", () => {
  const logit = (p: number) => Math.log(p / (1 - p));
  // Queries: a sharp animal, the same animal again (a duplicate query), a faint animal elsewhere,
  // a person, and an empty query. Classes: animal, person, vehicle.
  const logits = Float32Array.from(
    [
      [0.9, 0.01, 0.01],
      [0.6, 0.01, 0.01],
      [0.3, 0.01, 0.01],
      [0.01, 0.8, 0.01],
      [0.001, 0.001, 0.001],
    ].flatMap((q) => q.map(logit)),
  );
  const boxes = Float32Array.from([
    [0.5, 0.5, 0.2, 0.4],
    [0.51, 0.5, 0.2, 0.4],
    [0.1, 0.1, 0.1, 0.1],
    [0.8, 0.5, 0.2, 0.5],
    [0.5, 0.5, 1, 1],
  ].flat());

  it("maps boxes into the photo, best animal first, and drops duplicates of it", () => {
    const { detections } = readAnimalDetector(logits, boxes, { width: 1000, height: 500 });
    expect(detections[0].score).toBeCloseTo(0.9);
    expect(detections[0].box.map(Math.round)).toEqual([400, 150, 600, 350]);
    // The duplicate overlaps the best box; the faint one scores under the rival ratio of 0.4.
    expect(detections).toHaveLength(1);
  });

  it("reads presence for any animal, the person and its share of the frame, and the count", () => {
    const { presence } = readAnimalDetector(logits, boxes, { width: 1000, height: 500 });
    expect(presence.animal).toBeCloseTo(0.9);
    expect(presence.person).toBeCloseTo(0.8);
    expect(presence.personArea).toBeCloseTo(0.1);
    // The two overlapping boxes are one animal; the faint one is over the count threshold too.
    expect(presence.count).toBe(2);
  });

  it("falls back to the best other box when nothing is an animal", () => {
    const noAnimal = Float32Array.from(logits.map((v, i) => (i % 3 === 0 ? logit(0.001) : v)));
    const { detections, presence } = readAnimalDetector(noAnimal, boxes, { width: 100, height: 100 });
    expect(presence.animal).toBeLessThan(0.01);
    expect(presence.count).toBe(0);
    expect(detections).toHaveLength(1);
    expect(detections[0].classIndex).toBe(0); // the person
  });
});

describe("lightStats", () => {
  const pixels = (...rgb: number[][]) => Uint8Array.from(rgb.flat());

  it("reads brightness, cast, highlights, shadows and colourfulness", () => {
    const s = lightStats(pixels([255, 255, 255], [0, 0, 0], [200, 100, 0], [0, 0, 200]));
    expect(s.highlights).toBe(0.25);
    expect(s.shadows).toBe(0.5);
    // One warm pixel and one blue one cancel out.
    expect(s.warmth).toBe(0);
    expect(s.saturation).toBe(0.5);
    expect(s.luma).toBeCloseTo((1 + 0 + (0.2126 * 200 + 0.7152 * 100) / 255 + (0.0722 * 200) / 255) / 4, 2);
  });
});

describe("analyze with frame", () => {
  it("reads a photo's light and finds no animal in a plain frame", async () => {
    const bytes = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 60, b: 120 } },
    })
      .jpeg()
      .toBuffer();
    const hooks = { runStarted: () => {}, runEnded: () => {} };
    const result = (await handleRequest(
      {
        op: "analyze",
        image: { bytes },
        key: null,
        targets: [{ modelPath: "/nowhere/clip.onnx", missingMessage: "missing", crop: false, maskSubject: true }],
        detectorPath: BASIC_DETECTOR_MODEL_PATH,
        presence: false,
        cardCrop: false,
        frame: true,
      },
      hooks,
    )) as AnalyzeResult;
    expect(result.frame).toMatchObject({ box: null, unsure: true, aspect: 1.5 });
    expect(result.frame!.light.warmth).toBeLessThan(0);
    expect(result.frame!.light.luma).toBeLessThan(0.3);
    // No animal, so no background to read.
    expect(result.vectors[0]).toEqual({ error: "No background to read" });
  }, 60_000);
});
