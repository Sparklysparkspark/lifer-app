// Matches the user's own iNaturalist observations to library photos. Two stages, both explainable:
// a cheap filter on what both already record (species, day and time, place), then the picture
// itself (CLIP similarity, see observationMatch.ts). Nothing here reads files or the network.
import { appearanceFromInatAnnotations, type LifeStage, type Sex } from "@lifer/shared";
import { observationPoint } from "./client.js";

/** One observation as Lifer keeps it (inaturalist_remote_observations.data). Also read by the
 *  named-places clustering, so the point, accuracy, geoprivacy and place text stay here. */
export interface RemoteObservation {
  id: string;
  taxonId: number | null;
  /** Below species (subspecies, variety): a finer name for a photo's species. */
  belowSpecies: boolean;
  /** The taxon's lineage, itself included. */
  ancestorIds: number[];
  /** Every taxon an identification named, with their lineages. */
  identTaxonIds: number[];
  /** The observed instant (ISO), and the same moment on the observation's own wall clock. */
  instant: string | null;
  wallClock: string | null;
  /** YYYY-MM-DD, also set when there's no time. */
  observedOn: string | null;
  point: { lat: number; lon: number } | null;
  accuracyM: number | null;
  geoprivacy: string | null;
  placeGuess: string | null;
  photos: Array<{ id: string; url: string | null; width: number | null; height: number | null }>;
  updatedAt: string;
  /** From its Life Stage and Sex annotations; given to the photos it's linked to that have none. */
  lifeStage?: LifeStage | null;
  sex?: Sex | null;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

/** "-07:00" as minutes, or null. */
function offsetMinutes(text: string | null): number | null {
  const m = text?.match(/([+-])(\d{2}):?(\d{2})$/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : text?.endsWith("Z") ? 0 : null;
}

/** One v1 /observations result, or null when it isn't one. */
export function parseObservation(raw: unknown): RemoteObservation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Raw;
  const id = num(o.id);
  if (id === null) return null;
  const taxon = (o.taxon ?? null) as Raw | null;
  const timeText = str(o.time_observed_at);
  const instantMs = timeText ? Date.parse(timeText) : NaN;
  // The wall clock in the observation's zone; the string usually carries that offset already.
  const offset = offsetMinutes(str(o.time_zone_offset)) ?? offsetMinutes(timeText);
  const wallClock =
    Number.isFinite(instantMs) && offset !== null
      ? new Date(instantMs + offset * 60_000).toISOString().slice(0, 19)
      : null;
  const point = observationPoint(o as Parameters<typeof observationPoint>[0]);
  const photos = Array.isArray(o.photos) ? (o.photos as Raw[]) : [];
  return {
    id: String(id),
    taxonId: num(taxon?.id),
    belowSpecies: (num(taxon?.rank_level) ?? 10) < 10,
    ancestorIds: ids(taxon?.ancestor_ids),
    identTaxonIds: ids(o.ident_taxon_ids),
    instant: Number.isFinite(instantMs) ? new Date(instantMs).toISOString() : null,
    wallClock,
    observedOn: str(o.observed_on)?.slice(0, 10) ?? wallClock?.slice(0, 10) ?? null,
    point,
    accuracyM: num(o.positional_accuracy),
    geoprivacy: str(o.geoprivacy),
    placeGuess: str(o.place_guess),
    photos: photos
      .filter((p) => num(p.id) !== null)
      .map((p) => {
        const dims = (p.original_dimensions ?? null) as Raw | null;
        return { id: String(p.id), url: str(p.url), width: num(dims?.width), height: num(dims?.height) };
      }),
    updatedAt: str(o.updated_at) ?? new Date(0).toISOString(),
    ...appearanceFromInatAnnotations(o.annotations),
  };
}

/** A small preview: "large" (1,024 px) to compare with local photos, never the original. */
export function previewUrl(url: string | null, size: "large" | "medium" = "large"): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !/(^|\.)inaturalist(-open-data\.s3\.amazonaws\.com|\.org)$/.test(u.hostname))
      return null;
  } catch {
    return null;
  }
  return url.replace(/\/(square|thumb|small|medium|large|original)\.(\w+)(\?.*)?$/, `/${size}.$2$3`);
}

export interface LocalCapture {
  id: string;
  taxonId: number | null;
  /** ISO. Not zoned: the camera's wall clock stored as UTC (uploads/exif.ts captureInstant). */
  takenAt: string | null;
  zoned: boolean | null;
  lat: number | null;
  lon: number | null;
  /** The upright display copy's size. */
  width: number | null;
  height: number | null;
}

export type TaxonMatch = "same" | "finer" | "related";

export function compareTaxon(taxonId: number | null, o: RemoteObservation): TaxonMatch | null {
  if (taxonId === null) return null;
  if (o.taxonId === taxonId) return "same";
  // A subspecies of the photo's species.
  if (o.ancestorIds.includes(taxonId)) return o.belowSpecies ? "finer" : "related";
  // Someone (often the user) named it so, but the observation's taxon differs or is broader.
  if (o.identTaxonIds.includes(taxonId)) return "related";
  return null;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Any mix of zones (UTC-12 to UTC+14) puts a wall clock and an instant at most this far apart.
const ZONE_WINDOW_MS = 14 * 60 * MINUTE;
const CLOSE_MS = 2 * MINUTE;

export type TimeMatch = "close" | "sameDay";

/** The capture's time against the observation's. "close": within two minutes (seconds are often
 *  dropped on iNaturalist). Otherwise the same day, allowing for a wrong zone on either side. */
export function compareTime(c: LocalCapture, o: RemoteObservation): { kind: TimeMatch; ms: number | null } | null {
  if (!c.takenAt) return null;
  const taken = Date.parse(c.takenAt);
  if (!Number.isFinite(taken)) return null;
  if (o.instant && o.wallClock) {
    const inst = Date.parse(o.instant);
    const wall = Date.parse(`${o.wallClock}Z`);
    // Zoned: a true instant. Not zoned: the wall clock read as UTC. Unknown (older imports): either.
    const diffs = c.zoned === true ? [taken - inst] : c.zoned === false ? [taken - wall] : [taken - inst, taken - wall];
    const best = Math.min(...diffs.map(Math.abs));
    if (best <= CLOSE_MS) return { kind: "close", ms: best };
    // Another zone on the camera or on iNaturalist: a generous window, not proof.
    return Math.abs(taken - inst) <= ZONE_WINDOW_MS || Math.abs(taken - wall) <= ZONE_WINDOW_MS
      ? { kind: "sameDay", ms: best }
      : null;
  }
  if (!o.observedOn) return null;
  // Only a day: that day or a neighbouring one, read either way.
  const day = Date.parse(`${o.observedOn}T00:00:00Z`);
  const takenDay = Date.parse(`${c.takenAt.slice(0, 10)}T00:00:00Z`);
  return Math.abs(takenDay - day) <= DAY ? { kind: "sameDay", ms: null } : null;
}

const FAR_KM = 50;
const NEAR_KM = 1;

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** Supporting only: "near" when both have a point close together, "far" rules a pair out. */
export function comparePlace(c: LocalCapture, o: RemoteObservation): "near" | "far" | null {
  if (c.lat === null || c.lon === null || !o.point) return null;
  const d = km({ lat: c.lat, lon: c.lon }, o.point);
  const slack = (o.accuracyM ?? 0) / 1000;
  if (d <= NEAR_KM + slack) return "near";
  return d > FAR_KM + slack ? "far" : null;
}

/** Supporting only: the same shape as one of the observation's photos, or not (a crop or edit). */
export function compareSize(c: LocalCapture, o: RemoteObservation): "same" | "different" | null {
  if (!c.width || !c.height) return null;
  const known = o.photos.filter((p) => p.width && p.height);
  if (known.length === 0) return null;
  const [long, short] = c.width >= c.height ? [c.width, c.height] : [c.height, c.width];
  // iNaturalist keeps at most 2,048 px; scaled to the same long edge, an uncropped copy is within a pixel or two.
  const same = known.some((p) => {
    const [pl, ps] = p.width! >= p.height! ? [p.width!, p.height!] : [p.height!, p.width!];
    return pl <= long + 1 && Math.abs((short * pl) / long - ps) <= 2;
  });
  return same ? "same" : "different";
}

export interface Evidence {
  taxon: TaxonMatch;
  time: TimeMatch;
  size: "same" | "different" | null;
  place: "near" | null;
}

/** The cheap filter: a possible pair, or null. Never species alone: a day is always needed. */
export function evidenceFor(c: LocalCapture, o: RemoteObservation): Evidence | null {
  const taxon = compareTaxon(c.taxonId, o);
  if (!taxon) return null;
  const time = compareTime(c, o);
  if (!time) return null;
  const place = comparePlace(c, o);
  if (place === "far") return null;
  return { taxon, time: time.kind, size: compareSize(c, o), place };
}

/** How alike two pictures are (CLIP cosine, 0 to 1), or null when they couldn't be compared. */
export type Similarity = number | null;

// From CLIP scores on real library photos and the real iNaturalist osprey preview: the same
// frame, downsized, re-encoded, re-exposed or cropped (with tiles), scored 0.93 to 0.99; another
// species at most 0.77. Neighbouring frames of one bird reach 0.98 too, so only the margin tells
// frames apart: where the wrong frame ranked first, it led by at most 0.023.
export const SAME = 0.93;
export const PROBABLY = 0.85;
export const MARGIN = 0.04;

export type Likeness = "same" | "probably";
export const likeness = (s: Similarity): Likeness | null =>
  s === null ? null : s >= SAME ? "same" : s >= PROBABLY ? "probably" : null;

export interface Candidate {
  captureId: string;
  evidence: Evidence;
  /** Best similarity to any of the observation's photos; null without the image model. */
  similarity: Similarity;
  /** Per observation photo, in order; empty when not compared. */
  perPhoto: number[];
  /** The user unlinked this pair once: offered for review, never linked by itself again. */
  noAuto?: boolean;
}

export interface Match extends Candidate {
  observationId: string;
}

/** Per observation: each of its photos links the one capture its picture clearly picks; close
 *  calls go to review; the rest are dropped. */
export function decide(
  observationId: string,
  candidates: Candidate[],
  /** How many more photos the observation can take; 0 when a close candidate wasn't fully compared. */
  capacity: number,
): { links: Match[]; review: Match[] } {
  const withId = candidates.map((c) => ({ ...c, observationId }));
  // Without image evidence nothing is linked, only offered, and only on a close time.
  if (withId.some((c) => c.similarity === null))
    return { links: [], review: withId.filter((c) => c.evidence.time === "close").slice(0, REVIEW_CAP) };
  const photos = Math.max(0, ...withId.map((c) => c.perPhoto.length));
  const links: Match[] = [];
  for (let j = 0; j < photos && links.length < capacity; j++) {
    const ranked = [...withId].sort((a, b) => (b.perPhoto[j] ?? -1) - (a.perPhoto[j] ?? -1));
    const [best, next] = ranked;
    const score = best.perPhoto[j] ?? -1;
    // A burst of near-identical frames leaves no clear winner: review shows them side by side.
    const clear = score - (next?.perPhoto[j] ?? -1) >= MARGIN;
    if (score >= SAME && clear && best.evidence.taxon !== "related" && !best.noAuto && !links.includes(best))
      links.push(best);
  }
  const linked = new Set(links.map((l) => l.captureId));
  const review = withId
    .filter((c) => !linked.has(c.captureId) && c.similarity! >= PROBABLY)
    .sort((a, b) => b.similarity! - a.similarity!);
  return { links, review: review.slice(0, REVIEW_CAP) };
}

const REVIEW_CAP = 6;

/** One capture belongs to one observation: a capture linked by two loses both links to review. */
export function settle(results: Array<{ links: Match[]; review: Match[] }>): { links: Match[]; review: Match[] } {
  const all = results.flatMap((r) => r.links);
  const count = new Map<string, number>();
  for (const l of all) count.set(l.captureId, (count.get(l.captureId) ?? 0) + 1);
  const links = all.filter((l) => count.get(l.captureId) === 1);
  const linked = new Set(links.map((l) => l.captureId));
  const review = [...all.filter((l) => count.get(l.captureId)! > 1), ...results.flatMap((r) => r.review)].filter(
    (r) => !linked.has(r.captureId),
  );
  return { links, review };
}

/** Candidates per observation from the cheap filter, for captures not linked yet. */
export function candidatePairs(
  captures: LocalCapture[],
  observations: RemoteObservation[],
  opts: { notMatches: Set<string>; skipObservations: Set<string>; perObservation?: number },
): Map<string, Array<{ capture: LocalCapture; evidence: Evidence }>> {
  const byTaxon = new Map<number, LocalCapture[]>();
  for (const c of captures) {
    if (c.taxonId === null || !c.takenAt) continue;
    const list = byTaxon.get(c.taxonId) ?? [];
    list.push(c);
    byTaxon.set(c.taxonId, list);
  }
  const out = new Map<string, Array<{ capture: LocalCapture; evidence: Evidence }>>();
  for (const o of observations) {
    if (opts.skipObservations.has(o.id) || o.photos.length === 0) continue;
    const seen = new Set<string>();
    const found: Array<{ capture: LocalCapture; evidence: Evidence; ms: number }> = [];
    for (const taxonId of new Set([o.taxonId, ...o.ancestorIds, ...o.identTaxonIds])) {
      for (const c of (taxonId === null ? null : byTaxon.get(taxonId)) ?? []) {
        if (seen.has(c.id) || opts.notMatches.has(`${c.id}:${o.id}`)) continue;
        seen.add(c.id);
        const evidence = evidenceFor(c, o);
        if (!evidence) continue;
        const t = compareTime(c, o)!;
        found.push({ capture: c, evidence, ms: t.ms ?? DAY });
      }
    }
    // A busy day can hold hundreds of frames: the nearest in time are compared first.
    found.sort((a, b) => a.ms - b.ms);
    if (found.length > 0) out.set(o.id, found.slice(0, opts.perObservation ?? 40));
  }
  return out;
}
