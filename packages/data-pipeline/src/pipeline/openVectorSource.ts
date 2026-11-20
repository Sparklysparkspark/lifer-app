// Pure parts of the open-vectors job (scripts/open-vectors.ts): which photos may be collected,
// how they are credited, which Lifer species an iNaturalist taxon is, which photos to pick, the
// resume state, and the PRVE file (open reference vectors format, version 1).
import { isOpenVectorLicense, normalizeLicense } from "@lifer/core/species/licensePolicy.js";
import { float16BitsToFloat32, float32ToFloat16Bits } from "@lifer/core/species/galleryEmbeddingsFormat.js";

/** PRVE licence code for a photo's own licence, or null when its vector may never be written.
 *  The Public Domain Mark has no PRVE code; like CC0 it carries no conditions, so it shares code 0.
 *  iNaturalist's codes carry no version and its licences are 4.0, so a bare CC BY is code 1. */
export function prveLicenseCode(license: string | null | undefined): 0 | 1 | 2 | null {
  if (!isOpenVectorLicense(license)) return null;
  const key = normalizeLicense(license!);
  if (key === "cc0" || key === "pd") return 0;
  return /-3\.0$/.test(license!) ? 2 : 1;
}

const LICENSE_LABEL: Record<string, string> = { cc0: "CC0", pd: "public domain", "cc-by": "CC BY" };

/** The credit line iNaturalist itself shows, in the format Lifer's gallery photos already use. */
export function attributionText(photographer: string, license: string): string {
  const key = normalizeLicense(license);
  if (key === "cc-by") return `(c) ${photographer}, some rights reserved (CC BY)`;
  if (key === "pd") return `${photographer}, no known copyright restrictions (public domain)`;
  return `(c) ${photographer}, no rights reserved (${LICENSE_LABEL[key] ?? license})`;
}

export interface LiferSpecies {
  scientificName: string;
  inatTaxonId: number | null;
  synonyms: string[];
}

/** iNaturalist taxon id to Lifer scientific name. A taxon id wins over a name; an id or name that
 *  points at two Lifer species is ambiguous and dropped. A name only maps a taxon onto a species
 *  that no taxon matched by id, so a split or a homonym never pours another taxon into it. */
export function mapTaxaToSpecies(
  species: LiferSpecies[],
  taxa: Array<{ taxonId: number; name: string }>,
): Map<number, string> {
  const byId = new Map<number, string | null>();
  for (const s of species) {
    if (s.inatTaxonId == null) continue;
    byId.set(s.inatTaxonId, byId.has(s.inatTaxonId) ? null : s.scientificName);
  }
  const byName = new Map<string, { name: string; synonym: boolean } | null>();
  const addName = (key: string, name: string, synonym: boolean) => {
    const k = key.toLowerCase();
    const prev = byName.get(k);
    if (prev === undefined) byName.set(k, { name, synonym });
    else if (prev && prev.name !== name) {
      // A species' own name beats another species' synonym; two of a kind are ambiguous.
      if (prev.synonym && !synonym) byName.set(k, { name, synonym });
      else if (prev.synonym === synonym) byName.set(k, null);
    }
  };
  for (const s of species) {
    addName(s.scientificName, s.scientificName, false);
    for (const syn of s.synonyms) addName(syn, s.scientificName, true);
  }
  const out = new Map<number, string>();
  const idMatched = new Set<string>();
  for (const t of taxa) {
    const name = byId.get(t.taxonId);
    if (name) {
      out.set(t.taxonId, name);
      idMatched.add(name);
    }
  }
  for (const t of taxa) {
    if (byId.has(t.taxonId) && byId.get(t.taxonId)) continue;
    const hit = byName.get(t.name.toLowerCase());
    if (!hit) continue;
    if (idMatched.has(hit.name)) continue;
    out.set(t.taxonId, hit.name);
  }
  return out;
}

export interface Candidate {
  photoId: number;
  extension: string;
  license: string;
  observerId: number;
  position: number;
  latitude: number | null;
  longitude: number | null;
  observedOn: string | null;
}

// Seasons in the same hemisphere-adjusted quarter count as one; a 10 degree cell is one place.
function seasonOf(c: Candidate): number | null {
  if (!c.observedOn) return null;
  const month = Number(c.observedOn.slice(5, 7)) - 1;
  if (!(month >= 0 && month < 12)) return null;
  const shifted = c.latitude != null && c.latitude < 0 ? (month + 6) % 12 : month;
  return Math.floor(shifted / 3);
}
function cellOf(c: Candidate): string | null {
  if (c.latitude == null || c.longitude == null) return null;
  return `${Math.floor(c.latitude / 10)},${Math.floor(c.longitude / 10)}`;
}

/** Every collectable candidate, best next pick first: each pick favours a new observer, then a
 *  new place and season, then an observation's first photo; ties keep the given order. The caller
 *  takes from the front until it has enough, so a photo that fails to download falls through. */
export function rankCandidates(candidates: Candidate[], exclude: ReadonlySet<number> = new Set()): Candidate[] {
  const pool = candidates.filter((c) => !exclude.has(c.photoId) && prveLicenseCode(c.license) !== null);
  const observers = new Set<number>();
  const cells = new Set<string>();
  const seasons = new Set<number>();
  const out: Candidate[] = [];
  while (pool.length) {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const cell = cellOf(c);
      const season = seasonOf(c);
      const score =
        (observers.has(c.observerId) ? 0 : 8) +
        (cell != null && !cells.has(cell) ? 2 : 0) +
        (season != null && !seasons.has(season) ? 2 : 0) +
        (c.position === 0 ? 1 : 0);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    const [c] = pool.splice(best, 1);
    observers.add(c.observerId);
    const cell = cellOf(c);
    if (cell != null) cells.add(cell);
    const season = seasonOf(c);
    if (season != null) seasons.add(season);
    out.push(c);
  }
  return out;
}

/** One line of rows.jsonl, the job's append-only record and resume state. */
export type StateLine =
  | {
      t: "photo";
      species: string;
      taxonId: number;
      photoId: number;
      photographer: string;
      license: string;
      attribution: string;
      sourceUrl: string;
      photoUrl: string;
      observedOn: string | null;
      latitude: number | null;
      longitude: number | null;
      /** float16 vector, base64 */
      v: string;
    }
  | { t: "failed"; species: string; photoId: number; reason: string }
  | { t: "done"; species: string; photos: number };

export type PhotoLine = Extract<StateLine, { t: "photo" }>;

export interface JobState {
  done: Set<string>;
  /** Photos already embedded per species. */
  have: Map<string, number>;
  /** Photo ids embedded or failed already, never fetched again. */
  tried: Set<number>;
}

/** Reads rows.jsonl. A line cut off by a crash is skipped; a species without its done line is
 *  resumed, counting the photos it already has. */
export function parseState(text: string): JobState {
  const state: JobState = { done: new Set(), have: new Map(), tried: new Set() };
  for (const raw of text.split("\n")) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.t === "done") state.done.add(line.species);
    else if (line.t === "failed") state.tried.add(line.photoId);
    else if (!state.tried.has(line.photoId)) {
      state.tried.add(line.photoId);
      state.have.set(line.species, (state.have.get(line.species) ?? 0) + 1);
    }
  }
  return state;
}

/** A species is worked on until done; a done one comes back while it has candidates and is short
 *  of the target, as when Lifer's own open gallery photos were removed after it was done. Only
 *  untried candidates are fetched, so nothing is redone. */
export function needsWork(state: JobState, species: string, liferOpenVectors: number, perSpecies: number, hasCandidates: boolean): boolean {
  if (!state.done.has(species)) return true;
  return hasCandidates && (state.have.get(species) ?? 0) + liferOpenVectors < perSpecies;
}

export function parseLine(raw: string): StateLine | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StateLine;
  } catch {
    return null;
  }
}

export function vectorToBase64(vector: ArrayLike<number>): string {
  const buf = Buffer.alloc(vector.length * 2);
  for (let i = 0; i < vector.length; i++) buf.writeUInt16LE(float32ToFloat16Bits(vector[i]), i * 2);
  return buf.toString("base64");
}

export const PRVE_MAGIC = "PRVE";

export interface PrveRow {
  species: string;
  licenseCode: number;
  photographer: string;
  sourceUrl: string;
  /** float16 bits, little-endian, 2 bytes per value */
  vector: Buffer;
}

function text(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  if (b.length > 0xffff) throw new Error(`text too long for PRVE: ${s.slice(0, 40)}...`);
  const len = Buffer.alloc(2);
  len.writeUInt16LE(b.length);
  return Buffer.concat([len, b]);
}

export function encodePrveHeader(modelVersion: string, dimension: number, rowCount: number): Buffer {
  const head = Buffer.alloc(12);
  head.write(PRVE_MAGIC, 0, "ascii");
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(dimension, 6);
  head.writeUInt32LE(rowCount, 8);
  return Buffer.concat([head, text(modelVersion)]);
}

/** One row. Refuses any row a conforming reader would reject. */
export function encodePrveRow(r: PrveRow, dimension: number): Buffer {
  if (!Number.isInteger(r.licenseCode) || r.licenseCode < 0 || r.licenseCode > 2)
    throw new Error(`closed licence code ${r.licenseCode} for ${r.species}`);
  if (r.vector.length !== dimension * 2) throw new Error(`vector of ${r.species} is not ${dimension} values`);
  return Buffer.concat([text(r.species), Buffer.from([r.licenseCode]), text(r.photographer), text(r.sourceUrl), r.vector]);
}

/** A whole PRVE version 1 file. */
export function encodePrve(modelVersion: string, dimension: number, rows: PrveRow[]): Buffer {
  return Buffer.concat([encodePrveHeader(modelVersion, dimension, rows.length), ...rows.map((r) => encodePrveRow(r, dimension))]);
}

/** Reads a PRVE version 1 file back the way a conforming reader must: exact length, open codes only. */
export function decodePrve(buf: Buffer): { modelVersion: string; dimension: number; rows: PrveRow[] } {
  if (buf.toString("ascii", 0, 4) !== PRVE_MAGIC) throw new Error("not a PRVE file");
  if (buf.readUInt16LE(4) !== 1) throw new Error(`unknown PRVE version ${buf.readUInt16LE(4)}`);
  const dimension = buf.readUInt16LE(6);
  const count = buf.readUInt32LE(8);
  let o = 12;
  const readText = () => {
    const n = buf.readUInt16LE(o);
    const s = buf.toString("utf8", o + 2, o + 2 + n);
    o += 2 + n;
    if (o > buf.length) throw new Error("PRVE file is truncated");
    return s;
  };
  const modelVersion = readText();
  const rows: PrveRow[] = [];
  for (let i = 0; i < count; i++) {
    const species = readText();
    const licenseCode = buf[o++];
    if (licenseCode > 2) throw new Error(`row ${i} has closed licence code ${licenseCode}`);
    const photographer = readText();
    const sourceUrl = readText();
    if (o + dimension * 2 > buf.length) throw new Error("PRVE file is truncated");
    rows.push({ species, licenseCode, photographer, sourceUrl, vector: buf.subarray(o, o + dimension * 2) });
    o += dimension * 2;
  }
  if (o !== buf.length) throw new Error(`PRVE file has ${buf.length - o} bytes past its last row`);
  return { modelVersion, dimension, rows };
}

export function prveVector(row: PrveRow): number[] {
  return Array.from({ length: row.vector.length / 2 }, (_, i) => float16BitsToFloat32(row.vector.readUInt16LE(i * 2)));
}
