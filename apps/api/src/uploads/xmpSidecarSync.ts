// Runs writeCaptureMetadata (exif.ts) on every managed original of a capture whenever its
// species, rating, cover status, tags or place name change.
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { renderFields, renderTemplate, type MetadataFields, type MetadataTemplate } from "@lifer/shared";
import { type PhotoCredits, type SpeciesMetadata, type TemplatedWrites, type XmpSidecarData } from "./exif.js";
import { photoPlaceForRegion } from "../regions/photoPlace.js";
import { getMetadataFields, getMetadataTemplate } from "../settings/metadataSettings.js";
import { captureFacts, templateValues } from "./templateVars.js";
import { getFileWriteSettings } from "../settings/fileWriteSettings.js";
import { writeOriginalMetadata } from "./fileWriting.js";

export interface CaptureTemplates {
  template: MetadataTemplate;
  fields: MetadataFields;
}

/** The user's copyright, Title, Headline, Caption and keyword templates filled for this capture.
 *  `credits` is undefined when they set none, so a write leaves those fields alone. */
export async function captureTemplated(
  userId: string,
  captureId: string,
  saved?: CaptureTemplates,
): Promise<{ credits?: PhotoCredits; fields: TemplatedWrites } | null> {
  const t = saved?.template ?? (await getMetadataTemplate(userId));
  const f = saved?.fields ?? (await getMetadataFields(userId));
  const facts = await captureFacts(captureId);
  if (!facts) return null;
  const values = await templateValues(facts, { multiSpecies: f.multiSpecies });
  const r = renderFields(f, values);
  const credits =
    t.creator || t.copyright || t.credit || t.usageTerms
      ? {
          creator: renderTemplate(t.creator, values),
          copyright: renderTemplate(t.copyright, values),
          credit: renderTemplate(t.credit, values),
          usageTerms: renderTemplate(t.usageTerms, values),
          replaceExisting: t.replaceExisting,
        }
      : undefined;
  return {
    credits,
    fields: {
      title: { value: r.title, rule: f.title.rule },
      headline: { value: r.headline, rule: f.headline.rule },
      caption: { value: r.caption, rule: f.caption.rule },
      keywords: { values: r.keywords, rule: f.keywords.rule },
    },
  };
}

/** `replacePlace`: the capture's region was just changed in Lifer, so the files' location fields
 *  are rewritten to match instead of only filled where empty. `replaceLabel`: the place name was
 *  just changed or removed, so a file's Sublocation is cleared when the capture has none. */
export async function syncCaptureXmpSidecars(userId: string, captureId: string, opts: SyncOptions = {}): Promise<void> {
  const settings = await getFileWriteSettings(userId);
  const write = await captureWriteData(userId, captureId, { ...opts, linked: settings.linkedFolders });
  if (!write) return;
  // One file failing (read-only, removed meanwhile) mustn't stop the others being written.
  await Promise.all(
    write.originals.map((o) =>
      writeOriginalMetadata(o.ref, o.managed, { ...write.data, originalId: o.id }, settings).catch((err) =>
        log.warn(
          { captureId, ref: o.ref, err: err instanceof Error ? err.message : err },
          "Couldn't write this capture's metadata into a file",
        ),
      ),
    ),
  );
}

// `linked`: linked files are listed too (fileWriting.ts gives them sidecars only).
type SyncOptions = { replacePlace?: boolean; replaceLabel?: boolean; replaceGps?: boolean; linked?: boolean };

/** Everything a write puts into a capture's managed files, and those files; null when it has none. */
export async function captureWriteData(
  userId: string,
  captureId: string,
  opts: SyncOptions = {},
  saved?: CaptureTemplates,
): Promise<{ originals: { id: string; ref: string; managed: boolean }[]; data: XmpSidecarData } | null> {
  const originalsRes = await pool.query<{ id: string; ref: string; managed: boolean }>(
    `SELECT id, ref, managed FROM originals WHERE capture_id = $1 AND (managed = true OR $2::boolean)`,
    [captureId, opts.linked === true],
  );
  if (originalsRes.rows.length === 0) return null;

  const captureRes = await pool.query<{
    quality_rating: number | null;
    cull_verdict: string | null;
    taken_at: Date | null;
    lat: number | null;
    lon: number | null;
    camera_model: string | null;
    lens: string | null;
    focal_length_mm: string | null;
    aperture: string | null;
    shutter: string | null;
    iso: number | null;
    species_id: string;
    cover_photo_id: string | null;
    tags: string[];
    region_id: string | null;
    location_label: string | null;
  }>(
    `SELECT c.quality_rating, c.cull_verdict, c.taken_at, c.lat, c.lon, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
            c.species_id, us.cover_photo_id, c.tags, c.region_id, c.location_label
     FROM captures_all c
     LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
     -- Hidden photos included: their files carry Lifer's tags like any other.
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [captureId],
  );
  const capture = captureRes.rows[0];
  if (!capture) return null;
  const templated = await captureTemplated(userId, captureId, saved);

  const isCover =
    capture.cover_photo_id != null &&
    (await pool.query(`SELECT 1 FROM photos WHERE id = $1 AND capture_id = $2`, [capture.cover_photo_id, captureId]))
      .rowCount! > 0;

  const speciesRes = await pool.query<SpeciesMetadata>(
    `SELECT s.id, s.common_name AS "commonName", s.scientific_name AS "scientificName", s.taxon_class AS "taxonClass",
            s.taxon_order AS "taxonOrder", s.family, s.aba_code AS "abaCode", s.ebird_code AS "ebirdCode"
     FROM species s WHERE s.id = $1
     UNION ALL
     SELECT s.id, s.common_name AS "commonName", s.scientific_name AS "scientificName", s.taxon_class AS "taxonClass",
            s.taxon_order AS "taxonOrder", s.family, s.aba_code AS "abaCode", s.ebird_code AS "ebirdCode"
     FROM species s JOIN capture_species cs ON cs.species_id = s.id WHERE cs.capture_id = $2`,
    [capture.species_id, captureId],
  );
  const namingStyleRes = await pool.query<{ species_naming_styles: string[] }>(
    `SELECT species_naming_styles FROM users WHERE id = $1`,
    [userId],
  );

  const data: XmpSidecarData = {
    species: speciesRes.rows,
    namingStyles: namingStyleRes.rows[0]?.species_naming_styles ?? [],
    // Unrated in Lifer but rejected in a culling app: the file's own rating stays, so a
    // "Rating -1" reject isn't erased from Lifer's copy.
    rating: capture.quality_rating ?? (capture.cull_verdict === "reject" ? undefined : null),
    isCover,
    takenAt: capture.taken_at,
    // numeric arrives as a string.
    lat: capture.lat != null ? Number(capture.lat) : null,
    lon: capture.lon != null ? Number(capture.lon) : null,
    cameraModel: capture.camera_model,
    lens: capture.lens,
    focalLengthMm: capture.focal_length_mm != null ? Number(capture.focal_length_mm) : null,
    aperture: capture.aperture != null ? Number(capture.aperture) : null,
    shutter: capture.shutter,
    iso: capture.iso,
    // Free-form photo tags, as plain keywords other tools show (exif.ts keeps them apart from
    // the keywords those tools added).
    tags: capture.tags,
    place: await photoPlaceForRegion(pool, capture.region_id),
    replacePlace: opts.replacePlace,
    replaceGps: opts.replaceGps,
    // Without a name of its own in Lifer, a file's Sublocation (typed in Lightroom) stays.
    locationLabel: capture.location_label ?? (opts.replaceLabel ? null : undefined),
    // Title and caption follow species and place changes, since every change comes through here.
    credits: templated?.credits,
    fields: templated?.fields,
  };
  return { originals: originalsRes.rows, data };
}

// Best-effort variant for callers that shouldn't fail on a sidecar write, but where a failure
// should still show up in the logs instead of letting sidecars drift silently.
export async function syncCaptureXmpSidecarsLogged(
  userId: string,
  captureId: string,
  opts: SyncOptions = {},
): Promise<void> {
  try {
    await syncCaptureXmpSidecars(userId, captureId, opts);
  } catch (err) {
    log.warn({ captureId, err: err instanceof Error ? err.message : err }, "Couldn't sync the XMP sidecar");
  }
}
