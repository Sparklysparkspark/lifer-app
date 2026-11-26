// Smart tags calibration (docs/plans/smart-tags.md, ST-0): labels and vocabulary parsing, session
// halves, per-term threshold fitting and the held-out report. Pure functions; the CLI in
// scripts/calibrate-smart-tags.ts does the file, model and database work.
import path from "node:path";
import type { SmartTagGroup, SmartTagVocab } from "@lifer/shared";

export interface VocabTerm {
  id: string;
  label: string;
  /** Facet root, the first segment of the term's path ("Habitat" for "Habitat|Wetland"). */
  facet: string;
  description: string;
  /** CLIP prompts, written in full. A term without any is computed or manual, never calibrated. */
  prompts: string[];
  /** Pick-one group id: the group's terms and its "none" option compete in one softmax. */
  pickOne?: string;
}

export interface Vocabulary {
  version: string;
  terms: VocabTerm[];
  /** Pick-one group id to its "none of these" prompts. */
  none: Record<string, string[]>;
}

/**
 * "None of these" prompts for the pick-one groups that have CLIP terms. The vocabulary only says a
 * group has a none option; a group may carry its own `nonePrompts` instead.
 */
export const DEFAULT_NONE_PROMPTS: Record<string, string[]> = {
  subject: ["a photo of a building", "a photo of a person", "a photo of a city street", "a photo of an object indoors"],
  context: [
    "a photo of a wild animal in nature",
    "a wildlife photo of an animal in its natural habitat",
    "a photo of a landscape",
  ],
  weather: ["a close-up photo with no sky visible", "a photo taken indoors"],
};

/** Reads the vocabulary (packages/shared/src/smartTags/vocab.json, plan section (h)). */
export function parseVocabulary(json: SmartTagVocab): Vocabulary {
  if (!Array.isArray(json?.terms) || !Array.isArray(json.groups)) throw new Error("Vocabulary needs terms and groups");
  const groups = new Map<string, SmartTagGroup & { nonePrompts?: string[] }>(json.groups.map((g) => [g.id, g]));
  const terms = json.terms.map((t) => {
    const g = groups.get(t.group);
    if (!g) throw new Error(`Vocabulary term ${t.id} names unknown group ${t.group}`);
    return {
      id: t.id,
      label: t.name,
      facet: t.path.split("|")[0],
      description: t.usage,
      prompts: t.prompts,
      pickOne: g.kind === "pick-one" ? g.id : undefined,
    };
  });
  const none: Record<string, string[]> = {};
  for (const g of groups.values()) {
    if (g.kind === "pick-one" && g.none) none[g.id] = g.nonePrompts ?? DEFAULT_NONE_PROMPTS[g.id] ?? [];
  }
  return { version: String(json.version), terms, none };
}

/** Terms the calibration scores: the ones with CLIP prompts. */
export const clipTerms = (vocab: Vocabulary): VocabTerm[] => vocab.terms.filter((t) => t.prompts.length > 0);

// ---- Labels file ----------------------------------------------------------------------------

export interface LabelRow {
  /** Path relative to the photos folder, or "ref:<id>" for a catalog reference photo. */
  photo: string;
  session: string;
  /** ISO capture time when known; used to keep bursts on one side of the split. */
  taken: string;
  present: string[];
  /** Term ids marked absent; "*" stands for every term not present. Empty with no present: skipped. */
  absent: string[] | "*";
}

export const LABELS_HEADER = "photo\tsession\ttaken\tpresent\tabsent";

const list = (s: string | undefined): string[] =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function parseLabels(text: string): LabelRow[] {
  const rows: LabelRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("photo\t")) continue;
    const [photo, session, taken, present, absent] = line.split("\t");
    if (!photo || !session) throw new Error(`Label row without photo or session: ${line}`);
    rows.push({
      photo,
      session,
      taken: taken ?? "",
      present: list(present),
      absent: absent?.trim() === "*" ? "*" : list(absent),
    });
  }
  return rows;
}

export function formatLabels(rows: LabelRow[]): string {
  const cell = (s: string) => s.replace(/[\t\r\n]/g, " ");
  const lines = rows.map((r) =>
    [r.photo, r.session, r.taken, r.present.join(","), r.absent === "*" ? "*" : r.absent.join(",")]
      .map(cell)
      .join("\t"),
  );
  return [LABELS_HEADER, ...lines].join("\n") + "\n";
}

/** true present, false absent, null not labelled for this term. */
export function labelFor(row: LabelRow, termId: string): boolean | null {
  if (row.present.includes(termId)) return true;
  if (row.absent === "*" || row.absent.includes(termId)) return false;
  return null;
}

// ---- Halves ---------------------------------------------------------------------------------

/** Photos in one folder taken this close together are one burst, so their sessions travel together. */
export const BURST_GAP_MS = 10_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Splits photos into halves 0 (fit) and 1 (held out) by whole session. Sessions joined by a burst
 * (same folder, within BURST_GAP_MS) count as one. Deterministic: groups are taken in hash order
 * and each goes to the half with fewer photos so far.
 */
export function splitHalves(rows: Pick<LabelRow, "photo" | "session" | "taken">[]): Map<string, 0 | 1> {
  const parent = new Map<string, string>();
  const find = (s: string): string => {
    let r = s;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(s, r);
    return r;
  };
  for (const r of rows) parent.set(r.session, r.session);
  const timed = rows
    .map((r) => ({ r, t: Date.parse(r.taken), dir: path.posix.dirname(r.photo) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.t - b.t);
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1];
    const b = timed[i];
    if (a.dir === b.dir && b.t - a.t <= BURST_GAP_MS) {
      const ra = find(a.r.session);
      const rb = find(b.r.session);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const g = find(r.session);
    groups.set(g, [...(groups.get(g) ?? []), r.photo]);
  }
  const size: [number, number] = [0, 0];
  const half = new Map<string, 0 | 1>();
  const ordered = [...groups.entries()].sort(([a], [b]) => hash(a) - hash(b) || a.localeCompare(b));
  for (const [, photos] of ordered) {
    const h: 0 | 1 = size[0] <= size[1] ? 0 : 1;
    size[h] += photos.length;
    for (const p of photos) half.set(p, h);
  }
  return half;
}

// ---- Scoring --------------------------------------------------------------------------------

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function meanUnit(vectors: ArrayLike<number>[]): number[] {
  const m = Array.from(vectors[0], (_, j) => vectors.reduce((s, v) => s + v[j], 0) / vectors.length);
  const n = Math.hypot(...m);
  return m.map((x) => x / n);
}

/** CLIP's logit scale, as in the measured pick-one experiment. */
const PICK_ONE_SCALE = 100;

/**
 * One photo's score per term. A free term scores its cosine similarity. A pick-one term scores its
 * softmax share against its group and the group's "none" option when it wins, else 0, the method
 * section "Measured" recommends.
 */
export function scorePhoto(
  vector: ArrayLike<number>,
  terms: VocabTerm[],
  termVectors: Map<string, number[]>,
  noneVectors: Map<string, number[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, VocabTerm[]>();
  for (const t of terms) {
    if (t.pickOne) groups.set(t.pickOne, [...(groups.get(t.pickOne) ?? []), t]);
    else out.set(t.id, dot(vector, termVectors.get(t.id)!));
  }
  for (const [g, members] of groups) {
    const logits = members.map((t) => dot(vector, termVectors.get(t.id)!) * PICK_ONE_SCALE);
    const none = noneVectors.get(g);
    if (none) logits.push(dot(vector, none) * PICK_ONE_SCALE);
    const max = Math.max(...logits);
    const exp = logits.map((x) => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    const win = logits.indexOf(max);
    members.forEach((t, i) => out.set(t.id, i === win ? exp[i] / sum : 0));
  }
  return out;
}

// ---- Fit and evaluate -----------------------------------------------------------------------

export interface Point {
  score: number;
  positive: boolean;
}

/** Fewest fit-half hits a threshold may rest on. */
export const MIN_FIT_HITS = 5;

/**
 * The lowest threshold whose hits on this half reach the target precision (at least MIN_FIT_HITS
 * of them), so recall is as high as the target allows. Tied scores fall on the same side. null
 * when no threshold reaches it.
 */
export function fitThreshold(points: Point[], target: number): number | null {
  const sorted = [...points].filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
  let tp = 0;
  let best: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].positive) tp++;
    if (i + 1 < sorted.length && sorted[i + 1].score === sorted[i].score) continue;
    if (i + 1 >= MIN_FIT_HITS && tp / (i + 1) >= target) best = sorted[i].score;
  }
  return best;
}

export interface HalfStats {
  /** Labelled photos for the term. */
  n: number;
  positives: number;
  predicted: number;
  precision: number | null;
  recall: number | null;
}

export function evaluate(points: Point[], threshold: number | null): HalfStats {
  const positives = points.filter((p) => p.positive).length;
  const hits = threshold == null ? [] : points.filter((p) => p.score >= threshold);
  const tp = hits.filter((p) => p.positive).length;
  return {
    n: points.length,
    positives,
    predicted: hits.length,
    precision: hits.length ? tp / hits.length : null,
    recall: positives ? tp / positives : null,
  };
}

export interface Settings {
  fitPrecision: number;
  bar: number;
  minPredicted: number;
}

export const DEFAULT_SETTINGS: Settings = { fitPrecision: 0.95, bar: 0.9, minPredicted: 50 };

export type Status = "passes" | "below bar" | "not measured" | "no threshold" | "no labels";

export interface TermResult {
  id: string;
  label: string;
  facet: string;
  pickOne: string | null;
  threshold: number | null;
  validated: boolean;
  status: Status;
  /** Held-out precision, recall and labelled count: the numbers that decide shipping. */
  precision: number | null;
  recall: number | null;
  n: number;
  heldOut: HalfStats;
  fit: HalfStats;
}

/** Fits every term on half 0 and judges it on half 1. */
export function calibrate(
  terms: VocabTerm[],
  rows: LabelRow[],
  scores: Map<string, Map<string, number>>,
  halves: Map<string, 0 | 1>,
  settings: Settings = DEFAULT_SETTINGS,
): TermResult[] {
  return terms.map((t) => {
    const sides: [Point[], Point[]] = [[], []];
    for (const r of rows) {
      const label = labelFor(r, t.id);
      const score = scores.get(r.photo)?.get(t.id);
      if (label == null || score == null) continue;
      sides[halves.get(r.photo) ?? 0].push({ score, positive: label });
    }
    const threshold = fitThreshold(sides[0], settings.fitPrecision);
    const fit = evaluate(sides[0], threshold);
    const heldOut = evaluate(sides[1], threshold);
    const status: Status =
      sides[0].length + sides[1].length === 0
        ? "no labels"
        : threshold == null
          ? "no threshold"
          : heldOut.predicted < settings.minPredicted
            ? "not measured"
            : (heldOut.precision ?? 0) >= settings.bar
              ? "passes"
              : "below bar";
    return {
      id: t.id,
      label: t.label,
      facet: t.facet,
      pickOne: t.pickOne ?? null,
      threshold,
      validated: status === "passes",
      status,
      precision: heldOut.precision,
      recall: heldOut.recall,
      n: heldOut.n,
      heldOut,
      fit,
    };
  });
}

// ---- Report ---------------------------------------------------------------------------------

const pct = (x: number | null) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);

export interface ReportContext {
  labelsFile: string;
  vocabVersion: string;
  settings: Settings;
  photos: [number, number];
  sessions: [number, number];
}

export function formatReport(results: TermResult[], ctx: ReportContext): string {
  const { settings: s } = ctx;
  const pass = results.filter((r) => r.validated);
  const head = [
    "Smart tags calibration",
    `Labels: ${ctx.labelsFile}`,
    `Vocabulary: ${ctx.vocabVersion}`,
    `Fit half: ${ctx.photos[0]} photos in ${ctx.sessions[0]} sessions. Held-out half: ${ctx.photos[1]} photos in ${ctx.sessions[1]} sessions.`,
    `Thresholds fitted to ${pct(s.fitPrecision)} precision on the fit half; a term passes at ${pct(s.bar)} held-out precision with at least ${s.minPredicted} held-out hits.`,
    `${pass.length} of ${results.length} terms pass: ${pass.map((r) => r.label).join(", ") || "none"}.`,
    `${results.filter((r) => r.status === "no labels").length} terms have no labels in this set and are left out below.`,
    "",
  ];
  const cols = [
    "Facet",
    "Term",
    "Status",
    "Threshold",
    "Fit P",
    "Fit R",
    "Fit hits",
    "Held P",
    "Held R",
    "Held hits",
    "Held n",
  ];
  const table = results
    .filter((r) => r.status !== "no labels")
    .sort((a, b) => a.facet.localeCompare(b.facet) || a.label.localeCompare(b.label))
    .map((r) => [
      r.facet,
      r.label,
      r.status,
      r.threshold == null ? "-" : r.threshold.toFixed(4),
      pct(r.fit.precision),
      pct(r.fit.recall),
      String(r.fit.predicted),
      pct(r.heldOut.precision),
      pct(r.heldOut.recall),
      String(r.heldOut.predicted),
      String(r.heldOut.n),
    ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...table.map((row) => row[i].length)));
  const line = (row: string[]) =>
    row
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [...head, line(cols), ...table.map(line), ""].join("\n");
}
