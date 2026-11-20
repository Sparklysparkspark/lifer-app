// Photo search: one query box for species names, groups, places, dates and picture content.
// Stages take the words they understand in order: full names, places and dates, filter and order
// words, "not"/"without", photo styles, cameras, counts and collective nouns, multi-word species
// fits, group words, scene words, species head nouns; whatever is left is scored with CLIP
// (searchRank.ts). Each stage also notes the words it took as one part of the query (`parts`), so a
// long query shows what was understood. The vocabulary is in searchTerms.ts.
import { GROUP_TERMS, MAX_GROUP_TERM_WORDS, type GroupPredicate } from "./searchTaxonSynonyms.js";
import { trimChars } from "./trimChars.js";
import {
  STOPWORDS,
  COUNT_WORDS,
  NUMBER_WORDS,
  NUMBER_MULTIPLIERS,
  QUANTITY_WORDS,
  GROUP_COUNT_WORDS,
  CROWD_ADJECTIVES,
  COLLECTIVES,
  COLLECTIVE_ANIMAL_NAMES,
  countForNumber,
  FILLER_WORDS,
  BEST_WORDS,
  PLACE_PREPOSITIONS,
  DATE_PREPOSITIONS,
  READING_PHRASES,
  MAX_READING_WORDS,
  JOINING_WORDS,
  BACKGROUND_AFTER,
  BACKGROUND_BEFORE,
  BACKGROUND_PRONOUNS,
  MAX_BACKGROUND_WORDS,
  NEGATION_WORDS,
  STYLE_PROMPTS,
  MAX_STYLE_WORDS,
  MONTHS,
  SEASONS,
  PICTURE_WORDS,
  completePictureWord,
  completeSceneWord,
  completeSceneWords,
  sceneFilter,
  namesUnseenAnimal,
  wordsOf,
  normalizeWordForm,
  wordMatches,
  endsNameWord,
  type CountFilter,
  type ParsedQuery,
  type PlaceEntry,
  type Reading,
  type SceneFilter,
  type SearchPart,
  type SpeciesEntry,
} from "./searchTerms.js";

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

// "costa rica trip", "big year album": the word after a name that says which kind it is.
const CONTEXT_KIND_WORDS: Record<string, "trip" | "album"> = {
  trip: "trip",
  trips: "trip",
  album: "album",
  albums: "album",
};

const FOCAL_LENGTH_PATTERN = /\b(\d{2,4})\s*mm\b/i;
// "5 stars", "4+ stars", "4 star", "3 stars or more".
const STAR_PATTERN =
  /\b([1-5]|one|two|three|four|five)\s*(\+)?[\s-]*stars?\b(\s+(or|and)\s+(more|up|above|better|higher))?/i;

/** Reads a query into filters and a picture description. Pure, so it's tested directly. */
export function parseSearchQuery(
  q: string,
  vocab: {
    species: SpeciesEntry[];
    places: PlaceEntry[];
    latinGroups: Map<string, GroupPredicate>;
    /** The main noun of every catalog species' name ("tiger", "fisher"), so naming an animal
     *  with no photos finds nothing instead of a weak picture match. */
    catalogHeads?: Set<string>;
    /** The camera models in the user's photos, so "R5" or "iphone" picks theirs. */
    cameras?: string[];
    now?: Date;
  },
  // A partial last word ("moo") picks the species and group it starts. The full search passes
  // false, which asks four letters of a group ("car" shouldn't mean every carnivore).
  opts: { partialWordPicksSpecies?: boolean } = {},
): ParsedQuery {
  const result: ParsedQuery = {
    speciesIds: null,
    groups: [],
    scenes: [],
    hintSpeciesIds: new Set(),
    places: [],
    years: [],
    months: [],
    dateRanges: [],
    bestFirst: false,
    count: null,
    hintMinCount: null,
    description: null,
    focalLengthMm: null,
    readings: new Set(),
    stars: null,
    cameras: [],
    excludeSpeciesIds: new Set(),
    excludeGroups: [],
    excludeDescriptions: [],
    colorHint: null,
    labels: {
      species: [],
      groups: [],
      scenes: [],
      places: [],
      dates: [],
      order: [],
      readings: [],
      styles: [],
      excluded: [],
      cameras: [],
    },
  };
  // "b&w" and "b/w" would lose their middle with the punctuation.
  let text = q.trim().replace(/\bb\s*[&/]\s*w\b/gi, "bw");
  const focal = text.match(FOCAL_LENGTH_PATTERN);
  if (focal) {
    result.focalLengthMm = Number(focal[1]);
    text = text.replace(FOCAL_LENGTH_PATTERN, " ");
  }
  const stars = text.match(STAR_PATTERN);
  if (stars) {
    const n = Number(stars[1]) || NUMBER_WORDS[stars[1].toLowerCase()];
    result.stars = { min: n, max: stars[2] || stars[3] ? null : n };
    text = text.replace(STAR_PATTERN, " ");
  }

  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/[\s]+/)
    .map((t) => trimChars(t, "'-"))
    .filter(Boolean);
  // Hyphenated words ("red-tailed") are compared word by word, like names are.
  const words: string[] = tokens.flatMap((t) => wordsOf(t));
  const used: boolean[] = new Array(words.length).fill(false);
  const species = vocab.species.map(indexSpecies);
  // A last word still being typed that's heading for a picture or scene word ("fly" for "flying",
  // "purp" for "purple") is read as that word.
  const lastIndex = words.length - 1;
  // Not when the word is already complete as something else: a group ("fish", not "fishing"), a
  // scene word or a whole word of a species name.
  const lastWord = words[lastIndex];
  const lastIsKnownWord =
    lastIndex >= 0 &&
    (GROUP_TERMS.has(lastWord) ||
      GROUP_TERMS.has(normalizeWordForm(lastWord)) ||
      sceneFilter(lastWord) ||
      vocab.species.some((s) => wordsOf(s.commonName ?? "").includes(lastWord)));
  const completion =
    lastIndex >= 0 && !lastIsKnownWord ? (completePictureWord(lastWord) ?? completeSceneWord(lastWord)) : null;

  const st: ParseState = {
    words,
    typed: [...words],
    spans: [],
    used,
    // Words that were a place or a date (and the "in"/"from" before them): the only words left out
    // of the picture description.
    context: new Array(words.length).fill(false),
    subjects: [],
    rewrites: new Map(),
    negated: new Set(),
    result,
    species,
    lastIndex,
    completion,
    vocab,
    now: vocab.now ?? new Date(),
    partialWordPicksSpecies: opts.partialWordPicksSpecies ?? true,
    phraseAt: (i, n) =>
      i + n <= words.length && !used.slice(i, i + n).some(Boolean) ? words.slice(i, i + n).join(" ") : null,
    markUsed: (i, n) => {
      for (let k = i; k < i + n; k++) used[k] = true;
    },
    nameOf: (id) => {
      const s = species.find((x) => x.id === id)!;
      return s.commonName ?? s.scientificName;
    },
    // Words of one or two letters never pick a species, or old names with "up" would hijack "close up".
    open: () =>
      words
        .map((w, i) => ({ w, i }))
        .filter(({ w, i }) => !used[i] && !STOPWORDS.has(w) && !COUNT_WORDS.has(w) && !COLLECTIVES[w] && w.length >= 3),
  };
  takeFullNames(st);
  takePlaces(st);
  takeDates(st);
  takeReadings(st);
  takeNegations(st);
  takeStyles(st);
  takeBackgrounds(st);
  takeCameras(st);
  takeBestWords(st);
  takeCounts(st);
  takeMultiWordSpecies(st);
  takeGroups(st);
  takeScenes(st);
  takeSpeciesWords(st);
  keepSubjects(st);
  describe(st);
  result.labels.readings = [...result.readings];
  result.parts = st.spans
    .sort((a, b) => a.start - b.start)
    .map(({ kind, label, start, end, exact }) => ({ kind, label, exact, text: st.typed.slice(start, end).join(" ") }));
  return result;
}

// Every subject a stage finds, with where it sits in the query, so the rules at the end can
// decide which ones count.
interface Subject {
  start: number;
  end: number;
  species?: string[];
  group?: { label: string; predicate: GroupPredicate };
  labels: string[];
}

type SearchVocab = Parameters<typeof parseSearchQuery>[1];

// What the stages share. Each takes the words it understands, marking them `used`.
interface ParseState {
  words: string[];
  /** The words as typed, before a stage rewrites one ("murder of crows" reads "corvids"). */
  typed: string[];
  /** The parts found, by word range. */
  spans: Array<{ kind: SearchPart["kind"]; label: string; start: number; end: number; exact: boolean }>;
  used: boolean[];
  context: boolean[];
  subjects: Subject[];
  /** Words the picture description reads as something else ("murder" as a predation prompt). */
  rewrites: Map<number, string>;
  /** Where a "not" or "without" points: the subject or picture word there is left out. */
  negated: Set<number>;
  result: ParsedQuery;
  species: IndexedSpecies[];
  lastIndex: number;
  completion: string | null;
  vocab: SearchVocab;
  now: Date;
  partialWordPicksSpecies: boolean;
  phraseAt(i: number, n: number): string | null;
  markUsed(i: number, n: number): void;
  nameOf(id: string): string;
  open(): Array<{ w: string; i: number }>;
}

function takeFullNames(st: ParseState): void {
  const { words, subjects, species, phraseAt, markUsed, nameOf } = st;
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
}

function takePlaces(st: ParseState): void {
  const { words, used, context, result, vocab, phraseAt, markUsed } = st;
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
      st.spans.push({ kind: "place", label: hit.map((p) => p.name).join(", "), start: i - n, end: i + 1, exact: true });
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
      st.spans.push({
        kind: "place",
        label: hit[0].name,
        start: i,
        end: i + n + (ofKind.length > 0 ? 1 : 0),
        exact: true,
      });
      markUsed(i, n + (ofKind.length > 0 ? 1 : 0));
      for (let k = i; k < i + n + (ofKind.length > 0 ? 1 : 0); k++) context[k] = true;
      if (i > 0 && !used[i - 1] && PLACE_PREPOSITIONS.has(words[i - 1])) used[i - 1] = context[i - 1] = true;
    }
  }
}

// Years, months, seasons and "this/last <month or season>".
function takeDates(st: ParseState): void {
  const { words, used, context, result, now } = st;
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
    } else if ((w === "this" || w === "last") && (MONTHS[next] || SEASONS[next]) && !used[i + 1]) {
      // A season belongs to the year it ends in (winter 2026 is Dec 2025 to Feb 2026). "last" is
      // the latest one already over; "this" is the one ending this year.
      const months = SEASONS[next] ?? [MONTHS[next]];
      const [first, end] = [months[0], months.at(-1)!];
      const endYear = now.getFullYear() - (w === "last" && end >= now.getMonth() + 1 ? 1 : 0);
      result.dateRanges.push({
        from: new Date(endYear - (first > end ? 1 : 0), first - 1, 1),
        to: new Date(endYear, end, 1),
      });
      result.labels.dates.push(`${w} ${SEASONS[next] ? next : next[0].toUpperCase() + next.slice(1)}`);
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
      const end = used[i + 1] && context[i + 1] && (w === "this" || w === "last") ? i + 2 : i + 1;
      st.spans.push({ kind: "date", label: result.labels.dates.at(-1)!, start: i, end, exact: true });
      used[i] = context[i] = true;
      if (i > 0 && !used[i - 1] && DATE_PREPOSITIONS.has(words[i - 1])) used[i - 1] = context[i - 1] = true;
    }
  }
}

// Whether words i..i+n run on into a species name with a neighbour ("night heron", "evening
// grosbeak"), so they stay the name's.
function partOfName(st: ParseState, i: number, n: number): boolean {
  for (const [from, len] of [
    [i - 1, n + 1],
    [i, n + 1],
  ]) {
    if (from < 0 || from + len > st.words.length) continue;
    const run = st.words.slice(from, from + len);
    for (const s of st.species)
      for (let k = 0; k + len <= s.primaryWords.length; k++)
        if (run.every((w, j) => wordMatches(s.primaryWords[k + j], w))) return true;
  }
  return false;
}

// Marks words i..i+n taken and out of the description, with the "at"/"in the" before them.
function takeAsContext(st: ParseState, i: number, n: number): void {
  st.markUsed(i, n);
  for (let k = i; k < i + n; k++) st.context[k] = true;
  for (let k = i - 1; k >= 0 && !st.used[k] && STOPWORDS.has(st.words[k]); k--) st.used[k] = st.context[k] = true;
}

function takeReadings(st: ParseState): void {
  const { result, phraseAt } = st;
  for (let n = MAX_READING_WORDS; n >= 1; n--) {
    for (let i = 0; i + n <= st.words.length; i++) {
      const phrase = phraseAt(i, n);
      const reading = phrase ? READING_PHRASES[phrase] : undefined;
      if (!reading || partOfName(st, i, n)) continue;
      result.readings.add(reading);
      st.spans.push({ kind: partKindOf(reading), label: phrase!, start: i, end: i + n, exact: true });
      takeAsContext(st, i, n);
    }
  }
}

function takeNegations(st: ParseState): void {
  const { words, used, context, negated } = st;
  for (let i = 0; i < words.length; i++) {
    if (used[i] || !NEGATION_WORDS.has(words[i])) continue;
    used[i] = context[i] = true;
    let j = i + 1;
    for (; j < words.length && !used[j] && STOPWORDS.has(words[j]); j++) used[j] = context[j] = true;
    // Nothing after it: the word is dropped, which leaves more photos than guessing.
    if (j < words.length && !used[j]) negated.add(j);
  }
}

function takeStyles(st: ParseState): void {
  const { words, used, context, result, rewrites, negated, phraseAt, markUsed } = st;
  for (let n = MAX_STYLE_WORDS; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = phraseAt(i, n);
      const prompt = phrase ? STYLE_PROMPTS[phrase] : undefined;
      if (!phrase || !prompt || negated.has(i) || partOfName(st, i, n)) continue;
      if (phrase === "black and white") {
        // With anything else it's the animal's colours ("black and white bird"); alone it's the
        // style, with black-and-white animals mixed in below.
        const others = words.some((w, k) => (k < i || k >= i + n) && !used[k] && !context[k] && !STOPWORDS.has(w));
        if (others) continue;
        result.colorHint = ["black", "white"];
      }
      markUsed(i, n);
      rewrites.set(i, prompt);
      for (let k = i + 1; k < i + n; k++) context[k] = true;
      result.labels.styles.push(phrase === "bw" ? "b&w" : phrase);
      st.spans.push({ kind: "style", label: phrase === "bw" ? "b&w" : phrase, start: i, end: i + n, exact: false });
    }
  }
}

/** Whether query words name a camera model ("r5" in "Canon EOS R5m2", "iphone"). */
function fitsModel(model: string[], typed: string[]): boolean {
  const hasDigit = typed.some((w) => /\d/.test(w));
  // Plain words must start the model ("iphone", "canon"), so "pro" or "mark" never match alone.
  for (let k = 0; k + typed.length <= model.length && (hasDigit || k === 0); k++) {
    const last = typed.length - 1;
    const fits = typed.every(
      (w, j) =>
        model[k + j] === w ||
        // "r5" is the start of "r5m2" but not of "r50".
        (j === last && /\d/.test(w) && model[k + j].startsWith(w) && !/\d/.test(model[k + j][w.length])),
    );
    if (fits) return true;
  }
  return false;
}

function takeCameras(st: ParseState): void {
  const { result, species, phraseAt } = st;
  const models = (st.vocab.cameras ?? []).map((name) => ({ name, words: wordsOf(name) }));
  if (models.length === 0) return;
  const nameWords = new Set(species.flatMap((s) => s.primaryWords));
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= st.words.length; i++) {
      const typed = phraseAt(i, n)?.split(" ");
      if (!typed || typed.some((w) => STOPWORDS.has(w))) continue;
      // A bare number is a count, and a species word stays the species'.
      if (n === 1 && (/^\d+$/.test(typed[0]) || nameWords.has(typed[0]))) continue;
      const hits = models.filter((m) => fitsModel(m.words, typed)).map((m) => m.name);
      if (hits.length === 0) continue;
      result.cameras.push(...hits);
      result.labels.cameras.push(...hits);
      st.spans.push({ kind: "camera", label: hits.join(", "), start: i, end: i + n, exact: true });
      takeAsContext(st, i, n);
    }
  }
}

function takeBestWords(st: ParseState): void {
  const { words, used, context, result } = st;
  for (let i = 0; i < words.length; i++) {
    // "top of a tree" is a place in the picture, not a ranking.
    if (used[i] || !BEST_WORDS.has(words[i]) || (words[i] === "top" && words[i + 1] === "of")) continue;
    result.bestFirst = true;
    st.spans.push({ kind: "filter", label: words[i], start: i, end: i + 1, exact: true });
    used[i] = context[i] = true;
  }
  if (result.bestFirst) result.labels.order.push("best first");
}

// How sure a count word is: a number or quantity beats a group word ("group of three" is 3).
type CountGuess = Omit<CountFilter, "prompt"> & { rank: number };

function takeCounts(st: ParseState): void {
  const { words, used, context, result, species, rewrites } = st;
  const free = (i: number) => i < words.length && !used[i];
  const drop = (i: number) => (used[i] = context[i] = true);
  let guess: CountGuess | null = null;
  let first = -1;
  let last = -1;
  let groupWord: string | null = null;
  let animal: string | null = null;
  const take = (g: CountGuess, from: number, to: number) => {
    if (!guess || g.rank > guess.rank) guess = g;
    first = first < 0 ? from : Math.min(first, from);
    last = Math.max(last, to);
    for (let k = from; k <= to; k++) drop(k);
    // "group of", "pair of": the "of" goes with the count.
    if (words[to + 1] === "of" && free(to + 1)) {
      drop(to + 1);
      last = to + 1;
    }
  };

  // A collective noun with its own animal is a group of it: "murder of crows" is crows, 2+.
  for (let i = 0; i < words.length; i++) {
    const c = COLLECTIVES[words[i]];
    if (!c || used[i]) continue;
    const hasOf = words[i + 1] === "of" && free(i + 1) && i + 2 < words.length;
    const typed = hasOf ? words[i + 2] : null;
    if (typed && c.animals.some((a) => wordMatches(a, typed))) {
      words[i + 2] = c.group ?? COLLECTIVE_ANIMAL_NAMES[normalizeWordForm(typed)] ?? typed;
      animal = words[i + 2];
      take({ min: 2, max: null, about: null, crowd: false, rank: 0 }, i, i);
    } else if (!hasOf && !c.everyday && c.alone) {
      // Only a collective ("gaggle"): read as its animal, which the later stages pick.
      words[i] = animal = c.alone;
      guess ??= { min: 2, max: null, about: null, crowd: false, rank: 0 };
    } else {
      // An everyday word ("murder", "pride"), or the wrong animal ("murder of ducks"): the picture.
      if (c.prompt) rewrites.set(i, c.prompt);
      if (hasOf && c.prompt) context[i + 1] = true;
      if (!hasOf) {
        for (const s of species)
          if (s.primaryHead && c.animals.some((a) => wordMatches(a, s.primaryHead!))) result.hintSpeciesIds.add(s.id);
        result.hintMinCount = 2;
      }
    }
  }

  for (let i = 0; i < words.length; i++) {
    if (!free(i)) continue;
    const w = words[i];
    let n = /^\d{1,6}$/.test(w) ? Number(w) : (NUMBER_WORDS[w] ?? NUMBER_MULTIPLIERS[w] ?? null);
    if (n !== null && n > 0) {
      const times = !NUMBER_MULTIPLIERS[w] && free(i + 1) ? NUMBER_MULTIPLIERS[words[i + 1]] : undefined;
      if (times) n *= times;
      take({ ...countForNumber(n), rank: 1 }, i, times ? i + 1 : i);
      continue;
    }
    const quantity = QUANTITY_WORDS[w];
    if (quantity) {
      take({ min: quantity.min, max: quantity.max, about: null, crowd: !!quantity.crowd, rank: 1 }, i, i);
      continue;
    }
    const groupMin = GROUP_COUNT_WORDS[w] ?? GROUP_COUNT_WORDS[normalizeWordForm(w)];
    if (groupMin) {
      groupWord = normalizeWordForm(w);
      const huge = i > 0 && free(i - 1) && CROWD_ADJECTIVES.has(words[i - 1]);
      const crowd = countForNumber(100);
      take(
        huge ? { ...crowd, about: null, rank: 1 } : { min: groupMin, max: null, about: null, crowd: false, rank: 0 },
        huge ? i - 1 : i,
        i,
      );
    }
  }
  // Set inside take(), which TypeScript's narrowing can't see.
  const found = guess as CountGuess | null;
  if (!found) return;
  const count = { min: found.min, max: found.max, about: found.about, crowd: found.crowd };
  // The animal right after the count ("3 birds"), so CLIP looks for that many of it.
  const next = last >= 0 && last + 1 < words.length ? words[last + 1] : null;
  const noun = animal ?? (next && !STOPWORDS.has(next) ? next : null) ?? "animals";
  let phrase = first >= 0 && !animal ? words.slice(first, last + 1).join(" ") : "a group of";
  // "flock" on its own: "flock of animals".
  if (groupWord && normalizeWordForm(words[last]) === groupWord) phrase += " of";
  const prompt = count.crowd ? `a huge ${groupWord ?? "crowd"} of ${noun} filling the frame` : `${phrase} ${noun}`;
  result.count = { ...count, prompt };
  // Crowds and uncounted photos are judged by the picture, so a count is exact only as a number.
  if (first >= 0)
    st.spans.push({
      kind: "count",
      label: st.typed.slice(first, last + 1).join(" "),
      start: first,
      end: last + 1,
      exact: !count.crowd,
    });
}

function takeMultiWordSpecies(st: ParseState): void {
  const { used, subjects, species, nameOf, open } = st;
  // 3. Several words that fit one species together. A word after "not" is left out: "fox not
  //    arctic" is foxes minus the Arctic Fox, not the Arctic Fox.
  const openWords = open().filter(({ i }) => !st.negated.has(i));
  if (openWords.length >= 2) {
    let best = 0;
    const counts = new Map<string, number[]>();
    for (const s of species) {
      const hitIdx = openWords
        .filter(
          ({ w }) =>
            s.primaryWords.some((nw) => wordMatches(nw, w, true)) ||
            (!!s.primaryHead && endsNameWord(s.primaryHead, w)),
        )
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
}

function takeGroups(st: ParseState): void {
  const { words, subjects, vocab, phraseAt, markUsed } = st;
  // 4. Group words and Latin orders/families, longest phrase first.
  for (let n = MAX_GROUP_TERM_WORDS; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = phraseAt(i, n);
      // A single scene word ("flowers", "plants") means the scene, not the taxon.
      if (!phrase || (n === 1 && sceneFilter(phrase))) continue;
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
}

function takeScenes(st: ParseState): void {
  const { words, used, context, result, species, lastIndex, completion, negated, open } = st;
  // 5. Scene and colour words filter on the scene model, unless a species is named by the word.
  const sceneAt = new Map<number, SceneFilter>();
  for (const { w, i } of open()) {
    if (negated.has(i)) continue;
    const word = i === lastIndex && completion && sceneFilter(completion) ? completion : w;
    const scene = sceneFilter(word);
    if (!scene || species.some((s) => s.primaryHead && wordMatches(s.primaryHead, word))) continue;
    // A colour that starts a name ("purple") also finds those species, as the Collection does.
    const named = species.filter((s) => s.primaryWords.some((pw) => wordMatches(pw, w)));
    if (named.length > 0) scene.orSpecies = named.map((s) => s.id);
    let label = word;
    if (word !== w) {
      const others = completeSceneWords(w).filter((c) => c !== word);
      if (others.length > 0) scene.alternatives = others.map((c) => sceneFilter(c)!);
      const started = species.filter(
        (s) => s.primaryWords.some((pw) => pw.startsWith(w)) || s.sciWords.some((sw) => sw.startsWith(w)),
      );
      if (started.length > 0) scene.orSpecies = started.map((s) => s.id);
      label = [word, ...others].join(" or ");
    }
    // "snow or water": either one will do.
    const either = words[i - 1] === "or" ? sceneAt.get(i - 2) : undefined;
    if (either) {
      either.alternatives = [...(either.alternatives ?? []), scene];
      result.labels.scenes[result.labels.scenes.length - 1] += ` or ${label}`;
    } else {
      result.scenes.push(scene);
      result.labels.scenes.push(label);
    }
    // Merged into the part before when it's "snow or water".
    const prevSpan = either ? st.spans.find((x) => x.kind === "scene" && x.end === i - 1) : undefined;
    if (prevSpan) {
      prevSpan.end = i + 1;
      prevSpan.label += ` or ${label}`;
    } else st.spans.push({ kind: "scene", label, start: i, end: i + 1, exact: true });
    sceneAt.set(i, either ?? scene);
    used[i] = context[i] = true;
    if (i > 0 && !used[i - 1] && PLACE_PREPOSITIONS.has(words[i - 1])) used[i - 1] = context[i - 1] = true;
  }
}

function takeSpeciesWords(st: ParseState): void {
  const { words, used, subjects, result, species, lastIndex, completion, vocab, partialWordPicksSpecies, open } = st;
  // 6. Species-name words: the main noun picks species; a describing word is decided after.
  const modifiers: Array<{ i: number; w: string; ids: string[] }> = [];
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
    // A whole name word or picture word is complete, not the start of another ("water", not "waterfowl").
    const isWholeNameWord = species.some((s) => s.primaryWords.includes(w)) || PICTURE_WORDS.includes(w);
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
      picked = started;
      // In the full search a group from a partial word needs four letters: "car" shouldn't bring
      // in every carnivore.
      if (term && (partialWordPicksSpecies || w.length >= 4)) typedGroup = { ...GROUP_TERMS.get(term)!, label: term };
    }
    if (picked.length === 0 && !typedGroup && w.length >= 5)
      picked = species.filter((s) => s.primaryHead && wordMatches(s.primaryHead, w, true));
    // Compound names join whatever else the word found ("hawk": Goshawk beside the hawks).
    const compound = species.filter((s) => !picked.includes(s) && s.primaryHead && endsNameWord(s.primaryHead, w));
    picked = [...picked, ...compound];
    if (picked.length > 0 || typedGroup) {
      if (picked.length > 0) subjects.push({ start: i, end: i + 1, species: picked.map((s) => s.id), labels: [w] });
      if (typedGroup) subjects.push({ start: i, end: i + 1, group: typedGroup, labels: [typedGroup.label] });
      used[i] = true;
      continue;
    }
    const modifier = PICTURE_WORDS.includes(w)
      ? []
      : species.filter((s) => s.primaryWords.slice(0, -1).some((nw) => wordMatches(nw, w, w.length >= 6)));
    if (modifier.length > 0) {
      modifiers.push({ i, w, ids: modifier.map((s) => s.id) });
      continue;
    }
    if (
      vocab.catalogHeads &&
      !STOPWORDS.has(w) &&
      namesUnseenAnimal(w, i === lastIndex && !completion, vocab.catalogHeads)
    ) {
      subjects.push({ start: i, end: i + 1, species: [], labels: [w] });
      used[i] = true;
      continue;
    }
    if (st.negated.has(i)) continue;
    // A picture word that's also in a name ("flying" squirrel) only hints.
    for (const s of species.filter((s) => s.primaryWords.slice(0, -1).includes(w))) result.hintSpeciesIds.add(s.id);
  }
  // A describing word of a name picks those species when nothing else is named ("pileated") or
  // after "not" ("fox not arctic"); beside another subject it only hints.
  const named = subjects.some((s) => !st.negated.has(s.start));
  for (const m of modifiers) {
    if (!named || st.negated.has(m.i)) {
      subjects.push({ start: m.i, end: m.i + 1, species: m.ids, labels: [m.w] });
      used[m.i] = true;
    } else for (const id of m.ids) result.hintSpeciesIds.add(id);
  }
}

function keepSubjects(st: ParseState): void {
  const { words, used, context, subjects, result, negated } = st;
  // A subject after "not" or "without" is left out of the results.
  for (const sub of subjects.filter((x) => negated.has(x.start))) {
    if (sub.group) result.excludeGroups.push(sub.group);
    for (const id of sub.species ?? []) result.excludeSpeciesIds.add(id);
    result.labels.excluded.push(...sub.labels);
    for (let k = sub.start; k < sub.end; k++) context[k] = true;
    st.spans.push({ kind: "excluded", label: sub.labels.join(", "), start: sub.start, end: sub.end, exact: true });
  }
  // A subject after a description is the object of the action, not a second subject:
  // "heron catching fish" searches herons. "owls and hawks" keeps both.
  const named = subjects.filter((x) => !negated.has(x.start)).sort((a, b) => a.start - b.start);
  const kept: typeof subjects = [];
  for (const sub of named) {
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
    const kind = sub.group ? "group" : "species";
    // "owl" read as a group and as species: one part.
    const same = st.spans.find(
      (x) => (x.kind === "group" || x.kind === "species") && x.start === sub.start && x.end === sub.end,
    );
    if (same) same.label = [...new Set([same.label, ...sub.labels])].join(", ");
    else st.spans.push({ kind, label: sub.labels.join(", "), start: sub.start, end: sub.end, exact: true });
  }
  // An animal named with no photos of it keeps an empty subject: nothing matches.
  if (pickedSpecies.size > 0 || kept.some((sub) => sub.species?.length === 0)) result.speciesIds = pickedSpecies;
}

function describe(st: ParseState): void {
  const { words, used, context, result, lastIndex, completion, rewrites, negated } = st;
  // A last word of one or two letters is still being typed: too short to mean anything yet.
  if (lastIndex >= 0 && !used[lastIndex] && !context[lastIndex] && words[lastIndex].length < 3)
    used[lastIndex] = context[lastIndex] = true;
  // "without people": the picture words after it push those photos out instead.
  for (const start of negated) {
    let end = start;
    while (end < words.length && !used[end] && !context[end] && !STOPWORDS.has(words[end])) end++;
    if (end === start) continue;
    const phrase = words.slice(start, end).join(" ");
    result.excludeDescriptions.push(phrase);
    result.labels.excluded.push(phrase);
    for (let k = start; k < end; k++) used[k] = context[k] = true;
    st.spans.push({ kind: "excluded", label: phrase, start, end, exact: false });
  }
  // Words left over, in runs, are what the picture model reads ("stalking").
  const loose = (i: number) => !used[i] && !context[i] && !STOPWORDS.has(words[i]) && !FILLER_WORDS.has(words[i]);
  for (let i = 0; i < words.length; i++) {
    if (!loose(i) || JOINING_WORDS.has(words[i])) continue;
    let end = i + 1;
    while (end < words.length && loose(end) && !JOINING_WORDS.has(words[end])) end++;
    const label = words
      .slice(i, end)
      .map((w, k) => (i + k === lastIndex && completion ? completion : w))
      .join(" ");
    st.spans.push({ kind: "description", label, start: i, end, exact: false });
    i = end - 1;
  }
  // A description exists only when some words are left over, or a style asks for a look. It keeps
  // the subject words too, dropping only places, dates and their prepositions.
  if (words.some((w, i) => (!used[i] || rewrites.has(i)) && !context[i] && !STOPWORDS.has(w))) {
    result.description =
      words
        .map((w, i) => rewrites.get(i) ?? (i === lastIndex && completion && !used[i] ? completion : w))
        .filter((w, i) => !context[i] && !FILLER_WORDS.has(w))
        .join(" ")
        .trim() || null;
  }
}

/** Which kind of part a reading word is. */
function partKindOf(r: Reading): SearchPart["kind"] {
  const light = [
    "goldenHour",
    "blueHour",
    "twilight",
    "sunrise",
    "sunset",
    "night",
    "morning",
    "midday",
    "afternoon",
    "evening",
  ];
  const composition = [
    "ruleOfThirds",
    "goldenRatio",
    "centred",
    "smallInFrame",
    "frameFilling",
    "vertical",
    "horizontal",
  ];
  return light.includes(r) ? "light" : composition.includes(r) ? "composition" : "filter";
}

// What's behind the animal: "<words> in the background", "<words> behind (it)", "against <words>".
// The words are read against the photo's background vector, not used as a filter.
function takeBackgrounds(st: ParseState): void {
  const { words, used, context, result } = st;
  const free = (k: number) => k >= 0 && k < words.length && !used[k];
  const content = (k: number) =>
    free(k) &&
    !STOPWORDS.has(words[k]) &&
    !NEGATION_WORDS.has(words[k]) &&
    !JOINING_WORDS.has(words[k]) &&
    !BACKGROUND_AFTER.has(words[k]);
  for (let i = 0; i < words.length; i++) {
    if (!free(i)) continue;
    let from: number;
    let to: number;
    let spanStart: number;
    let spanEnd: number;
    // "hiding behind leaves" puts the leaves in front, so "behind" counts only at the end of a part.
    const behindEnds = words[i] !== "behind" || !content(i + 1) || BACKGROUND_PRONOUNS.has(words[i + 1]);
    if (BACKGROUND_AFTER.has(words[i]) && behindEnds) {
      // Back over "in the", then up to three words naming it.
      let k = i - 1;
      while (free(k) && STOPWORDS.has(words[k]) && words[k] !== "with") k--;
      to = k + 1;
      while (to - k <= MAX_BACKGROUND_WORDS && content(k)) k--;
      from = k + 1;
      spanStart = from;
      spanEnd = i + 1;
      if (words[i] === "behind" && free(i + 1) && BACKGROUND_PRONOUNS.has(words[i + 1])) spanEnd = i + 2;
    } else if (BACKGROUND_BEFORE.has(words[i])) {
      let k = i + 1;
      while (free(k) && STOPWORDS.has(words[k])) k++;
      from = k;
      while (k - from < MAX_BACKGROUND_WORDS && content(k)) k++;
      to = k;
      spanStart = i;
      // "against a snowy background": the word "background" goes with it.
      spanEnd = free(k) && BACKGROUND_AFTER.has(words[k]) && words[k] !== "behind" ? k + 1 : k;
    } else continue;
    if (to <= from) continue;
    const phrase = words.slice(from, to).join(" ");
    result.backgrounds = [...(result.backgrounds ?? []), phrase];
    st.spans.push({ kind: "background", label: phrase, start: spanStart, end: spanEnd, exact: false });
    for (let k = spanStart; k < spanEnd; k++) used[k] = context[k] = true;
    i = spanEnd - 1;
  }
}
