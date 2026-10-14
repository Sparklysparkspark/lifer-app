// What the scene model's per-pixel output and the photo's own pixels add up to: the share of the
// frame each ADE20K class and each named colour covers. Config-free, so the inference worker can
// import it.

/** ADE20K's 150 classes in the model's output order, each by the first of its names. */
export const SCENE_LABELS = [
  "wall",
  "building",
  "sky",
  "floor",
  "tree",
  "ceiling",
  "road",
  "bed",
  "windowpane",
  "grass",
  "cabinet",
  "sidewalk",
  "person",
  "earth",
  "door",
  "table",
  "mountain",
  "plant",
  "curtain",
  "chair",
  "car",
  "water",
  "painting",
  "sofa",
  "shelf",
  "house",
  "sea",
  "mirror",
  "rug",
  "field",
  "armchair",
  "seat",
  "fence",
  "desk",
  "rock",
  "wardrobe",
  "lamp",
  "bathtub",
  "railing",
  "cushion",
  "base",
  "box",
  "column",
  "signboard",
  "chest of drawers",
  "counter",
  "sand",
  "sink",
  "skyscraper",
  "fireplace",
  "refrigerator",
  "grandstand",
  "path",
  "stairs",
  "runway",
  "case",
  "pool table",
  "pillow",
  "screen door",
  "stairway",
  "river",
  "bridge",
  "bookcase",
  "blind",
  "coffee table",
  "toilet",
  "flower",
  "book",
  "hill",
  "bench",
  "countertop",
  "stove",
  "palm",
  "kitchen island",
  "computer",
  "swivel chair",
  "boat",
  "bar",
  "arcade machine",
  "hovel",
  "bus",
  "towel",
  "light",
  "truck",
  "tower",
  "chandelier",
  "awning",
  "streetlight",
  "booth",
  "television receiver",
  "airplane",
  "dirt track",
  "apparel",
  "pole",
  "land",
  "bannister",
  "escalator",
  "ottoman",
  "bottle",
  "buffet",
  "poster",
  "stage",
  "van",
  "ship",
  "fountain",
  "conveyer belt",
  "canopy",
  "washer",
  "plaything",
  "swimming pool",
  "stool",
  "barrel",
  "basket",
  "waterfall",
  "tent",
  "bag",
  "minibike",
  "cradle",
  "oven",
  "ball",
  "food",
  "step",
  "tank",
  "trade name",
  "microwave",
  "pot",
  "animal",
  "bicycle",
  "lake",
  "dishwasher",
  "screen",
  "blanket",
  "sculpture",
  "hood",
  "sconce",
  "vase",
  "traffic light",
  "tray",
  "ashcan",
  "fan",
  "pier",
  "crt screen",
  "plate",
  "monitor",
  "bulletin board",
  "shower",
  "radiator",
  "glass",
  "clock",
  "flag",
] as const;

export const SCENE_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
  "white",
  "black",
  "gray",
] as const;
export type SceneColor = (typeof SCENE_COLORS)[number];

/** Share of the frame, in percent, per name. */
export type SceneShares = Record<string, number>;

// Smaller shares are noise at 512x512.
const MIN_PERCENT = 1;

/** The colour names one RGB pixel counts towards (usually one; dark plum reds count as both red
 *  and purple, since that's what people call them). */
export function pixelColors(r: number, g: number, b: number): readonly SceneColor[] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.15) return BLACK;
  if (s < 0.15) return v > 0.85 ? WHITE : GRAY;
  const d = max - min;
  let h = max === r ? ((g - b) / d) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  if (h < 0) h += 360;
  if (h >= 345 || h < 15) return v < 0.55 && s > 0.3 ? RED_PURPLE : RED;
  if (h < 40) return v < 0.6 ? BROWN : ORANGE;
  if (h < 70) return YELLOW;
  if (h < 170) return GREEN;
  if (h < 255) return BLUE;
  if (h < 300) return PURPLE;
  return v < 0.6 ? PURPLE : PINK;
}

const BLACK = ["black"] as const;
const WHITE = ["white"] as const;
const GRAY = ["gray"] as const;
const RED = ["red"] as const;
const RED_PURPLE = ["red", "purple"] as const;
const BROWN = ["brown"] as const;
const ORANGE = ["orange"] as const;
const YELLOW = ["yellow"] as const;
const GREEN = ["green"] as const;
const BLUE = ["blue"] as const;
const PURPLE = ["purple"] as const;
const PINK = ["pink"] as const;

function shares(counts: Map<string, number>, total: number): SceneShares {
  const out: SceneShares = {};
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const percent = Math.round((1000 * n) / total) / 10;
    if (percent >= MIN_PERCENT) out[name] = percent;
  }
  return out;
}

/** The share of each scene class (from the model's per-pixel class indices) and each colour
 *  (from the same frame's interleaved RGB pixels). */
export function summarizeScene(classes: Uint8Array, rgb: Uint8Array): { labels: SceneShares; colors: SceneShares } {
  const labelCounts = new Map<string, number>();
  for (const c of classes) {
    const name = SCENE_LABELS[c];
    if (name) labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
  }
  const colorCounts = new Map<string, number>();
  const pixels = rgb.length / 3;
  for (let i = 0; i < pixels; i++)
    for (const name of pixelColors(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]))
      colorCounts.set(name, (colorCounts.get(name) ?? 0) + 1);
  return { labels: shares(labelCounts, classes.length), colors: shares(colorCounts, pixels) };
}
