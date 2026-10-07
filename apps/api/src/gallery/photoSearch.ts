// Photo search: one query box for species names, groups, places, dates and picture content.
// Stages take the words they understand in order: full names, places and dates, multi-word
// species fits, group words, species head nouns; whatever is left is scored with CLIP.
import { pool } from "@lifer/core/db.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { captureVectors, clearYourVectorCache } from "@lifer/core/species/embeddings.js";
import { embedTextVectors } from "@lifer/core/species/textEmbedding.js";
import { GROUP_TERMS, MAX_GROUP_TERM_WORDS, speciesInGroup, type GroupPredicate } from "./searchTaxonSynonyms.js";

// A photo matches a description when it scores at least this much above its own noise level
// (see NOISE_PROMPTS) and is within reach of the best match. A per-photo baseline is needed
// because camera photos score much lower than reference photos against any prompt.
const CONTENT_MATCH_MIN = 0.033;
const CONTENT_MARGIN_RELATIVE = 0.55;

const STOPWORDS = new Set([
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
]);
const PLACE_PREPOSITIONS = new Set(["in", "at", "near", "from", "around", "on"]);
const DATE_PREPOSITIONS = new Set(["in", "during", "from", "on"]);

const MONTHS: Record<string, number> = {
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
const SEASONS: Record<string, number[]> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  fall: [9, 10, 11],
  autumn: [9, 10, 11],
  winter: [12, 1, 2],
};

// Common words for what's in a picture, so a word still being typed describes the picture it's
// heading for: "fly" means "flying" (not the insect), "swim" means "swimming", "sno" means "snow".
const PICTURE_WORDS = [
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

export function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Plural and "-ed" forms of the same root ("foxes"/"fox", "crowned"/"crown"). Not a lemmatizer,
// just the common cases.
export function normalizeWordForm(word: string): string {
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

interface IndexedSpecies extends SpeciesEntry {
  primaryWords: string[];
  primaryHead: string | null;
  sciWords: string[];
  aliasWords: string[][];
}

function indexSpecies(s: SpeciesEntry): IndexedSpecies {
  const primaryWords = wordsOf(s.commonName ?? "");
  return {
    ...s,
    primaryWords,
    primaryHead: primaryWords.at(-1) ?? null,
    sciWords: wordsOf(s.scientificName),
    aliasWords: s.aliases.map(wordsOf).filter((w) => w.length > 0),
  };
}

export interface PlaceEntry {
  // Trips and albums are named the same way places are ("costa rica trip", an album title).
  kind: "region" | "location" | "trip" | "album";
  id: string; // region, trip or album id, or the location label itself
  name: string;
}

// "costa rica trip", "big year album": the word after a name that says which kind it is.
const CONTEXT_KIND_WORDS: Record<string, "trip" | "album"> = {
  trip: "trip",
  trips: "trip",
  album: "album",
  albums: "album",
};

export interface ParsedQuery {
  /** Species picked by name, or null when the query names no species. */
  speciesIds: Set<string> | null;
  groups: Array<{ label: string; predicate: GroupPredicate }>;
  /** Species whose names only share a describing word with the query ("snow" and Snow Goose):
   *  mixed into picture results rather than used as a filter. */
  hintSpeciesIds: Set<string>;
  places: PlaceEntry[];
  years: number[];
  months: number[];
  /** The part of the query about the picture itself, or null. */
  description: string | null;
  focalLengthMm: number | null;
  labels: { species: string[]; groups: string[]; places: string[]; dates: string[] };
}

const FOCAL_LENGTH_PATTERN = /\b(\d{2,4})\s*mm\b/i;

/** Reads a query into filters and a picture description. Pure, so it's tested directly. */
export function parseSearchQuery(
  q: string,
  vocab: { species: SpeciesEntry[]; places: PlaceEntry[]; latinGroups: Map<string, GroupPredicate>; now?: Date },
  // A partial last word ("moo") picks the species it starts, so results appear while typing.
  // The full search passes false: by then the word may be complete ("grass", not "grasshopper"),
  // so those species are only mixed into the picture results.
  opts: { partialWordPicksSpecies?: boolean } = {},
): ParsedQuery {
  const partialWordPicksSpecies = opts.partialWordPicksSpecies ?? true;
  const now = vocab.now ?? new Date();
  const result: ParsedQuery = {
    speciesIds: null,
    groups: [],
    hintSpeciesIds: new Set(),
    places: [],
    years: [],
    months: [],
    description: null,
    focalLengthMm: null,
    labels: { species: [], groups: [], places: [], dates: [] },
  };
  let text = q.trim();
  const focal = text.match(FOCAL_LENGTH_PATTERN);
  if (focal) {
    result.focalLengthMm = Number(focal[1]);
    text = text.replace(FOCAL_LENGTH_PATTERN, " ");
  }

  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/[\s]+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
  // Hyphenated words ("red-tailed") are compared word by word, like names are.
  const words: string[] = tokens.flatMap((t) => wordsOf(t));
  const used = new Array(words.length).fill(false);
  const species = vocab.species.map(indexSpecies);
  // Every subject a stage finds, with where it sits in the query, so the rules at the end can
  // decide which ones count.
  const subjects: Array<{
    start: number;
    end: number;
    species?: string[];
    group?: { label: string; predicate: GroupPredicate };
    labels: string[];
  }> = [];
  const nameOf = (id: string) => {
    const s = species.find((x) => x.id === id)!;
    return s.commonName ?? s.scientificName;
  };
  const phraseAt = (i: number, n: number) =>
    i + n <= words.length && !used.slice(i, i + n).some(Boolean) ? words.slice(i, i + n).join(" ") : null;
  const markUsed = (i: number, n: number) => {
    for (let k = i; k < i + n; k++) used[k] = true;
  };
  // Words that were a place or a date (and the "in"/"from" before them): the only words left out
  // of the picture description.
  const context = new Array(words.length).fill(false);
  // A last word still being typed that's heading for a picture word ("fly" for "flying") is
  // described as that word.
  const lastIndex = words.length - 1;
  // Not when the word is already complete as something else: a group ("fish", not "fishing") or a
  // whole word of a species name.
  const lastWord = words[lastIndex];
  const lastIsKnownWord =
    lastIndex >= 0 &&
    (GROUP_TERMS.has(lastWord) ||
      GROUP_TERMS.has(normalizeWordForm(lastWord)) ||
      vocab.species.some((s) => wordsOf(s.commonName ?? "").includes(lastWord)));
  const completion = lastIndex >= 0 && !lastIsKnownWord ? completePictureWord(lastWord) : null;

  // 1. Full names, longest first. Aliases count only when at least two words: single-word
  //    aliases are often junk.
  const fullNames = new Map<string, Set<string>>();
  const addFull = (phrase: string, id: string) => {
    if (!phrase) return;
    if (!fullNames.has(phrase)) fullNames.set(phrase, new Set());
    fullNames.get(phrase)!.add(id);
  };
  for (const s of species) {
    addFull(s.primaryWords.join(" "), s.id);
    addFull(s.sciWords.join(" "), s.id);
    for (const c of s.codes) addFull(c.toLowerCase(), s.id);
    for (const a of s.aliasWords) if (a.length >= 2) addFull(a.join(" "), s.id);
  }
  const maxNameWords = Math.min(6, Math.max(1, ...[...fullNames.keys()].map((k) => k.split(" ").length)));
  for (let n = maxNameWords; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = phraseAt(i, n);
      if (!phrase) continue;
      // A single word that equals a whole name doesn't count if it's also a group word.
      if (n === 1 && GROUP_TERMS.has(phrase)) continue;
      const hit = fullNames.get(phrase);
      if (!hit) continue;
      subjects.push({ start: i, end: i + n, species: [...hit], labels: [...hit].map(nameOf) });
      markUsed(i, n);
    }
  }

  // 2. Places and dates.
  const placeByName = new Map<string, PlaceEntry[]>();
  for (const p of vocab.places) {
    const key = wordsOf(p.name).join(" ");
    if (!key) continue;
    if (!placeByName.has(key)) placeByName.set(key, []);
    placeByName.get(key)!.push(p);
  }
  const maxPlaceWords = Math.min(5, Math.max(1, ...[...placeByName.keys()].map((k) => k.split(" ").length)));
  // Words followed by "trip" or "album" pick the trips or albums whose names contain them
  // ("costa rica trip" finds "Costa Rica 2024"), taking the kind word along.
  for (let i = 0; i < words.length; i++) {
    const kind = CONTEXT_KIND_WORDS[words[i]];
    if (!kind || used[i]) continue;
    for (let n = Math.min(i, maxPlaceWords); n >= 1; n--) {
      const phrase = phraseAt(i - n, n);
      if (!phrase || phrase.split(" ").every((w) => STOPWORDS.has(w))) continue;
      const hit = vocab.places.filter(
        (p) => p.kind === kind && ` ${wordsOf(p.name).join(" ")} `.includes(` ${phrase} `),
      );
      if (hit.length === 0) continue;
      result.places.push(...hit);
      result.labels.places.push(...hit.map((p) => p.name));
      markUsed(i - n, n + 1);
      for (let k = i - n; k <= i; k++) context[k] = true;
      break;
    }
  }
  for (let n = maxPlaceWords; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = phraseAt(i, n);
      let hit = phrase ? placeByName.get(phrase) : undefined;
      if (!hit) continue;
      // "<trip name> trip": just the trip, and the kind word goes with it.
      const kindWord = i + n < words.length && !used[i + n] ? CONTEXT_KIND_WORDS[words[i + n]] : undefined;
      const ofKind = kindWord ? hit.filter((p) => p.kind === kindWord) : [];
      if (ofKind.length > 0) hit = ofKind;
      result.places.push(...hit);
      result.labels.places.push(hit[0].name);
      markUsed(i, n + (ofKind.length > 0 ? 1 : 0));
      for (let k = i; k < i + n + (ofKind.length > 0 ? 1 : 0); k++) context[k] = true;
      if (i > 0 && !used[i - 1] && PLACE_PREPOSITIONS.has(words[i - 1])) used[i - 1] = context[i - 1] = true;
    }
  }
  for (let i = 0; i < words.length; i++) {
    if (used[i]) continue;
    const w = words[i];
    const next = words[i + 1];
    let matched = false;
    if (/^(19|20)\d{2}$/.test(w)) {
      result.years.push(Number(w));
      result.labels.dates.push(w);
      matched = true;
    } else if ((w === "this" || w === "last") && next === "year" && !used[i + 1]) {
      const year = now.getFullYear() - (w === "last" ? 1 : 0);
      result.years.push(year);
      result.labels.dates.push(`${w} year`);
      used[i + 1] = context[i + 1] = true;
      matched = true;
    } else if (MONTHS[w] && (w.length > 3 || w === "may" || w === "jun" || w === "jul")) {
      // Three-letter abbreviations other than these read as other words too often ("mar", "dec").
      result.months.push(MONTHS[w]);
      result.labels.dates.push(w[0].toUpperCase() + w.slice(1));
      matched = true;
    } else if (SEASONS[w]) {
      result.months.push(...SEASONS[w]);
      result.labels.dates.push(w);
      matched = true;
    }
    if (matched) {
      used[i] = context[i] = true;
      if (i > 0 && !used[i - 1] && DATE_PREPOSITIONS.has(words[i - 1])) used[i - 1] = context[i - 1] = true;
    }
  }

  // Words of one or two letters never pick a species, or old names with "up" would hijack "close up".
  const open = () =>
    words.map((w, i) => ({ w, i })).filter(({ w, i }) => !used[i] && !STOPWORDS.has(w) && w.length >= 3);

  // 3. Several words that fit one species together.
  const openWords = open();
  if (openWords.length >= 2) {
    let best = 0;
    const counts = new Map<string, number[]>();
    for (const s of species) {
      const hitIdx = openWords
        .filter(({ w }) => s.primaryWords.some((nw) => wordMatches(nw, w, true)))
        .map(({ i }) => i);
      if (hitIdx.length >= 2) {
        counts.set(s.id, hitIdx);
        best = Math.max(best, hitIdx.length);
      }
    }
    if (best >= 2) {
      const ids = [...counts].filter(([, idx]) => idx.length === best).map(([id]) => id);
      const idx = [...new Set(ids.flatMap((id) => counts.get(id)!))];
      for (const i of idx) used[i] = true;
      subjects.push({ start: Math.min(...idx), end: Math.max(...idx) + 1, species: ids, labels: ids.map(nameOf) });
    }
  }

  // 4. Group words and Latin orders/families, longest phrase first.
  for (let n = MAX_GROUP_TERM_WORDS; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = phraseAt(i, n);
      if (!phrase) continue;
      const group = GROUP_TERMS.get(phrase) ?? (n === 1 ? GROUP_TERMS.get(normalizeWordForm(phrase)) : undefined);
      const latin = n === 1 ? vocab.latinGroups.get(phrase) : undefined;
      if (group) {
        // Labeled with the words as typed ("birds of prey"), which reads better than any fixed name.
        subjects.push({ start: i, end: i + n, group: { ...group, label: phrase }, labels: [phrase] });
      } else if (latin) {
        const label = words[i][0].toUpperCase() + words[i].slice(1);
        subjects.push({ start: i, end: i + n, group: { label, predicate: latin }, labels: [label] });
      } else continue;
      markUsed(i, n);
    }
  }

  // 5. Species-name words: the main noun picks species; a describing word only hints.
  for (const { w, i } of open()) {
    const head = species.filter((s) => s.primaryHead && wordMatches(s.primaryHead, w));
    const sci = species.filter((s) => s.sciWords.some((sw) => sw === w));
    const code = species.filter((s) => s.codes.some((c) => c.toLowerCase() === w));
    const direct = [...new Set([...head, ...sci, ...code])];
    // An alternate name counts when its main noun is this word and the species shares a family
    // with a species whose current name has it.
    const directFamilies = new Set(direct.map((s) => s.family));
    const aliasHead = species.filter(
      (s) =>
        !direct.includes(s) &&
        s.aliasWords.some((a) => wordMatches(a.at(-1)!, w)) &&
        (direct.length === 0 || directFamilies.has(s.family)),
    );
    let picked = [...direct, ...aliasHead];
    // A partial last word (three letters or more) picks species or a group it starts. A complete
    // describing word is left to mean the picture.
    let typedGroup: { label: string; predicate: GroupPredicate } | undefined;
    const isWholeNameWord = species.some((s) => s.primaryWords.includes(w));
    // Heading for a picture word: the species it starts are only mixed in.
    if (picked.length === 0 && i === lastIndex && completion) {
      for (const s of species.filter((s) => s.primaryWords.some((pw) => pw.startsWith(w))))
        result.hintSpeciesIds.add(s.id);
      continue;
    }
    if (picked.length === 0 && i === words.length - 1 && w.length >= 3 && !isWholeNameWord) {
      const started = species.filter(
        (s) => s.primaryWords.some((pw) => pw.startsWith(w)) || s.sciWords.some((sw) => sw.startsWith(w)),
      );
      const term = [...GROUP_TERMS.keys()].find((k) => !k.includes(" ") && k.startsWith(w));
      if (partialWordPicksSpecies) {
        picked = started;
        typedGroup = term ? { ...GROUP_TERMS.get(term)!, label: term } : undefined;
      } else {
        // A group from a partial word needs four letters: "car" shouldn't bring in every carnivore.
        const group = term && w.length >= 4 ? GROUP_TERMS.get(term)!.predicate : null;
        const inGroup = group ? species.filter((s) => speciesInGroup(s, group)) : [];
        for (const s of [...started, ...inGroup]) result.hintSpeciesIds.add(s.id);
        if (started.length + inGroup.length > 0) continue;
      }
    }
    if (picked.length === 0 && !typedGroup && w.length >= 5)
      picked = species.filter((s) => s.primaryHead && wordMatches(s.primaryHead, w, true));
    if (picked.length > 0 || typedGroup) {
      if (picked.length > 0) subjects.push({ start: i, end: i + 1, species: picked.map((s) => s.id), labels: [w] });
      if (typedGroup) subjects.push({ start: i, end: i + 1, group: typedGroup, labels: [typedGroup.label] });
      used[i] = true;
      continue;
    }
    const modifier = species.filter((s) => s.primaryWords.slice(0, -1).some((nw) => wordMatches(nw, w, w.length >= 6)));
    for (const s of modifier) result.hintSpeciesIds.add(s.id);
  }

  // A subject after a description is the object of the action, not a second subject:
  // "heron catching fish" searches herons. "owls and hawks" keeps both.
  subjects.sort((a, b) => a.start - b.start);
  const kept: typeof subjects = [];
  for (const sub of subjects) {
    const prev = kept.at(-1);
    const afterDescription =
      prev !== undefined &&
      words.slice(prev.end, sub.start).some((w, k) => {
        const idx = prev.end + k;
        return !used[idx] && !context[idx] && !STOPWORDS.has(w);
      });
    if (afterDescription) {
      for (let k = sub.start; k < sub.end; k++) used[k] = false;
      continue;
    }
    kept.push(sub);
  }
  const pickedSpecies = new Set(kept.flatMap((sub) => sub.species ?? []));
  for (const sub of kept) {
    if (sub.group) {
      result.groups.push(sub.group);
      result.labels.groups.push(...sub.labels);
    } else result.labels.species.push(...sub.labels);
  }
  if (pickedSpecies.size > 0) result.speciesIds = pickedSpecies;
  // A description exists only when some words are left over. It keeps the subject words too,
  // dropping only places, dates and their prepositions.
  if (words.some((w, i) => !used[i] && !STOPWORDS.has(w))) {
    result.description =
      words
        .map((w, i) => (i === lastIndex && completion && !used[i] ? completion : w))
        .filter((_, i) => !context[i])
        .join(" ")
        .trim() || null;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Picture scoring

// "a photo of water" asks for a picture OF water; in a wildlife library "water" usually means an
// animal in or by it, so the phrasings include that reading too.
const QUERY_TEMPLATES = (d: string) => [
  `a photo of ${d}`,
  `a wildlife photo with ${d}`,
  `a photo of an animal in ${d}`,
  `a photo of an animal near ${d}`,
  `a wildlife photo of ${d}`,
  d,
];
// Things never in a wildlife photo. A photo's average match to these is its noise level: how
// much it matches ANY prompt just by being a wildlife photo, which differs from photo to photo.
const NOISE_PROMPTS = [
  "a car",
  "a city street",
  "text on a page",
  "food on a plate",
  "a building",
  "a computer",
  "furniture",
  "a cartoon",
  "an airplane",
  "a spreadsheet",
  "a company logo",
  "a keyboard",
];
let noiseVectors: Promise<Float32Array> | null = null;
/** The average of the noise prompts' vectors: a photo's dot product with it is its average
 *  match to them. */
function noiseVector(): Promise<Float32Array> {
  noiseVectors ??= Promise.all(NOISE_PROMPTS.map((p) => queryVector(p))).then((vs) => {
    const avg = new Float32Array(vs[0].length);
    for (const v of vs) for (let i = 0; i < avg.length; i++) avg[i] += v[i] / vs.length;
    return avg;
  });
  noiseVectors.catch(() => (noiseVectors = null));
  return noiseVectors;
}
const queryVectorCache = new Map<string, Float32Array>();

async function queryVector(text: string): Promise<Float32Array> {
  const cached = queryVectorCache.get(text);
  if (cached) return cached;
  const parts = await embedTextVectors(QUERY_TEMPLATES(text));
  const v = new Float32Array(parts[0].length);
  for (const p of parts) for (let i = 0; i < v.length; i++) v[i] += p[i];
  normalize(v);
  if (queryVectorCache.size > 300) queryVectorCache.delete(queryVectorCache.keys().next().value!);
  queryVectorCache.set(text, v);
  return v;
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Photo vectors are cached in memory (shared with species/embeddings.ts), keyed by capture and
// computed_at so a recomputed vector replaces the old one. Stored vectors are unit length.
function photoVectors(
  rows: Array<{ capture_id: string; embedding_computed_at: string | null }>,
): Promise<Map<string, Float32Array>> {
  return captureVectors(
    pool,
    "capture_embeddings",
    EMBEDDING_MODEL_VERSION,
    rows.map((r) => ({ capture_id: r.capture_id, computed_at: r.embedding_computed_at })),
  );
}

/** Test and memory hook: forget cached vectors. */
export function clearPhotoVectorCache(): void {
  clearYourVectorCache();
}

export interface SearchRow {
  capture_id: string;
  species_id: string;
  quality_rating: number | null;
  taken_at: Date | string | null;
  tags: string[] | null;
  region_id: string | null;
  location_label: string | null;
  trip_id?: string | null;
  album_ids?: string[] | null;
  focal_length_mm: number | string | null;
  embedding_computed_at: string | null;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  taxon_order: string | null;
  family: string | null;
  [key: string]: unknown;
}

export interface SearchOutcome<R> {
  items: Array<{ row: R; score: number | null }>;
  interpretation: ParsedQuery["labels"] & { description: string | null };
  /** A quick answer that skipped picture matching: the full one is still to come. */
  pending?: boolean;
}

function byRatingThenDate(a: SearchRow, b: SearchRow): number {
  return (
    (b.quality_rating ?? 0) - (a.quality_rating ?? 0) ||
    new Date(String(b.taken_at ?? 0)).getTime() - new Date(String(a.taken_at ?? 0)).getTime()
  );
}

function tagMatches(tags: string[] | null, query: string): boolean {
  const qWords = wordsOf(query).filter((w) => !STOPWORDS.has(w));
  if (qWords.length === 0) return false;
  const joined = ` ${qWords.join(" ")} `;
  return (tags ?? []).some((t) => {
    const tw = wordsOf(t);
    if (tw.length === 0) return false;
    // The tag names the query ("yellow flower" tagged on a photo), or the query names the tag.
    return (
      qWords.every((w) => tw.some((x) => wordMatches(x, w))) ||
      (tw.join(" ").length >= 3 && joined.includes(` ${tw.join(" ")} `))
    );
  });
}

/** Runs a parsed query over the rows the route already filtered (rating, taxa, dates...). */
export async function rankSearch<R extends SearchRow>(
  q: string,
  parsed: ParsedQuery,
  rows: R[],
  regionSubtree: (regionIds: string[]) => Promise<Set<string>>,
  opts: { quick?: boolean } = {},
): Promise<SearchOutcome<R>> {
  const interpretation = { ...parsed.labels, description: parsed.description };
  let candidates = rows;

  if (parsed.focalLengthMm) {
    const target = parsed.focalLengthMm;
    candidates = candidates.filter(
      (r) => r.focal_length_mm != null && Math.abs(Number(r.focal_length_mm) - target) <= target * 0.2,
    );
  }
  if (parsed.places.length > 0) {
    const regionIds = parsed.places.filter((p) => p.kind === "region").map((p) => p.id);
    const inRegion = regionIds.length > 0 ? await regionSubtree(regionIds) : new Set<string>();
    const labels = new Set(parsed.places.filter((p) => p.kind === "location").map((p) => p.name.toLowerCase()));
    const trips = new Set(parsed.places.filter((p) => p.kind === "trip").map((p) => p.id));
    const albums = new Set(parsed.places.filter((p) => p.kind === "album").map((p) => p.id));
    candidates = candidates.filter(
      (r) =>
        (r.region_id && inRegion.has(r.region_id)) ||
        (r.location_label && labels.has(r.location_label.toLowerCase())) ||
        (r.trip_id && trips.has(r.trip_id)) ||
        (r.album_ids ?? []).some((a) => albums.has(a)),
    );
  }
  if (parsed.years.length > 0 || parsed.months.length > 0) {
    candidates = candidates.filter((r) => {
      if (!r.taken_at) return false;
      const d = new Date(String(r.taken_at));
      return (
        (parsed.years.length === 0 || parsed.years.includes(d.getFullYear())) &&
        (parsed.months.length === 0 || parsed.months.includes(d.getMonth() + 1))
      );
    });
  }

  const tagged = new Set(candidates.filter((r) => tagMatches(r.tags, q)).map((r) => r.capture_id));
  const hasSubject = parsed.speciesIds !== null || parsed.groups.length > 0;
  if (hasSubject) {
    candidates = candidates.filter(
      (r) =>
        tagged.has(r.capture_id) ||
        parsed.speciesIds?.has(r.species_id) ||
        parsed.groups.some((g) =>
          speciesInGroup(
            { taxonClass: r.taxon_class, taxonOrder: r.taxon_order, family: r.family, commonName: r.common_name },
            g.predicate,
          ),
        ),
    );
  }

  const withTagsFirst = (scored: Array<{ row: R; score: number | null }>) =>
    // No cap: the gallery shows every photo, and picture-only searches are already cut by margin.
    [...scored.filter((s) => tagged.has(s.row.capture_id)), ...scored.filter((s) => !tagged.has(s.row.capture_id))];

  // Nothing about the picture: the filters are the answer.
  if (!parsed.description) {
    if (
      !hasSubject &&
      parsed.places.length === 0 &&
      parsed.years.length === 0 &&
      parsed.months.length === 0 &&
      !parsed.focalLengthMm
    ) {
      return {
        items: withTagsFirst(rows.filter((r) => tagged.has(r.capture_id)).map((row) => ({ row, score: null }))),
        interpretation,
      };
    }
    const sorted = [...candidates].sort(
      parsed.focalLengthMm
        ? (a, b) =>
            Math.abs(Number(a.focal_length_mm) - parsed.focalLengthMm!) -
            Math.abs(Number(b.focal_length_mm) - parsed.focalLengthMm!)
        : byRatingThenDate,
    );
    return { items: withTagsFirst(sorted.map((row) => ({ row, score: null }))), interpretation };
  }

  // The quick pass skips picture matching: it shows a subject's photos right away, or nothing
  // for a description-only query so the page keeps what it had.
  if (opts.quick) {
    const quickItems = hasSubject ? [...candidates].sort(byRatingThenDate).map((row) => ({ row, score: null })) : [];
    return { items: withTagsFirst(quickItems), interpretation, pending: true };
  }

  let queryVec: Float32Array | null = null;
  let noiseVec: Float32Array | null = null;
  try {
    [queryVec, noiseVec] = await Promise.all([queryVector(parsed.description), noiseVector()]);
  } catch {
    // Species matching isn't downloaded: names, groups, places and dates still work.
  }
  if (!queryVec || !noiseVec) {
    const fallback = hasSubject
      ? [...candidates].sort(byRatingThenDate)
      : candidates.filter((r) => tagged.has(r.capture_id) || parsed.hintSpeciesIds.has(r.species_id));
    return { items: withTagsFirst(fallback.map((row) => ({ row, score: null }))), interpretation };
  }

  const vectors = await photoVectors(candidates);
  const scored = candidates.map((row) => {
    const v = vectors.get(row.capture_id);
    return { row, score: v ? dot(v, queryVec!) - dot(v, noiseVec!) : null };
  });

  // Subject plus description: every photo of the subject, best fit first. Never hides one.
  if (hasSubject) {
    scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || byRatingThenDate(a.row, b.row));
    return { items: withTagsFirst(scored), interpretation };
  }

  // Only a description: keep clear matches, plus photos of species whose names share its words
  // (Snow Goose for "snow") and photos tagged with it.
  const top = Math.max(0, ...scored.map((s) => s.score ?? 0));
  const cutoff = Math.max(CONTENT_MATCH_MIN, top * CONTENT_MARGIN_RELATIVE);
  // A describing word in species names could mean either. If most photos of those species also
  // match it by picture, treat it as naming them and show just them.
  const hinted = scored.filter((s) => parsed.hintSpeciesIds.has(s.row.species_id));
  if (hinted.length > 0 && hinted.filter((s) => (s.score ?? -1) >= cutoff).length >= hinted.length / 2) {
    hinted.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const taggedRows = scored.filter(
      (s) => tagged.has(s.row.capture_id) && !parsed.hintSpeciesIds.has(s.row.species_id),
    );
    return {
      items: withTagsFirst([...hinted, ...taggedRows]),
      interpretation: {
        ...interpretation,
        species: [...new Set(hinted.map((s) => s.row.common_name ?? s.row.scientific_name))],
      },
    };
  }
  const kept = scored.filter(
    (s) => (s.score ?? -1) >= cutoff || parsed.hintSpeciesIds.has(s.row.species_id) || tagged.has(s.row.capture_id),
  );
  kept.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { items: withTagsFirst(kept), interpretation };
}
