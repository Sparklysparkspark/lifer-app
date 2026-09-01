// Rebuilds captures/photos/user_species/originals from a species-organized ORIGINALS_DIR tree
// that's already on disk but has no database rows pointing at it — the fresh-install/migrated-
// server recovery path for the main library (Trips has its own separate, smaller recovery
// story — see trips/tripIndex.ts's own comment on why that one needs a hidden sidecar file
// instead: a Trip's source folder isn't Lifer's own organized tree, so it has no embedded-
// metadata-plus-folder-structure combination this reimport tool otherwise relies on).
//
// Every managed JPEG already carries its own species in embedded metadata (writeSpeciesMetadata,
// uploads/exif.ts) specifically for this scenario — folder names are NEVER trusted as the
// source of truth (no DB uniqueness on common_name, so two species could historically have
// shared one — see speciesFolderName.ts), only as a last-resort tiebreaker for the one case
// embedded metadata alone can't resolve on its own: a multi-species photo (secondary species
// tagging embeds every tagged name into the same flat Keywords/Subject list, with no tag
// distinguishing which one is primary). A file's own folder was chosen for its PRIMARY species
// at upload time and never moves after that (secondary tagging only edits metadata, never
// relocates the file — see captures/routes.ts's resyncSpeciesMetadata), so "which of these
// candidate species does this file's own folder resolve to" is a real, deterministic signal,
// not a guess — reusing speciesFolderName.ts's own resolver keeps the tiebreak logic identical
// to how that folder was written in the first place.
//
// Species ids are NOT stable across a fresh reseed (only gbif_key is UNIQUE — see
// tripIndex.ts's identical note), so every match here goes through scientific_name, and a
// scientific_name shared by more than one species row is flagged as ambiguous rather than
// guessed, same rule as everywhere else this matters.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../db.js";
import { generateDerivatives } from "../uploads/image.js";
import { extractExif, extractKeywords, readExifTags, type ExifTags } from "../uploads/exif.js";
import { computeContentHash, computeFileFingerprint } from "../uploads/fileFingerprint.js";
import { resolveSpeciesFolderName } from "../uploads/speciesFolderName.js";
import { RAW_EXTENSIONS } from "../uploads/rawExtensions.js";
import { matchSpeciesByKeywords, groupByScientificName } from "../species/matchByKeywords.js";
import { moveManagedOriginalToSpeciesFolder } from "../uploads/routes.js";

const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);

export interface LibraryFiles {
  jpegs: string[];
  raws: string[];
}

// Recursive, depth-agnostic walk — works identically for the default <species>/RAW|Adjusted
// layout and the opt-in year-organized Wildlife <year>/<taxon>/<species>/RAW|Adjusted layout
// (organizedPath.ts), since files are bucketed by extension, never by how deep they sit.
export function listManagedFiles(originalsDir: string): LibraryFiles {
  const jpegs: string[] = [];
  const raws: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (JPEG_EXTENSIONS.has(ext)) jpegs.push(absolutePath);
      else if (RAW_EXTENSIONS.has(ext)) raws.push(absolutePath);
    }
  }
  walk(originalsDir);
  return { jpegs, raws };
}

interface SpeciesRow {
  id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  family: string | null;
}

export type JpegOutcome =
  | { status: "recovered"; captureId: string; photoId: string; scientificName: string }
  | { status: "already-known" }
  | { status: "relinked" }
  | { status: "ignored" }
  | { status: "unrecognized"; candidates: string[]; contentHash: string }
  | { status: "ambiguous"; scientificNames: string[]; contentHash: string };

// One-time "don't ask about this file again" mark (migration 063) — keyed by content hash so
// it survives the file being moved/renamed, checked before any keyword matching runs so an
// ignored file never even gets reported as unrecognized/ambiguous again.
export async function isIgnoredLibraryFile(userId: string, contentHash: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM ignored_library_files WHERE user_id = $1 AND content_hash = $2`, [
    userId,
    contentHash,
  ]);
  return res.rows.length > 0;
}

export async function ignoreLibraryFile(userId: string, contentHash: string): Promise<void> {
  await pool.query(
    `INSERT INTO ignored_library_files (user_id, content_hash) VALUES ($1, $2)
     ON CONFLICT (user_id, content_hash) DO NOTHING`,
    [userId, contentHash],
  );
}

/** Where a reimport walk is pointed and, if it's a registered external drive rather than the
 *  primary library, how to tag newly-recovered/repaired originals with that drive. Passed
 *  through from library/routes.ts's job, which resolves it once per run (see
 *  storageVolumes/resolve.ts's resolveChosenVolumeDestination — same helper the upload picker
 *  uses, since "which drive is this file really on" is the same question either way). */
export interface VolumeContext {
  volumeId: string;
  baseDir: string;
  mountPath: string;
}

// A file whose bytes are already known (same content_hash as some existing original) isn't
// necessarily fully up to date — its `ref` might point at a stale absolute path left over
// from before a drive was unplugged/reconnected under a different mount name, or removed and
// re-registered somewhere reimport's own path-prefix re-adoption (storageVolumes/routes.ts)
// couldn't catch. Repairs that in place instead of silently doing nothing, which is exactly
// what "already-known" used to mean for every case. Returns true if a repair was actually made.
async function repairIfStale(
  existingId: string,
  existingRef: string,
  existingVolumeId: string | null,
  absolutePath: string,
  volumeContext: VolumeContext | null,
): Promise<boolean> {
  const wantVolumeId = volumeContext?.volumeId ?? null;
  if (existingRef === absolutePath && existingVolumeId === wantVolumeId) return false;
  const volumeRelativePath = volumeContext ? absolutePath.slice(volumeContext.mountPath.length) : null;
  await pool.query(
    `UPDATE originals SET ref = $1, volume_id = $2, volume_relative_path = $3, last_seen_at = now() WHERE id = $4`,
    [absolutePath, wantVolumeId, volumeRelativePath, existingId],
  );
  return true;
}

// Only reached when embedded keywords matched more than one distinct scientific name — picks
// whichever one this file's OWN folder was actually written for (see this file's top comment).
async function findRowMatchingFolder(absolutePath: string, byName: Map<string, SpeciesRow[]>): Promise<SpeciesRow[] | null> {
  const parentFolder = path.basename(path.dirname(path.dirname(absolutePath)));
  for (const rows of byName.values()) {
    const folderName = await resolveSpeciesFolderName(rows[0].common_name, rows[0].scientific_name);
    if (folderName === parentFolder) return rows;
  }
  return null;
}

// `organize` is the "file this into a species folder" opt-in used by importing a library from
// a different source/sorting system (settings/library import UI) — the default reimport flow
// (recovering Lifer's OWN previously-organized tree after a fresh install) never needs it,
// since those files are already exactly where they belong. When true, `organizeByYear` mirrors
// the user's normal upload preference (users.organize_originals_by_year) and the recovered
// file is physically relocated into the same <taxon>/<species>/Adjusted layout a normal upload
// would use (see moveManagedOriginalToSpeciesFolder) — always under the primary library
// (ORIGINALS_DIR), never a registered external volume, since "organize into my library" and
// "this lives on a separate drive" are different, unrelated choices.
export async function recoverJpeg(
  userId: string,
  absolutePath: string,
  volumeContext: VolumeContext | null = null,
  organize = false,
  organizeByYear = false,
): Promise<JpegOutcome> {
  const contentHash = computeContentHash(absolutePath);
  const known = await pool.query<{ id: string; ref: string; volume_id: string | null }>(
    `SELECT id, ref, volume_id FROM originals WHERE content_hash = $1 LIMIT 1`,
    [contentHash],
  );
  if (known.rows.length > 0) {
    const row = known.rows[0];
    const repaired = await repairIfStale(row.id, row.ref, row.volume_id, absolutePath, volumeContext);
    return { status: repaired ? "relinked" : "already-known" };
  }

  if (await isIgnoredLibraryFile(userId, contentHash)) return { status: "ignored" };

  const tags: ExifTags = await readExifTags(absolutePath);
  const candidates = await extractKeywords(absolutePath, tags);
  if (candidates.length === 0) return { status: "unrecognized", candidates: [], contentHash };

  // See matchSpeciesByKeywords for what counts as a match (common name, alias, or a
  // superseded scientific name via species_synonyms, not just the current scientific name).
  const matchedRows = await matchSpeciesByKeywords(pool, candidates);
  if (matchedRows.length === 0) return { status: "unrecognized", candidates, contentHash };

  const byName = groupByScientificName(matchedRows);

  let primaryRows: SpeciesRow[];
  if (byName.size === 1) {
    primaryRows = [...byName.values()][0];
  } else {
    const matched = await findRowMatchingFolder(absolutePath, byName);
    if (!matched) return { status: "ambiguous", scientificNames: [...byName.keys()], contentHash };
    primaryRows = matched;
  }

  if (primaryRows.length > 1) {
    // The SAME scientific_name shared by more than one species row — a real data-quality
    // collision, not something safe to break the tie on by picking the first one.
    return { status: "ambiguous", scientificNames: [primaryRows[0].scientific_name], contentHash };
  }
  const species = primaryRows[0];

  const exif = await extractExif(absolutePath, tags);
  const { exifFingerprint } = await computeFileFingerprint(absolutePath, tags);
  const buffer = readFileSync(absolutePath);

  const finalPath = organize
    ? await moveManagedOriginalToSpeciesFolder(
        absolutePath,
        true,
        species.common_name,
        species.scientific_name,
        "jpeg",
        organizeByYear,
        species.taxon_class,
        exif.takenAt,
      )
    : absolutePath;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const captureRes = await client.query<{ id: string }>(
      `INSERT INTO captures
         (user_id, species_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon, camera_model, lens, focal_length_mm, aperture, shutter, iso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        userId,
        species.id,
        contentHash,
        exifFingerprint.strict,
        exifFingerprint.loose,
        exif.takenAt,
        exif.lat,
        exif.lon,
        exif.cameraModel,
        exif.lens,
        exif.focalLengthMm,
        exif.aperture,
        exif.shutter,
        exif.iso,
      ],
    );
    const captureId = captureRes.rows[0].id;

    const photoId = randomUUID();
    const { displayPath, thumbPath, width, height } = await generateDerivatives(buffer, photoId);
    const photoRes = await client.query<{ id: string }>(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [photoId, captureId, displayPath, thumbPath, width, height],
    );
    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoRes.rows[0].id, captureId]);

    // Same "this photo now counts as collected" behavior as a normal upload.
    await client.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
       VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
       ON CONFLICT (user_id, species_id) DO UPDATE SET
         state = 'collected',
         cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
      [userId, species.id, photoRes.rows[0].id, exif.takenAt],
    );

    // managed=true, ref=finalPath — for the default (organize=false) reimport-of-Lifer's-own-
    // tree case, finalPath === absolutePath (already exactly where a normal upload would have
    // written it, recovering it is never a copy or a move); for an organize=true foreign-
    // library import, finalPath is the just-relocated destination inside the primary library,
    // so volumeContext never applies here (see this fn's own comment on organize above).
    await client.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path)
       VALUES ($1, 'jpeg', 'path', $2, true, $3, $4, $5, $6, $7, $8)`,
      [
        captureId,
        finalPath,
        contentHash,
        buffer.length,
        exifFingerprint.strict,
        exifFingerprint.loose,
        organize ? null : (volumeContext?.volumeId ?? null),
        organize ? null : volumeContext ? absolutePath.slice(volumeContext.mountPath.length) : null,
      ],
    );

    await client.query("COMMIT");
    return { status: "recovered", captureId, photoId: photoRes.rows[0].id, scientificName: species.scientific_name };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type RawOutcome =
  | { status: "recovered"; captureId: string }
  | { status: "already-known" }
  | { status: "relinked" }
  | { status: "unmatched" };

function sanitizeFilenameStem(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

// Filename-stem + EXIF-timestamp match only, against JPEG captures already recovered by this
// same reimport run (or from a prior run — the query isn't scoped to "just now", so a
// re-run naturally picks up RAWs whose JPEG sibling only just became a real capture).
// Deliberately no fingerprint fallback in this first pass, same call already made for Trips'
// own import (trips/import.ts's top comment) — an unmatched RAW is left for the existing
// per-species "Choose RAW files…" manual flow rather than guessed at.
export async function recoverRaw(
  userId: string,
  absolutePath: string,
  volumeContext: VolumeContext | null = null,
  organize = false,
  organizeByYear = false,
): Promise<RawOutcome> {
  const contentHash = computeContentHash(absolutePath);
  const known = await pool.query<{ id: string; ref: string; volume_id: string | null }>(
    `SELECT id, ref, volume_id FROM originals WHERE content_hash = $1 LIMIT 1`,
    [contentHash],
  );
  if (known.rows.length > 0) {
    const row = known.rows[0];
    const repaired = await repairIfStale(row.id, row.ref, row.volume_id, absolutePath, volumeContext);
    return { status: repaired ? "relinked" : "already-known" };
  }

  const tags = await readExifTags(absolutePath);
  const exif = await extractExif(absolutePath, tags);
  if (!exif.takenAt) return { status: "unmatched" };

  const stem = sanitizeFilenameStem(path.basename(absolutePath, path.extname(absolutePath))).toLowerCase();
  if (!stem) return { status: "unmatched" };

  const candidates = await pool.query<{
    id: string;
    taken_at: string | null;
    common_name: string | null;
    scientific_name: string;
    taxon_class: string | null;
  }>(
    `SELECT c.id, c.taken_at, s.common_name, s.scientific_name, s.taxon_class
     FROM captures c
     JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
     JOIN species s ON s.id = c.species_id
     WHERE c.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')
       AND lower(regexp_replace(regexp_replace(o.ref, '^.*/', ''), '(-[0-9]+)?\.[^.]+$', '')) = $2`,
    [userId, stem],
  );
  if (candidates.rows.length !== 1) return { status: "unmatched" };
  const match = candidates.rows[0];
  if (!match.taken_at || Math.abs(new Date(match.taken_at).getTime() - exif.takenAt.getTime()) > 1000) {
    return { status: "unmatched" };
  }

  const { exifFingerprint } = await computeFileFingerprint(absolutePath, tags);
  const fileSize = statSync(absolutePath).size;
  const finalPath = organize
    ? await moveManagedOriginalToSpeciesFolder(
        absolutePath,
        true,
        match.common_name,
        match.scientific_name,
        "raw",
        organizeByYear,
        match.taxon_class,
        exif.takenAt,
      )
    : absolutePath;
  await pool.query(
    `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path)
     VALUES ($1, 'raw', 'path', $2, true, $3, $4, $5, $6, $7, $8)`,
    [
      match.id,
      finalPath,
      contentHash,
      fileSize,
      exifFingerprint.strict,
      exifFingerprint.loose,
      organize ? null : (volumeContext?.volumeId ?? null),
      organize ? null : volumeContext ? absolutePath.slice(volumeContext.mountPath.length) : null,
    ],
  );
  return { status: "recovered", captureId: match.id };
}

// Species a reimport surfaced that are missing full reference data (no reference photo, no
// description) — the direct input to the pack-recommendation feature: exactly the names a
// user would need an offline pack for to get back what a fresh install's empty catalog can't
// give them from GBIF/Wikipedia enrichment alone.
export async function findMissingReferenceData(scientificNames: string[]): Promise<string[]> {
  if (scientificNames.length === 0) return [];
  const res = await pool.query<{ scientific_name: string }>(
    `SELECT scientific_name FROM species
     WHERE scientific_name = ANY($1) AND (reference_photo IS NULL OR description IS NULL)`,
    [scientificNames],
  );
  return res.rows.map((r) => r.scientific_name);
}
