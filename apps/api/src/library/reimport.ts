// Rebuilds captures, photos, user_species and originals from a photo tree on disk that has no
// database rows (a fresh install, or a library from another tool). Trips have their own recovery
// (tripIndex.ts).
// Species can come from embedded metadata, an XMP sidecar, or file and folder names, pooled into
// one candidate set; the folder name also breaks ties. Matching is by scientific name (ids differ
// between installs), and a name shared by several species is flagged, not guessed.
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { generateDerivatives } from "@lifer/core/uploads/image.js";
import {
  captureTimeFromTags,
  computeExifFingerprint,
  extractExif,
  extractKeywordsWithSidecar,
  extractLiferTags,
  readExifTags,
  type ExifTags,
} from "../uploads/exif.js";
import { computeContentHash } from "../uploads/fileFingerprint.js";
import { resolveSpeciesFolderName } from "../uploads/speciesFolderName.js";
import { ACCEPTED_PHOTO_EXTENSIONS, isRawFile, VENDOR_RAW_EXTENSIONS } from "@lifer/core/uploads/formats.js";
import { uploadWorkDir } from "../lib/uploadWorkDir.js";
import {
  matchSpeciesByKeywords,
  groupByScientificName,
  type KeywordMatchedSpecies,
} from "../species/matchByKeywords.js";
import { matchSpeciesFromFilename } from "../species/matchByFilename.js";
import { derivativeFiles, fileIntoMainLibrary, removeFiles } from "../uploads/common.js";
import { insertCapture, insertOriginal } from "../uploads/captureRows.js";
import { recoverAlbumMembership } from "../albums/albumIndex.js";
import { tagWithRegisteredVolume, type VolumeTag } from "../storageVolumes/resolve.js";
import { markCollected } from "../lib/userSpecies.js";
import type { CullMarksOption } from "@lifer/shared";
import { cullDecision, readPairCullMarks } from "../uploads/cullMarks.js";
import { matchingSourceRaw } from "../trips/import.js";
import { walkFiles } from "./walkFiles.js";

const PHOTO_EXTENSIONS = new Set(ACCEPTED_PHOTO_EXTENSIONS);

export interface LibraryFiles {
  /** Edited photos (JPEG, PNG, WebP, TIFF, HEIC), each recovered as its own capture. */
  jpegs: string[];
  raws: string[];
}

// Depth-agnostic walk: files are bucketed by type, so any folder layout works.
export async function listManagedFiles(originalsDir: string): Promise<LibraryFiles> {
  const jpegs: string[] = [];
  const raws: string[] = [];
  // Upload scratch files and app data (WebP derivatives) are never library photos.
  const skipDirs = new Set([path.resolve(uploadWorkDir()), path.resolve(APP_DATA_DIR)]);
  for await (const { absolutePath, name } of walkFiles(originalsDir, (dir) => skipDirs.has(path.resolve(dir)))) {
    const ext = path.extname(name).toLowerCase();
    if (!PHOTO_EXTENSIONS.has(ext) && !VENDOR_RAW_EXTENSIONS.has(ext)) continue;
    // A TIFF is a RAW only when it holds sensor data; an edited TIFF is a photo.
    if (await isRawFile(absolutePath)) raws.push(absolutePath);
    else jpegs.push(absolutePath);
  }
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
  | { status: "recovered"; captureId: string; photoId: string; scientificName: string; hidden?: boolean }
  | { status: "already-known" }
  | { status: "relinked" }
  | { status: "ignored" }
  /** Rejected in a culling app, and the reimport was set to skip those. */
  | { status: "rejected" }
  | { status: "unrecognized"; candidates: string[]; contentHash: string }
  | { status: "ambiguous"; scientificNames: string[]; contentHash: string };

// "Don't ask about this file again", keyed by content hash so it survives moves and renames.
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

/** Where a reimport walk is pointed and, for a registered external drive, how to tag
 *  recovered originals with it. Resolved once per run by library/routes.ts. */
export interface VolumeContext {
  volumeId: string;
  baseDir: string;
  mountPath: string;
}

// Where a recovered original's row points. Organized files were just moved into the main
// library, so they're untagged. A folder picked from someone else's layout (foreign) keeps its
// files in place, so they get tagged against whatever registered drive or declared root holds
// them, the same as a link-mode upload, and read as "not connected" if it goes away.
async function recoveredVolumeTag(
  userId: string,
  absolutePath: string,
  volumeContext: VolumeContext | null,
  organize: boolean,
  foreign: boolean,
): Promise<VolumeTag> {
  if (organize) return { volumeId: null, volumeRelativePath: null };
  if (volumeContext)
    return { volumeId: volumeContext.volumeId, volumeRelativePath: absolutePath.slice(volumeContext.mountPath.length) };
  if (foreign) return tagWithRegisteredVolume(userId, absolutePath);
  return { volumeId: null, volumeRelativePath: null };
}

// A file whose bytes are already known may still have a stale `ref` (a drive remounted under a
// new name). Repairs it in place. Returns true if a repair was made.
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

// Breaks a multi-name keyword match using the file's own folder name.
async function findRowMatchingFolder(
  userId: string,
  absolutePath: string,
  byName: Map<string, SpeciesRow[]>,
): Promise<SpeciesRow[] | null> {
  const parentFolder = path.basename(path.dirname(path.dirname(absolutePath)));
  for (const rows of byName.values()) {
    const folderName = await resolveSpeciesFolderName(userId, rows[0].id);
    if (folderName === parentFolder) return rows;
  }
  return null;
}

/** What a reimport does with photos a culling app rejected (uploads/cullMarks.ts), and the RAWs
 *  found in the same walk, so a reject on a photo's RAW twin counts for the photo too. */
export interface ReimportCullHandling {
  option: CullMarksOption;
  raws?: string[];
}

// `organize` moves an imported library into Lifer's species folders in the main library.
export async function recoverJpeg(
  userId: string,
  absolutePath: string,
  volumeContext: VolumeContext | null = null,
  organize = false,
  organizeByYear = false,
  foreign = false,
  cull: ReimportCullHandling = { option: "ignore" },
): Promise<JpegOutcome> {
  const contentHash = await computeContentHash(absolutePath);
  const known = await pool.query<{ id: string; ref: string; volume_id: string | null }>(
    `SELECT id, ref, volume_id FROM originals WHERE content_hash = $1 AND user_id = $2 LIMIT 1`,
    [contentHash, userId],
  );
  if (known.rows.length > 0) {
    const row = known.rows[0];
    const repaired = await repairIfStale(row.id, row.ref, row.volume_id, absolutePath, volumeContext);
    return { status: repaired ? "relinked" : "already-known" };
  }

  if (await isIgnoredLibraryFile(userId, contentHash)) return { status: "ignored" };

  // Before species matching, so a skipped reject isn't listed as unrecognized. Reading only: the
  // file stays where it is, whatever the mark says.
  const rawTwin = cull.raws?.length
    ? matchingSourceRaw(
        absolutePath,
        cull.raws.map((p) => ({ absolutePath: p, relativePath: p })),
      )
    : null;
  const marks = await readPairCullMarks(absolutePath, rawTwin?.absolutePath ?? null);
  const decision = cullDecision(marks, cull.option);
  if (decision === "skip") return { status: "rejected" };
  const hidden = decision === "hide";

  const tags: ExifTags = await readExifTags(absolutePath);
  // Embedded tags, unioned with an XMP sidecar's tags when one exists.
  const candidates = await extractKeywordsWithSidecar(absolutePath, tags);
  const keywordMatches = candidates.length > 0 ? await matchSpeciesByKeywords(pool, candidates) : [];

  // The file name is always tried too: it can corroborate the tags, or name a different species
  // and flag a real ambiguity.
  const fileStem = path.basename(absolutePath, path.extname(absolutePath));
  const parentFolder = path.basename(path.dirname(absolutePath));
  const filenameMatches = await matchSpeciesFromFilename(pool, `${fileStem} ${parentFolder}`);

  const matchedById = new Map<string, KeywordMatchedSpecies>();
  for (const row of [...keywordMatches, ...filenameMatches]) matchedById.set(row.id, row);
  const matchedRows = [...matchedById.values()];
  if (matchedRows.length === 0) return { status: "unrecognized", candidates, contentHash };

  const byName = groupByScientificName(matchedRows);

  let primaryRows: SpeciesRow[];
  if (byName.size === 1) {
    primaryRows = [...byName.values()][0];
  } else {
    const matched = await findRowMatchingFolder(userId, absolutePath, byName);
    if (!matched) return { status: "ambiguous", scientificNames: [...byName.keys()], contentHash };
    primaryRows = matched;
  }

  if (primaryRows.length > 1) {
    // One scientific_name on several species rows: flag it, never pick one.
    return { status: "ambiguous", scientificNames: [primaryRows[0].scientific_name], contentHash };
  }
  const species = primaryRows[0];

  const exif = await extractExif(absolutePath, tags);
  // The content hash is already known: only the EXIF pair is computed here.
  const exifFingerprint = await computeExifFingerprint(absolutePath, tags);
  const fileSize = statSync(absolutePath).size;

  const finalPath = organize
    ? await fileIntoMainLibrary(
        absolutePath,
        true,
        userId,
        species.id,
        "jpeg",
        organizeByYear,
        exif.takenAt,
        // The camera's own year, so the folder doesn't depend on the server's zone.
        captureTimeFromTags(tags)?.wallClock ?? null,
      )
    : absolutePath;

  // ref=finalPath: the file's own path for Lifer's tree, or the organized destination, which is
  // untagged. A foreign folder imported in place stays unmanaged (see recoveredVolumeTag).
  const tag = await recoveredVolumeTag(userId, absolutePath, volumeContext, organize, foreign);

  // Derivatives are made before the transaction so sharp's decode never holds a pool connection,
  // and removed again if the recovery doesn't commit. From the path, never the whole file in
  // memory; HEIC is decoded through a working JPEG.
  const photoId = randomUUID();
  let derivatives: Awaited<ReturnType<typeof generateDerivatives>>;
  try {
    derivatives = await generateDerivatives(finalPath, photoId);
  } catch (err) {
    removeFiles(derivativeFiles(photoId));
    throw err;
  }
  const { displayPath, thumbPath, width, height } = derivatives;

  const client = await pool.connect();
  let captureId: string;
  try {
    await client.query("BEGIN");

    captureId = await insertCapture(client, {
      userId,
      speciesId: species.id,
      fingerprint: contentHash,
      exifFingerprint,
      exif,
      // The photo tags Lifer wrote into the file, if it did.
      tags: extractLiferTags(tags),
      // Kept as the culling app left them, whatever the reimport did with them.
      cull: marks,
    });

    await client.query(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6)`,
      [photoId, captureId, displayPath, thumbPath, width, height],
    );
    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);

    // A hidden photo doesn't count as collected until it's unhidden (captures/hidden.ts).
    if (!hidden) await markCollected(client, userId, species.id, photoId, exif.takenAt);

    await insertOriginal(client, {
      userId,
      captureId,
      kind: "jpeg",
      ref: finalPath,
      // Lifer only owns files it wrote or moved into its own layout, never ones left in place
      // in someone else's folder (managed files can get renamed or moved by Lifer later).
      managed: !foreign || organize,
      contentHash,
      fileSize,
      exifFingerprint,
      ...tag,
    });

    // Last, since the rows above are written through the `captures` view, which hides it.
    if (hidden) await client.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [captureId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    removeFiles(derivativeFiles(photoId));
    throw err;
  } finally {
    client.release();
  }

  // This photo may just have become the species' cover: frame the card on the animal.
  if (!hidden) ensureDefaultCardCropLater(userId, species.id);
  // Best-effort: a missing or unreadable manifest never fails the recovery.
  await recoverAlbumMembership(userId, finalPath, captureId).catch(() => {});
  return { status: "recovered", captureId, photoId, scientificName: species.scientific_name, hidden };
}

export type RawOutcome =
  | { status: "recovered"; captureId: string }
  | { status: "already-known" }
  | { status: "relinked" }
  | { status: "unmatched" };

function sanitizeFilenameStem(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

// Matches a RAW to an already recovered JPEG capture by file stem and EXIF time (from this run or
// an earlier one). No fingerprint fallback: an unmatched RAW is left for the manual flow.
export async function recoverRaw(
  userId: string,
  absolutePath: string,
  volumeContext: VolumeContext | null = null,
  organize = false,
  organizeByYear = false,
  foreign = false,
): Promise<RawOutcome> {
  const contentHash = await computeContentHash(absolutePath);
  const known = await pool.query<{ id: string; ref: string; volume_id: string | null }>(
    `SELECT id, ref, volume_id FROM originals WHERE content_hash = $1 AND user_id = $2 LIMIT 1`,
    [contentHash, userId],
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
    species_id: string;
    taken_at: string | null;
  }>(
    `SELECT c.id, c.species_id, c.taken_at
     FROM captures c
     JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
     WHERE c.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')
       AND lower(regexp_replace(regexp_replace(o.ref, '^.*/', ''), '(-[0-9]+)?\\.[^.]+$', '')) = $2`,
    [userId, stem],
  );
  if (candidates.rows.length !== 1) return { status: "unmatched" };
  const match = candidates.rows[0];
  if (!match.taken_at || Math.abs(new Date(match.taken_at).getTime() - exif.takenAt.getTime()) > 1000) {
    return { status: "unmatched" };
  }

  const exifFingerprint = await computeExifFingerprint(absolutePath, tags);
  const fileSize = statSync(absolutePath).size;
  const finalPath = organize
    ? await fileIntoMainLibrary(
        absolutePath,
        true,
        userId,
        match.species_id,
        "raw",
        organizeByYear,
        exif.takenAt,
        captureTimeFromTags(tags)?.wallClock ?? null,
      )
    : absolutePath;
  const tag = await recoveredVolumeTag(userId, absolutePath, volumeContext, organize, foreign);
  await insertOriginal(pool, {
    userId,
    captureId: match.id,
    kind: "raw",
    ref: finalPath,
    managed: !foreign || organize,
    contentHash,
    fileSize,
    exifFingerprint,
    ...tag,
  });
  return { status: "recovered", captureId: match.id };
}

// Recovered species missing reference data (photo, description): the input to pack
// recommendations.
export async function findMissingReferenceData(scientificNames: string[]): Promise<string[]> {
  if (scientificNames.length === 0) return [];
  const res = await pool.query<{ scientific_name: string }>(
    `SELECT scientific_name FROM species
     WHERE scientific_name = ANY($1)
       -- A pack's own photo and habitat text count: packs never fill the online-only columns,
       -- so checking just those flagged species a pack had already covered, and recommended
       -- packs that couldn't clear the warning.
       AND ((reference_photo IS NULL AND reference_display_path IS NULL) OR (description IS NULL AND habitat_description IS NULL))`,
    [scientificNames],
  );
  return res.rows.map((r) => r.scientific_name);
}
