// A photo's values for the caption and file name templates (packages/shared/src/metadataTemplate.ts),
// and the file names those templates give.
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  TAXON_CLASS_LABEL,
  keepsOriginalName,
  renderTemplate,
  type TaxonClass,
  type TemplateValues,
} from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { photoPlaceForRegion } from "../regions/photoPlace.js";
import { sanitizeForFilesystem } from "./speciesFolderName.js";

export interface PhotoFacts {
  speciesId: string;
  takenAt: Date | null;
  /** The camera's own clock ("YYYY-MM-DDTHH:MM:SS"), which dates go by when known. */
  wallClock?: string | null;
  locationLabel: string | null;
  regionId: string | null;
  tripId: string | null;
  camera: string | null;
  lens: string | null;
  rating: number | null;
  /** The camera's file name without its extension. */
  original?: string | null;
}

export async function templateValues(f: PhotoFacts): Promise<TemplateValues> {
  const [speciesRes, place, tripRes] = await Promise.all([
    pool.query<{ common_name: string | null; scientific_name: string; taxon_class: string | null }>(
      `SELECT common_name, scientific_name, taxon_class FROM species WHERE id = $1`,
      [f.speciesId],
    ),
    photoPlaceForRegion(pool, f.regionId),
    f.tripId
      ? pool.query<{ name: string | null }>(`SELECT name FROM trips WHERE id = $1`, [f.tripId])
      : Promise.resolve(null),
  ]);
  const s = speciesRes.rows[0];
  const day = f.wallClock?.slice(0, 10) ?? f.takenAt?.toISOString().slice(0, 10) ?? null;
  return {
    species: s?.common_name ?? s?.scientific_name ?? null,
    scientific: s?.scientific_name ?? null,
    group: s?.taxon_class ? (TAXON_CLASS_LABEL[s.taxon_class as TaxonClass] ?? null) : null,
    place: f.locationLabel,
    region: place?.state ?? null,
    country: place?.country ?? null,
    date: day,
    year: day?.slice(0, 4) ?? null,
    month: day?.slice(5, 7) ?? null,
    trip: tripRes?.rows[0]?.name ?? null,
    camera: f.camera,
    lens: f.lens,
    rating: f.rating != null ? String(f.rating) : null,
    original: f.original ?? null,
  };
}

/** A capture's facts as stored, or null for a trashed or missing one. */
export async function captureFacts(captureId: string): Promise<PhotoFacts | null> {
  const res = await pool.query<{
    species_id: string;
    taken_at: Date | null;
    location_label: string | null;
    region_id: string | null;
    trip_id: string | null;
    camera_model: string | null;
    lens: string | null;
    quality_rating: number | null;
  }>(
    `SELECT species_id, taken_at, location_label, region_id, trip_id, camera_model, lens, quality_rating
       FROM captures_all WHERE id = $1 AND deleted_at IS NULL`,
    [captureId],
  );
  const c = res.rows[0];
  if (!c) return null;
  return {
    speciesId: c.species_id,
    takenAt: c.taken_at,
    locationLabel: c.location_label,
    regionId: c.region_id,
    tripId: c.trip_id,
    camera: c.camera_model,
    lens: c.lens,
    rating: c.quality_rating,
  };
}

// Leaves room for a collision suffix and the extension within the usual 255-byte name limit.
const MAX_STEM_BYTES = 180;
const SEQ_MARK = "LIFERSEQMARK";
const SEQ_WIDTH = 4;

function capBytes(stem: string): string {
  let out = stem;
  while (Buffer.byteLength(out) > MAX_STEM_BYTES) out = out.slice(0, -1);
  return sanitizeForFilesystem(out);
}

/** The template's file stem for these values, filesystem-safe; null when it comes out empty. */
export function renderFileStem(template: string, values: TemplateValues): string | null {
  return capBytes(sanitizeForFilesystem(renderTemplate(template, values))) || null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the stems this template gives these values with any running number, plus the "-2"
 *  a name collision adds, so a file already named this way keeps its name. */
export function stemPattern(template: string, values: TemplateValues): RegExp | null {
  const marked = renderFileStem(template, { ...values, seq: SEQ_MARK });
  if (!marked) return null;
  const parts = marked.split(SEQ_MARK).map(escapeRe);
  return new RegExp(`^${parts.join("(\\d+)")}(?:-\\d+)?$`, "i");
}

/** The next running number in `folder` for this template and photo, zero-padded. Counted per
 *  name, so each day and species in a folder numbers from 0001. */
export async function nextSeq(folder: string, template: string, values: TemplateValues): Promise<string> {
  const pattern = stemPattern(template, values);
  let max = 0;
  if (pattern) {
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      const m = pattern.exec(path.basename(name, path.extname(name)));
      if (m?.[1]) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(SEQ_WIDTH, "0");
}

/** The file name the user's template gives a file filed into `folder`, keeping its extension.
 *  Null when files keep the camera's name (the default), or the template comes out empty. */
export async function templatedFileName(
  template: string,
  folder: string,
  values: TemplateValues,
  extension: string,
): Promise<string | null> {
  if (keepsOriginalName(template)) return null;
  const seq = template.includes("{seq}") ? await nextSeq(folder, template, values) : null;
  const stem = renderFileStem(template, { ...values, seq });
  return stem ? `${stem}${extension}` : null;
}
