// The words photo search understands (fillers, dates, picture and scene words) and the shape of
// a parsed query, shared by the parser (photoSearch.ts) and the ranking (searchRank.ts).
import type { GroupPredicate } from "./searchTaxonSynonyms.js";
import type { ShotAction, ShotFraming } from "./shotTypes.js";

export type TimeOfDay =
  | "goldenHour"
  | "blueHour"
  | "twilight"
  | "sunrise"
  | "sunset"
  | "night"
  | "morning"
  | "midday"
  | "afternoon"
  | "evening";
/** Where the animal sits in the frame and the photo's shape, read from the subject box (photoFrame.ts). */
export type CompositionReading =
  "ruleOfThirds" | "goldenRatio" | "centred" | "smallInFrame" | "frameFilling" | "vertical" | "horizontal";

export const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "with",
  "and",
  "or",
  "my",
  "to",
  "is",
  "are",
  "some",
  "from",
  "near",
  "around",
  "during",
  "by",
  "photo",
  "photos",
  "picture",
  "pictures",
  "shot",
  "shots",
]);
// Words about the photo itself, never what's in it, so they stay out of the description.
export const FILLER_WORDS = new Set(["my", "shot", "shots", "photo", "photos", "picture", "pictures"]);
// How many animals, never a species ("three", not Three-toed Woodpecker).
export const COUNT_WORDS = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "pair",
  "trio",
  "group",
  "flock",
  "herd",
  "pack",
  "several",
  "many",
  "single",
  "lone",
  "solitary",
  "couple",
  "few",
  "dozen",
  "dozens",
  "hundred",
  "hundreds",
  "thousand",
  "thousands",
  "pod",
  "colony",
  "swarm",
  "eleven",
  "twelve",
  "fifteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
]);

export const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  dozen: 12,
};
// "two hundred", "a thousand".
export const NUMBER_MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000 };
// Words that say how many without a number: [min, max] (null max: no upper bound), and whether
// it's a crowd too big or distant for the detector to count.
export const QUANTITY_WORDS: Record<string, { min: number; max: number | null; crowd?: boolean }> = {
  single: { min: 1, max: 1 },
  lone: { min: 1, max: 1 },
  solitary: { min: 1, max: 1 },
  pair: { min: 2, max: 2 },
  couple: { min: 2, max: 2 },
  trio: { min: 3, max: 3 },
  few: { min: 2, max: 5 },
  several: { min: 3, max: 8 },
  many: { min: 5, max: null },
  dozens: { min: 20, max: null, crowd: true },
  hundreds: { min: 30, max: null, crowd: true },
  thousands: { min: 30, max: null, crowd: true },
};
// Words for a group of animals: at least this many.
export const GROUP_COUNT_WORDS: Record<string, number> = {
  group: 2,
  pack: 2,
  pod: 2,
  colony: 2,
  swarm: 2,
  flock: 3,
  herd: 3,
};
// "huge flock": a crowd, before a group word.
export const CROWD_ADJECTIVES = new Set(["huge", "massive", "enormous", "vast", "giant", "large", "big"]);

/** How many animals a query asks for. */
export interface CountFilter {
  min: number;
  /** Null: no upper bound. */
  max: number | null;
  /** The rough number asked for ("about 50"), or null. */
  about: number | null;
  /** Too many or too distant to count: a CLIP match to `prompt` counts too. */
  crowd: boolean;
  /** What CLIP looks for, for crowds and photos not counted yet. */
  prompt: string;
}

/** The count range a number asks for: exact up to ten, then a band that widens with it. */
export function countForNumber(n: number): Pick<CountFilter, "min" | "max" | "about" | "crowd"> {
  if (n <= 10) return { min: n, max: n, about: null, crowd: false };
  // The detector misses small distant animals in a big group, so a large number is mostly a crowd.
  if (n >= 100) return { min: 30, max: null, about: n, crowd: true };
  return { min: Math.round(n * 0.7), max: Math.round(n * 1.4), about: n, crowd: n >= 25 };
}

// Collective nouns ("murder of crows"): each with the animals it belongs to (head words, singular).
// `alone` is what the word means on its own when it's only a collective ("gaggle" is geese);
// `everyday` words keep their ordinary meaning on their own or with another animal, read by CLIP
// (with `prompt` in place of the word when the word alone would mislead it). `group` widens the
// animal typed to its whole group ("murder of crows" is any corvid).
export const COLLECTIVES: Record<
  string,
  { animals: string[]; alone?: string; everyday?: boolean; prompt?: string; group?: string }
> = {
  murder: {
    animals: ["crow", "raven"],
    group: "corvids",
    everyday: true,
    prompt: "an animal hunting, killing or eating its prey",
  },
  unkindness: { animals: ["raven"], alone: "ravens" },
  conspiracy: { animals: ["lemur", "raven"], everyday: true },
  parliament: { animals: ["owl"], everyday: true },
  gaggle: { animals: ["goose"], alone: "geese" },
  skein: { animals: ["goose"], alone: "geese" },
  raft: { animals: ["duck", "otter"], everyday: true },
  paddling: { animals: ["duck"], alone: "ducks" },
  pride: { animals: ["lion"], everyday: true },
  murmuration: { animals: ["starling"], alone: "starlings" },
  business: { animals: ["ferret"], everyday: true },
  bloat: { animals: ["hippopotamus", "hippo"], alone: "hippopotamuses" },
  tower: { animals: ["giraffe"], everyday: true },
  crash: { animals: ["rhinoceros", "rhino"], everyday: true },
  dazzle: { animals: ["zebra"], alone: "zebras" },
  convocation: { animals: ["eagle"], alone: "eagles" },
  charm: { animals: ["finch", "goldfinch", "hummingbird"], everyday: true },
  exaltation: { animals: ["lark"], alone: "larks" },
  kettle: { animals: ["hawk", "vulture"], everyday: true },
  siege: { animals: ["heron"], alone: "herons" },
  flamboyance: { animals: ["flamingo"], alone: "flamingos" },
  romp: { animals: ["otter"], alone: "otters" },
  waddle: { animals: ["penguin"], alone: "penguins" },
  bevy: { animals: ["quail"], alone: "quails" },
  covey: { animals: ["quail", "partridge", "grouse"], alone: "quails" },
  troop: { animals: ["baboon", "monkey"], alone: "monkeys" },
  wake: { animals: ["vulture"], everyday: true },
  committee: { animals: ["vulture"], everyday: true },
  sleuth: { animals: ["bear"], alone: "bears" },
  cete: { animals: ["badger"], alone: "badgers" },
  prickle: { animals: ["porcupine"], alone: "porcupines" },
  bask: { animals: ["crocodile"], alone: "crocodiles" },
  cackle: { animals: ["hyena"], alone: "hyenas" },
  clowder: { animals: ["cat"], alone: "cats" },
  ambush: { animals: ["tiger"], everyday: true },
  leap: { animals: ["leopard"], everyday: true },
  mob: { animals: ["kangaroo", "meerkat"], everyday: true },
  parade: { animals: ["elephant"], everyday: true },
  dule: { animals: ["dove"], alone: "doves" },
};
// The collective's own name for animals people shorten.
export const COLLECTIVE_ANIMAL_NAMES: Record<string, string> = { hippo: "hippopotamus", rhino: "rhinoceros" };
// "my best eagle shot": highest rated first.
export const BEST_WORDS = new Set(["best", "top", "favourite", "favorite", "favourites", "favorites", "finest"]);

/** Readings a query word can ask for besides a subject: a filter, an order or a time of day. */
export type Reading =
  | "lifers"
  | Tier
  | "rarestFirst"
  | "endemic"
  | "unrated"
  | "videos"
  | "raw"
  | "hidden"
  | "edited"
  | "noLocation"
  | "noDate"
  | "newestFirst"
  | "oldestFirst"
  | ShotAction
  | ShotFraming
  | TimeOfDay
  | CompositionReading;

// Phrases for each reading, matched longest first.
export const READING_PHRASES: Record<string, Reading> = {
  lifer: "lifers",
  lifers: "lifers",
  first: "lifers",
  firsts: "lifers",
  "new species": "lifers",
  common: "common",
  occasional: "occasional",
  uncommon: "uncommon",
  rare: "rare",
  rarities: "rare",
  legendary: "legendary",
  rarest: "rarestFirst",
  endemic: "endemic",
  endemics: "endemic",
  unrated: "unrated",
  "not rated": "unrated",
  "no rating": "unrated",
  "no stars": "unrated",
  video: "videos",
  videos: "videos",
  raw: "raw",
  raws: "raw",
  hidden: "hidden",
  edited: "edited",
  edits: "edited",
  "no location": "noLocation",
  "no region": "noLocation",
  "no place": "noLocation",
  "missing location": "noLocation",
  "without location": "noLocation",
  "no date": "noDate",
  "no dates": "noDate",
  "missing date": "noDate",
  undated: "noDate",
  latest: "newestFirst",
  newest: "newestFirst",
  last: "newestFirst",
  "most recent": "newestFirst",
  oldest: "oldestFirst",
  earliest: "oldestFirst",
  // Shot type, read the way Stats' Photography DNA reads it (the Gallery's action and framing filters).
  // "flying" stays a picture word: it also hints species like Northern Flying Squirrel.
  flight: "flying",
  flights: "flying",
  behaviour: "behavior",
  behavior: "behavior",
  behaviours: "behavior",
  behaviors: "behavior",
  "at rest": "resting",
  portrait: "close",
  portraits: "close",
  "close up": "close",
  "close ups": "close",
  closeup: "close",
  closeups: "close",
  environmental: "environmental",
  "habitat shot": "environmental",
  "golden hour": "goldenHour",
  "blue hour": "blueHour",
  twilight: "twilight",
  "civil twilight": "twilight",
  // Composition, from the subject box. "negative space" stays a style: it's about the look.
  "rule of thirds": "ruleOfThirds",
  thirds: "ruleOfThirds",
  "golden ratio": "goldenRatio",
  "golden mean": "goldenRatio",
  "golden section": "goldenRatio",
  "phi grid": "goldenRatio",
  centred: "centred",
  centered: "centred",
  "dead centre": "centred",
  "dead center": "centred",
  "small in frame": "smallInFrame",
  "small in the frame": "smallInFrame",
  "tiny in frame": "smallInFrame",
  "tiny in the frame": "smallInFrame",
  "lots of space": "smallInFrame",
  "lots of room": "smallInFrame",
  "room to breathe": "smallInFrame",
  "frame filling": "frameFilling",
  "fills the frame": "frameFilling",
  "filling the frame": "frameFilling",
  "fill the frame": "frameFilling",
  "tight crop": "frameFilling",
  vertical: "vertical",
  "portrait orientation": "vertical",
  "portrait format": "vertical",
  horizontal: "horizontal",
  "landscape orientation": "horizontal",
  "landscape format": "horizontal",
  sunrise: "sunrise",
  sunset: "sunset",
  night: "night",
  nighttime: "night",
  morning: "morning",
  midday: "midday",
  noon: "midday",
  afternoon: "afternoon",
  evening: "evening",
};
export const MAX_READING_WORDS = 4;
// Rarity words are the app's own tier names, each meaning just that tier.
export const TIERS = ["legendary", "rare", "uncommon", "occasional", "common"] as const;
export type Tier = (typeof TIERS)[number];
// "rarest": highest tier first.
export const TIER_RANK: Record<string, number> = { legendary: 5, rare: 4, uncommon: 3, occasional: 2, common: 1 };

// The next subject or picture word is left out ("ducks not mallards", "birds without people").
export const NEGATION_WORDS = new Set(["not", "without", "except", "excluding", "minus", "no"]);

// Photo styles, each with what CLIP is asked for in place of the words typed.
export const STYLE_PROMPTS: Record<string, string> = {
  "black and white": "a black-and-white monochrome photograph",
  bw: "a black-and-white monochrome photograph",
  monochrome: "a black-and-white monochrome photograph",
  minimalist: "a minimalist photograph with lots of empty negative space",
  minimal: "a minimalist photograph with lots of empty negative space",
  "negative space": "a minimalist photograph with lots of empty negative space",
  "clean background": "an animal against a clean, plain, uncluttered background",
  "high key": "a high-key photograph, bright and mostly white",
  "low key": "a low-key photograph, dark and moody with a black background",
  moody: "a low-key photograph, dark and moody with a black background",
  dark: "a low-key photograph, dark and moody with a black background",
  backlit: "a backlit animal glowing with rim light",
  backlighting: "a backlit animal glowing with rim light",
  "rim light": "a backlit animal glowing with rim light",
  "rim lit": "a backlit animal glowing with rim light",
  "golden light": "an animal in warm golden light",
  "warm light": "an animal in warm golden light",
  overcast: "an animal in soft overcast light",
  "soft light": "an animal in soft overcast light",
  "harsh light": "an animal in harsh midday light",
  "eye contact": "an animal looking straight at the camera",
  "making eye contact": "an animal looking straight at the camera",
  "eye contact with the camera": "an animal looking straight at the camera",
  "making eye contact with the camera": "an animal looking straight at the camera",
  "looking at the camera": "an animal looking straight at the camera",
  "looking at camera": "an animal looking straight at the camera",
  "staring at the camera": "an animal looking straight at the camera",
  bokeh: "an animal against a smooth, blurred bokeh background",
  "blurred background": "an animal against a smooth, blurred bokeh background",
  "blurry background": "an animal against a smooth, blurred bokeh background",
  "motion blur": "a panning photograph with motion blur",
  panning: "a panning photograph with motion blur",
  sharp: "a sharp, crisp, in-focus photograph",
  "in focus": "a sharp, crisp, in-focus photograph",
  blurry: "a blurry, out-of-focus photograph",
  "out of focus": "a blurry, out-of-focus photograph",
};
export const MAX_STYLE_WORDS = 6;
export const PLACE_PREPOSITIONS = new Set(["in", "at", "near", "from", "around", "on"]);
export const DATE_PREPOSITIONS = new Set(["in", "during", "from", "on"]);

export const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
export const SEASONS: Record<string, number[]> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  fall: [9, 10, 11],
  autumn: [9, 10, 11],
  winter: [12, 1, 2],
};

// Common words for what's in a picture, so a word still being typed describes the picture it's
// heading for: "fly" means "flying" (not the insect), "swim" means "swimming", "sno" means "snow".
export const PICTURE_WORDS = [
  "flying",
  "flight",
  "swimming",
  "diving",
  "feeding",
  "eating",
  "drinking",
  "hunting",
  "fishing",
  "foraging",
  "perched",
  "perching",
  "nesting",
  "landing",
  "running",
  "walking",
  "jumping",
  "sleeping",
  "resting",
  "sitting",
  "standing",
  "singing",
  "calling",
  "preening",
  "bathing",
  "grooming",
  "fighting",
  "mating",
  "stretching",
  "snow",
  "water",
  "sunset",
  "sunrise",
  "silhouette",
  "reflection",
  "underwater",
  "grass",
  "branch",
  "flowers",
  "fence",
  "sky",
  "fog",
  "mist",
  "rain",
  "night",
  "dusk",
  "dawn",
  "juvenile",
  "baby",
  "flock",
  "group",
  "portrait",
  "closeup",
];

/** The picture word a partial word is heading for, or null ("fly" -> "flying"). */
export function completePictureWord(word: string): string | null {
  if (word.length < 3 || PICTURE_WORDS.includes(word)) return null;
  return PICTURE_WORDS.find((w) => w.startsWith(word)) ?? null;
}

// Scene words, read from the scene model's per-photo label shares (ADE20K classes) rather than
// CLIP, which misses what fills only part of a photo (a pond behind a moose). Man-made labels
// (person, building, car, road, wall) are left out: they misfire on blurry backgrounds.
const SCENE_WORDS: Array<[string[], string[]]> = [
  [
    ["water", "pond", "lake", "river", "stream", "creek", "marsh", "wetland"],
    // Not "waterfall": the scene model reads fog and mist as one, and a real waterfall shows water too.
    ["water", "river", "lake", "sea"],
  ],
  [
    ["sea", "ocean"],
    ["sea", "water"],
  ],
  [["waterfall"], ["waterfall"]],
  [["sky"], ["sky"]],
  [
    ["grass", "meadow", "field", "lawn"],
    ["grass", "field"],
  ],
  [["tree", "forest", "woods"], ["tree"]],
  [
    ["leaves", "leaf", "foliage"],
    ["tree", "plant"],
  ],
  [["plant", "bush", "shrub", "vegetation"], ["plant"]],
  [["flower", "blossom"], ["flower"]],
  [["sand", "beach", "dune"], ["sand"]],
  [["snow"], ["snow"]],
  [
    ["rock", "stone", "boulder"],
    ["rock", "stone"],
  ],
  [
    ["mountain", "hill"],
    ["mountain", "hill"],
  ],
  [
    ["mud", "dirt", "ground"],
    ["earth", "dirt track"],
  ],
  [
    ["fence", "railing"],
    ["fence", "railing"],
  ],
  [["bridge"], ["bridge"]],
  [
    ["boat", "ship"],
    ["boat", "ship"],
  ],
  [["dock", "pier"], ["pier"]],
];
const COLOR_WORDS: Record<string, string> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  golden: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  purplish: "purple",
  violet: "purple",
  pink: "pink",
  brown: "brown",
  white: "white",
  black: "black",
  gray: "gray",
  grey: "gray",
};
// Percent of the photo a scene word's labels, or a colour, must cover.
const SCENE_MIN_PERCENT = 5;
const COLOR_MIN_PERCENT = 5;
const SCENE_LABELS = new Map(SCENE_WORDS.flatMap(([words, labels]) => words.map((w) => [w, labels] as const)));
const SCENE_TERMS = [...SCENE_LABELS.keys(), ...Object.keys(COLOR_WORDS)];

export type SceneFilter = ({ label: string; labels: string[] } | { label: string; color: string }) & {
  min: number;
  /** A word still being typed matches anything it could still become ("gre": green, grey or
   *  Great Blue Heron), so typing on only narrows the results. */
  alternatives?: SceneFilter[];
  orSpecies?: string[];
};

/** The scene or colour filter a word asks for ("ponds" -> water labels), or null. */
export function sceneFilter(word: string): SceneFilter | null {
  for (const w of [word, normalizeWordForm(word)]) {
    const labels = SCENE_LABELS.get(w);
    if (labels) return { label: word, labels, min: SCENE_MIN_PERCENT };
    if (COLOR_WORDS[w]) return { label: word, color: COLOR_WORDS[w], min: COLOR_MIN_PERCENT };
  }
  return null;
}

// Catalog name nouns that are also everyday words about a photo.
const PHOTO_WORDS_NOT_ANIMALS = new Set([
  "egg",
  "eggs",
  "tail",
  "head",
  "eye",
  "eyes",
  "feather",
  "feathers",
  "cone",
  "sunrise",
  "sunset",
]);

/** Whether a word names a catalog animal (or, still being typed, can only become one's name). */
export function namesUnseenAnimal(word: string, partial: boolean, heads: Set<string>): boolean {
  if (PHOTO_WORDS_NOT_ANIMALS.has(word) || PICTURE_WORDS.includes(word) || sceneFilter(word)) return false;
  if (heads.has(word) || heads.has(normalizeWordForm(word))) return true;
  if (!partial || word.length < 3) return false;
  for (const h of heads) if (h.startsWith(word)) return true;
  return false;
}

/** The scene or colour word a partial word is heading for, or null ("purp" -> "purple"). */
export function completeSceneWord(word: string): string | null {
  return completeSceneWords(word)[0] ?? null;
}

/** Every scene or colour word a partial word could become, one per distinct filter ("gra" ->
 *  grass, gray; "grey" is the same filter as "gray"). */
export function completeSceneWords(word: string): string[] {
  if (word.length < 3 || sceneFilter(word)) return [];
  const seen = new Set<string>();
  return SCENE_TERMS.filter((w) => {
    if (!w.startsWith(word)) return false;
    const f = sceneFilter(w)!;
    const key = "color" in f ? `c:${f.color}` : `l:${f.labels.join()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Accents are dropped so "montreal" finds "Montréal", whichever side has them.
export function wordsOf(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Animal plurals the suffix rules below get wrong.
const IRREGULAR_PLURALS: Record<string, string> = {
  geese: "goose",
  mice: "mouse",
  lice: "louse",
  wolves: "wolf",
  calves: "calf",
  oxen: "ox",
};

// Plural and "-ed" forms of the same root ("foxes"/"fox", "crowned"/"crown"). Not a lemmatizer,
// just the common cases.
export function normalizeWordForm(word: string): string {
  const irregular = IRREGULAR_PLURALS[word];
  if (irregular) return irregular;
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es") && /(x|ch|sh|ss|s)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Same word, allowing plurals and, for longer words, a typo ("pilated" for "pileated"). */
export function wordMatches(nameWord: string, token: string, allowTypo = false): boolean {
  if (nameWord === token) return true;
  const a = normalizeWordForm(nameWord);
  const b = normalizeWordForm(token);
  if (a === b) return true;
  if (!allowTypo || b.length < 5) return false;
  return levenshtein(a, b, b.length >= 8 ? 2 : 1) <= (b.length >= 8 ? 2 : 1);
}

/** Whether a typed word of three letters or more ends a longer name word, for compound names:
 *  "ray" finds Stingray, "hawks" Goshawk. Callers pass only a name's last word, so "ray" never
 *  finds Gray Jay. */
export function endsNameWord(nameWord: string, token: string): boolean {
  if (token.length < 3 || nameWord.length <= token.length) return false;
  if (nameWord.endsWith(token)) return true;
  const singular = token.endsWith("s") ? normalizeWordForm(token) : token;
  return singular !== token && singular.length >= 3 && nameWord.endsWith(singular);
}

/** How well typed words fit one of an item's names, higher is better, -1 for no fit. Every word
 *  must be a whole word of the same name (plurals allowed), start one, or end its last word
 *  (compounds, ranked lowest): "pil" finds Pileated, not atricaPILlus, and "purple finch" never
 *  fits Purple Martin. `prefixOnly` names (scientific names, codes) skip the compound rule:
 *  Latin endings like "-ensis" would make short queries noisy. */
export function nameMatchScore(names: readonly string[], query: string, prefixOnly: readonly string[] = []): number {
  const tokens = wordsOf(query);
  if (tokens.length === 0) return 0;
  const joined = tokens.join(" ");
  let best = -1;
  const scoreName = (name: string, compounds: boolean) => {
    const words = wordsOf(name);
    const last = words.length - 1;
    let score = words.join(" ") === joined ? 2 : 0;
    for (const t of tokens) {
      if (words.some((w) => wordMatches(w, t))) score += 4;
      else if (words.some((w) => w.startsWith(t))) score += 2;
      else if (compounds && last >= 0 && endsNameWord(words[last], t)) score += 1;
      else return -1;
    }
    return score;
  };
  for (const name of names) best = Math.max(best, scoreName(name, true));
  for (const name of prefixOnly) best = Math.max(best, scoreName(name, false));
  return best;
}

export interface SpeciesEntry {
  id: string;
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  taxonOrder: string | null;
  family: string | null;
  aliases: string[];
  codes: string[];
}

export interface PlaceEntry {
  // Trips and albums are named the same way places are ("costa rica trip", an album title).
  kind: "region" | "location" | "trip" | "album";
  id: string; // region, trip or album id, or the location label itself
  name: string;
}

/** One part of a query and how it's answered. */
export interface SearchPart {
  kind:
    | "species"
    | "group"
    | "count"
    | "scene"
    | "light"
    | "composition"
    | "background"
    | "style"
    | "description"
    | "place"
    | "date"
    | "filter"
    | "camera"
    | "excluded";
  /** What it was read as, for display. */
  label: string;
  /** The words typed for it, to take out of the query when the part is removed. */
  text: string;
  /** Answered from stored facts. False: a best guess from the picture model, shown as "probably". */
  exact: boolean;
}

// Words that only join the parts of a long query ("uses the golden ratio"), never a part themselves.
export const JOINING_WORDS = new Set(["uses", "using", "use", "has", "have", "having", "showing", "shows", "while"]);
// Phrases that put something behind the animal: "<it> in the background", "<it> behind", "against <it>".
export const BACKGROUND_AFTER = new Set(["background", "backdrop", "behind"]);
export const BACKGROUND_BEFORE = new Set(["against"]);
// Words after "behind" that point back at the animal.
export const BACKGROUND_PRONOUNS = new Set(["it", "them", "him", "her"]);
export const MAX_BACKGROUND_WORDS = 3;

export interface ParsedQuery {
  /** Species picked by name, or null when the query names no species. */
  speciesIds: Set<string> | null;
  groups: Array<{ label: string; predicate: GroupPredicate }>;
  /** Scene and colour words: each must cover enough of the photo. */
  scenes: SceneFilter[];
  /** Species whose names only share a describing word with the query ("snow" and Snow Goose):
   *  mixed into picture results rather than used as a filter. */
  hintSpeciesIds: Set<string>;
  places: PlaceEntry[];
  years: number[];
  months: number[];
  /** "last spring", "this december": photos must fall in one of these [from, to) spans. */
  dateRanges: Array<{ from: Date; to: Date }>;
  /** Highest rated first, ahead of fit. */
  bestFirst: boolean;
  /** How many animals, or null when the query doesn't say. */
  count: CountFilter | null;
  /** Hint species count only in photos with at least this many animals ("murder": crows, 2+). */
  hintMinCount: number | null;
  /** The part of the query about the picture itself, or null. */
  description: string | null;
  focalLengthMm: number | null;
  /** Filters, orders and times of day asked for in words ("lifers", "videos", "sunset"). */
  readings: Set<Reading>;
  /** A star rating range ("4+ stars"), or null. */
  stars: { min: number; max: number | null } | null;
  /** Camera models named ("R5", "iphone"): photos must be from one of them. */
  cameras: string[];
  /** Left out by "not" or "without": species, groups and picture descriptions. */
  excludeSpeciesIds: Set<string>;
  excludeGroups: Array<{ label: string; predicate: GroupPredicate }>;
  excludeDescriptions: string[];
  /** Colours whose photos are mixed in below the picture matches ("black and white" alone). */
  colorHint: string[] | null;
  /** What's behind the animal ("tree in the background", "against the sky"): ranked by the photo's
   *  background vector, never a filter. */
  backgrounds?: string[];
  /** The query split into its parts, in the order typed, for showing what was understood. */
  parts?: SearchPart[];
  labels: {
    species: string[];
    groups: string[];
    scenes: string[];
    places: string[];
    dates: string[];
    order: string[];
    readings: Reading[];
    styles: string[];
    excluded: string[];
    cameras: string[];
  };
}
