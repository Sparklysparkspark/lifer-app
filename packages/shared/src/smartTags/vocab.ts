// Smart tags vocabulary v1: data in vocab.json, rules in validateVocab. Species names are a separate
// system (Species|Class|Family|Name) and never appear here.
import vocabJson from "./vocab.json" with { type: "json" };

export const SMART_TAG_SIGNALS = ["computed", "scene", "clip", "manual"] as const;
export type SmartTagSignal = (typeof SMART_TAG_SIGNALS)[number];

export interface SmartTagGroup {
  id: string;
  /** Facet root: a container, never written flat. US spelling; rootUk where it differs. */
  root: string;
  rootUk?: string;
  /** pick-one always has a none-of-these option; many is capped per photo. */
  kind: "pick-one" | "many";
  cap: number;
  none: boolean;
  /** Where the suggestion pass must hold back: no species set, the animal crop, a person present, scene shares. */
  gate?: "noSpecies" | "crop" | "people" | "scene";
}

export interface SmartTagTerm {
  id: string;
  /** Facet path joined with "|", like Habitat|Wetland. */
  path: string;
  name: string;
  /** When to use the tag, written as the instruction the suggester and the reviewer both read. */
  usage: string;
  synonyms: string[];
  /** CLIP phrasings, US spelling. Empty for computed and manual terms. */
  prompts: string[];
  signal: SmartTagSignal;
  /** UK spelling of the display text, only where it differs; id and canonical (US) path stay the identity. */
  uk?: { name?: string; usage?: string };
  /** Which stored signal computes it (sun, date, colour, pixels, shotType, detector, person). */
  computed?: string;
  /** Scene model labels to read first (signal scene). */
  scene?: string[];
  group: string;
  /** True until calibration shows the term passes the 90 percent bar. */
  unvalidated: boolean;
  enabled: boolean;
}

export interface SmartTagVocab {
  version: number;
  groups: SmartTagGroup[];
  terms: SmartTagTerm[];
}

export const SMART_TAG_VOCAB = vocabJson as SmartTagVocab;

/** Lowercase letters and digits only, so "Great Blue-Heron" and "great blue heron" compare equal. */
export const nameKey = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

// shortcut: a word list, not a dictionary; add a pair when a UK spelling slips into the data.
const UK_TO_US: Array<[RegExp, string]> = [
  [/colour/g, "color"],
  [/grey/g, "gray"],
  [/harbour/g, "harbor"],
  [/behaviour/g, "behavior"],
  [/centred/g, "centered"],
  [/centre/g, "center"],
  [/neighbour/g, "neighbor"],
  [/favourite/g, "favorite"],
  [/flavour/g, "flavor"],
  [/honour/g, "honor"],
  [/labour/g, "labor"],
  [/vapour/g, "vapor"],
  [/metre/g, "meter"],
  [/fibre/g, "fiber"],
  [/theatre/g, "theater"],
  [/defence/g, "defense"],
  [/mould/g, "mold"],
  [/plough/g, "plow"],
  [/tyre/g, "tire"],
  [/aluminium/g, "aluminum"],
  [/armour/g, "armor"],
  [/(snorkel|travel|model|label|cancel)l(ed|ing|er)/g, "$1$2"],
  [
    /(?<![a-z])(organi|recogni|realize|summari|stabili|categori|minimi|maximi|util|apologi|criticis)s(e|ed|es|ing|ation)/g,
    "$1z$2",
  ],
];
export const usSpelling = (s: string) => UK_TO_US.reduce((acc, [re, to]) => acc.replace(re, to), s.toLowerCase());

export type Spelling = "us" | "uk";

// Regions that spell the American way; every other known region gets UK spelling, an unknown one US.
const US_SPELLING_REGIONS = new Set(["US", "PH", "PR", "GU", "VI", "AS", "MP", "UM"]);
/** Spelling for a locale tag like en-GB or de-DE: the region decides, unknown means US. */
export function spellingForLocale(tag: string | undefined | null): Spelling {
  if (!tag) return "us";
  try {
    const region = new Intl.Locale(tag).maximize().region;
    return region && !US_SPELLING_REGIONS.has(region) ? "uk" : "us";
  } catch {
    return "us";
  }
}

const groupOf = (vocab: SmartTagVocab, term: SmartTagTerm) => vocab.groups.find((g) => g.id === term.group);
export const smartTagLabel = (term: SmartTagTerm, spelling: Spelling) =>
  (spelling === "uk" && term.uk?.name) || term.name;
export const smartTagUsage = (term: SmartTagTerm, spelling: Spelling) =>
  (spelling === "uk" && term.uk?.usage) || term.usage;
/** The path to show or write in a spelling. Identity (stored decisions, sync) is always term.id. */
export function smartTagPath(term: SmartTagTerm, spelling: Spelling, vocab: SmartTagVocab = SMART_TAG_VOCAB): string {
  const parts = term.path.split("|");
  parts[parts.length - 1] = smartTagLabel(term, spelling);
  if (spelling === "uk") parts[0] = groupOf(vocab, term)?.rootUk ?? parts[0];
  return parts.join("|");
}
const pathKey = (p: string) =>
  p
    .split("|")
    .map((x) => nameKey(usSpelling(x)))
    .join("|");
/** The term a keyword path in either spelling stands for, so a region change never makes duplicates. */
export function findSmartTagByPath(path: string, vocab: SmartTagVocab = SMART_TAG_VOCAB): SmartTagTerm | undefined {
  const key = pathKey(path);
  return vocab.terms.find((t) => pathKey(t.path) === key);
}

/** The facet paths a term set implies: every parent, root first, with the leaf. */
export function allPaths(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("|");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("|"));
  }
  return out;
}

const EM_DASH = String.fromCharCode(0x2014);
const ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
// Same character rules as a written keyword: 1 to 64 characters, no | , or control characters, no edge spaces.
const labelProblem = (s: string) =>
  s.length < 1 || s.length > 64
    ? "must be 1 to 64 characters"
    : s !== s.trim()
      ? "has leading or trailing spaces"
      : // eslint-disable-next-line no-control-regex
        /[|,\u0000-\u001f\u007f]/.test(s)
        ? "has a pipe, comma or control character"
        : null;

/**
 * Every rule problem in a vocabulary, as readable strings (empty means valid). `reservedNames` holds
 * catalog species common names, scientific names and codes, in any form: a term name or synonym equal to
 * one would be mistaken for a species, so it never ships.
 */
export function validateVocab(vocab: SmartTagVocab, reservedNames: Iterable<string> = []): string[] {
  const errors: string[] = [];
  const err = (id: string, msg: string) => errors.push(`${id}: ${msg}`);
  const reserved = new Set<string>();
  for (const r of reservedNames) reserved.add(nameKey(r));
  const groups = new Map<string, SmartTagGroup>();
  for (const g of vocab.groups) {
    if (groups.has(g.id)) err(g.id, "duplicate group id");
    groups.set(g.id, g);
    if (labelProblem(g.root)) err(g.id, `root ${labelProblem(g.root)}`);
    if (usSpelling(g.root) !== g.root.toLowerCase()) err(g.id, "root must be the US spelling");
    if (g.rootUk && (g.rootUk === g.root || usSpelling(g.rootUk) !== g.root.toLowerCase()))
      err(g.id, "rootUk must differ from root only by spelling");
    if (!Number.isInteger(g.cap) || g.cap < 1) err(g.id, "cap must be a whole number of 1 or more");
    if (g.kind === "pick-one" && (g.cap !== 1 || !g.none)) err(g.id, "pick-one needs cap 1 and a none-of-these option");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const labelOwner = new Map<string, string>();
  for (const t of vocab.terms) {
    const id = t.id;
    if (!ID_RE.test(id)) err(id, "id must be lowercase words joined by dots");
    if (ids.has(id)) err(id, "duplicate id");
    ids.add(id);
    if (paths.has(t.path)) err(id, `duplicate path ${t.path}`);
    paths.add(t.path);

    const parts = t.path.split("|");
    for (const part of parts) {
      const p = labelProblem(part);
      if (p) err(id, `path part "${part}" ${p}`);
    }
    if (parts.length < 2) err(id, "path needs a facet root and a leaf");
    if (parts[parts.length - 1] !== t.name) err(id, "name must be the last path part");
    const group = groups.get(t.group);
    if (!group) err(id, `unknown group ${t.group}`);
    else if (group.root !== parts[0]) err(id, `path root ${parts[0]} is not the group root ${group.root}`);

    if (!t.usage || t.usage.trim().length < 20) err(id, "usage description missing or too short");
    if (!SMART_TAG_SIGNALS.includes(t.signal)) err(id, `unknown signal ${t.signal}`);
    if (t.signal === "computed" && !t.computed) err(id, "computed term needs a computed source");
    if (t.signal === "scene" && !t.scene?.length) err(id, "scene term needs scene labels");
    const needsPrompts = t.signal === "clip" || t.signal === "scene";
    if (needsPrompts && new Set(t.prompts).size < 3) err(id, "CLIP and scene terms need at least 3 distinct prompts");
    if (!needsPrompts && t.prompts.length) err(id, "only CLIP and scene terms carry prompts");
    if (t.unvalidated !== needsPrompts)
      err(id, "unvalidated must be true for CLIP and scene terms and false otherwise");
    if (t.enabled && t.signal !== "computed" && t.unvalidated) err(id, "an unvalidated term cannot start enabled");
    if (t.signal === "manual" && t.enabled) err(id, "a manual-only term is never suggested");
    if (usSpelling(t.name) !== t.name.toLowerCase()) err(id, "name must be the US spelling");
    const syns = new Set([t.name, ...t.synonyms].map((x) => x.toLowerCase()));
    for (const x of t.synonyms) if (!syns.has(usSpelling(x))) err(id, `synonym "${x}" needs its US spelling too`);
    if (t.uk?.name) {
      const u = t.uk.name;
      if (u === t.name || usSpelling(u) !== t.name.toLowerCase()) err(id, "uk.name must differ only by spelling");
      if (!syns.has(u.toLowerCase())) err(id, "uk.name must also be a synonym so either spelling finds the term");
      if (reserved.has(nameKey(u))) err(id, `"${u}" equals a catalog species name or code`);
    }
    if (t.uk?.usage && (t.uk.usage === t.usage || usSpelling(t.uk.usage) !== usSpelling(t.usage)))
      err(id, "uk.usage must differ only by spelling");
    for (const p of t.prompts) {
      if (usSpelling(p) !== p.toLowerCase()) err(id, `prompt "${p}" uses a UK spelling`);
    }

    // The same word in two terms is ambiguous for search; one term may list both spellings of itself.
    const mine = new Set<string>();
    for (const label of [t.name, ...t.synonyms]) {
      if (label !== label.trim() || !label) err(id, `label "${label}" is empty or has edge spaces`);
      const key = nameKey(usSpelling(label));
      if (!key) err(id, `label "${label}" has no letters`);
      if (reserved.has(nameKey(label)) || reserved.has(key))
        err(id, `"${label}" equals a catalog species name or code`);
      mine.add(key);
    }
    for (const key of mine) {
      const owner = labelOwner.get(key);
      if (owner && owner !== id) err(id, `name or synonym "${key}" is also used by ${owner}`);
      labelOwner.set(key, id);
    }
  }

  // A leaf is never also a container: its children would hide it.
  for (const t of vocab.terms) {
    const prefix = `${t.path}|`;
    if (vocab.terms.some((o) => o.path.startsWith(prefix))) err(t.id, "is both a tag and a parent of other tags");
  }
  if (JSON.stringify(vocab).includes(EM_DASH)) errors.push("vocabulary: contains an em dash");
  return errors;
}
