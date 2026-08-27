import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync, copyFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { generateDerivatives } from "./image.js";
import { extractExif, extractKeywords, computeExifFingerprint, writeSpeciesMetadata, readExifTags, type ExtractedExif } from "./exif.js";
import { DATA_DIR, APP_DATA_DIR, ORIGINALS_DIR } from "../config.js";
import { fetchS3Object } from "../photoSources/s3.js";
import { RAW_EXTENSIONS } from "./rawExtensions.js";
import { originalsFolder } from "./organizedPath.js";
import { resolveSpeciesFolderName } from "./speciesFolderName.js";

type UploadMode = "store" | "link" | "s3";

// The main upload endpoint accepts JPEG and PNG (screenshots, some export presets, phone
// camera software). The stored file's own extension must match its real format (not just
// always ".jpg") — exiftool.write below cares about this, and a mismatched extension would
// confuse anything else that opens the file later.
const ACCEPTED_PHOTO_EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
};

// Store-mode originals land in a human-browsable tree instead of a flat {uuid}.jpg, so the
// library stays usable outside Lifer. The edited JPEG and its RAW sibling get their own
// named subfolders so it's obvious which is which without opening Lifer at all:
// <species>/Adjusted/<file>.jpg, <species>/RAW/<file>.<ext>. A folder is only ever created
// for a species that's actually been uploaded to (mkdirSync only runs at the point a file
// is actually written there — never pre-created for the whole backbone).
function sanitizeForFilesystem(name: string): string {
  // Slashes would create unintended subfolders; the rest are characters Windows/macOS/Linux
  // either forbid outright or that just make a folder name awkward to look at/type.
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

/** Prefers the browser-supplied original filename (sanitized); falls back to a date-based
 *  name when there isn't one (e.g. link mode already has a real path/filename of its own,
 *  so this is really only exercised for store mode's uploaded bytes). */
function originalFilename(uploadedName: string | null, takenAt: Date | null, extension: string): string {
  if (uploadedName) {
    const base = sanitizeForFilesystem(path.basename(uploadedName, path.extname(uploadedName)));
    if (base) return `${base}${extension}`;
  }
  const datePart = takenAt ? takenAt.toISOString().slice(0, 10) : "undated";
  return `${datePart}-${randomUUID().slice(0, 8)}${extension}`;
}

/** Avoids silently overwriting a same-named file already in that species' folder (e.g. two
 *  cameras both producing "IMG_0001.jpg") — appends "-2", "-3", etc. rather than guessing
 *  they're the same photo. */
function uniqueDestination(dir: string, filename: string): string {
  let candidate = path.join(dir, filename);
  if (!existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length || undefined);
  for (let i = 2; existsSync(candidate); i++) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
  }
  return candidate;
}

// The auto-link paths below only update originals.capture_id; without this, a RAW linked
// after the fact would stay sitting wherever it was first written (e.g. a holding folder)
// instead of landing in that species' own RAW folder like every other path already does.
// Only moves a Lifer-MANAGED copy (managed=true) — an externally-referenced file
// (managed=false, e.g. one indexed from a user's own scan-root library) is never Lifer's to
// move, same principle as store vs. link mode elsewhere in this file. Renames when possible;
// falls back to copy+delete for the rare case the destination is on a different
// filesystem/volume.
async function moveManagedOriginalToSpeciesFolder(
  currentRef: string,
  managed: boolean,
  commonName: string | null,
  scientificName: string,
  kind: "raw" | "jpeg",
  organizeByYear: boolean,
  taxonClass: string | null,
  takenAt: Date | null,
): Promise<string> {
  if (!managed || !existsSync(currentRef)) return currentRef;
  const folder = originalsFolder(ORIGINALS_DIR, {
    organizeByYear,
    speciesFolderName: await resolveSpeciesFolderName(commonName, scientificName),
    taxonClass,
    takenAt,
    subfolder: kind === "raw" ? "RAW" : "Adjusted",
  });
  mkdirSync(folder, { recursive: true });
  const dest = uniqueDestination(folder, path.basename(currentRef));
  if (dest === currentRef) return currentRef;
  try {
    renameSync(currentRef, dest);
  } catch {
    copyFileSync(currentRef, dest);
    rmSync(currentRef, { force: true });
  }
  return dest;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Inspects a file (EXIF date + keywords, for auto-matching a species before the user
  // commits anything) without writing any DB rows or keeping the file — the actual
  // /uploads call below still does that, once a species is chosen.
  app.post("/uploads/inspect", { preHandler: requireAuth }, async (request, reply) => {
    let fileBuffer: Buffer | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") fileBuffer = await part.toBuffer();
    }
    if (!fileBuffer) return reply.code(400).send({ error: "No file uploaded" });

    const tmpDir = path.join(APP_DATA_DIR, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.jpg`);
    writeFileSync(tmpPath, fileBuffer);
    try {
      const tags = await readExifTags(tmpPath);
      const [exif, keywords] = [await extractExif(tmpPath, tags), await extractKeywords(tmpPath, tags)];
      return { takenAt: exif.takenAt, keywords };
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });

  // Accepts one or many RAW files in a single request (a browser folder-picker sends them
  // all as separate file parts of the same request), each matched independently against
  // already-uploaded JPEGs. A unique match links immediately; no match or an ambiguous
  // multi-match are both left untouched on disk rather than imported or auto-linked, since
  // guessing wrong here would silently mis-file a photo under the wrong species.
  interface RawUploadOutcome {
    filename: string;
    linked: boolean;
    collision: boolean;
    captureId?: string;
    speciesCommonName?: string | null;
    speciesScientificName?: string;
    /** Filed directly into a species' RAW folder without matching any capture — see
     *  processOneRawUpload's speciesId/allowUnmatchedFallback param. */
    filed?: boolean;
    /** Already present (identical content) in that species' RAW folder — not re-added. */
    duplicate?: boolean;
  }

  async function processOneRawUpload(
    rawBuffer: Buffer,
    rawFileName: string,
    userId: string,
    speciesId: string | null,
    allowUnmatchedFallback: boolean,
  ): Promise<RawUploadOutcome> {
    const tmpDir = path.join(APP_DATA_DIR, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}${path.extname(rawFileName).toLowerCase()}`);
    writeFileSync(tmpPath, rawBuffer);

    let exif: ExtractedExif;
    let fingerprint: { strict: string | null; loose: string | null };
    try {
      const tags = await readExifTags(tmpPath);
      exif = await extractExif(tmpPath, tags);
      fingerprint = await computeExifFingerprint(tmpPath, tags);
    } finally {
      rmSync(tmpPath, { force: true });
    }

    const userRes = await pool.query<{ organize_originals_by_year: boolean }>(
      `SELECT organize_originals_by_year FROM users WHERE id = $1`,
      [userId],
    );
    const organizeByYear = userRes.rows[0]?.organize_originals_by_year ?? false;

    const contentHash = createHash("sha256").update(rawBuffer).digest("hex");

    // Cameras (and most export workflows) give a RAW and its JPEG sibling the identical
    // base filename — a cheap string comparison across this user's unlinked JPEGs finds the
    // likely match before paying for any EXIF work beyond what was already extracted above.
    // Never trusted on its own (a "DSC_0001"-style sequential name recurring
    // across cards/cameras is a real false-positive risk) — only linked once the RAW's own
    // DateTimeOriginal exactly matches that capture's stored taken_at, i.e. verified against
    // the exact same EXIF signal the fingerprint match below would have used anyway.
    async function findFilenameMatch(): Promise<{
      id: string;
      common_name: string | null;
      scientific_name: string;
      taxon_class: string | null;
    } | null> {
      if (!exif.takenAt) return null;
      const rawStem = sanitizeForFilesystem(path.basename(rawFileName, path.extname(rawFileName))).toLowerCase();
      if (!rawStem) return null;
      // Filename comparison happens IN THE QUERY (regexp_replace strips the stored ref's
      // directory + extension + any "-2"/"-3" collision suffix down to a bare stem) so only
      // an actual match is ever pulled back — not every unlinked JPEG's row, and never any
      // file bytes either; `ref` here is just the stored destination path string.
      const candidates = await pool.query<{
        id: string;
        common_name: string | null;
        scientific_name: string;
        taxon_class: string | null;
        taken_at: Date | null;
      }>(
        `SELECT c.id, s.common_name, s.scientific_name, s.taxon_class, c.taken_at
         FROM captures c
         JOIN species s ON s.id = c.species_id
         JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
         WHERE c.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')
           AND lower(regexp_replace(regexp_replace(o.ref, '^.*/', ''), '(-[0-9]+)?\.[^.]+$', '')) = $2`,
        [userId, rawStem],
      );
      if (candidates.rows.length !== 1) return null;
      const match = candidates.rows[0];
      if (!match.taken_at || Math.abs(new Date(match.taken_at).getTime() - exif.takenAt.getTime()) > 1000) return null;
      return match;
    }

    // Strict fingerprint first (identical camera metadata); if that finds nothing, fall back
    // to the loose one (see exif.ts's own comment — an exported JPEG commonly loses
    // SubSecTimeOriginal/SerialNumber, which the strict fingerprint depends on). Whichever
    // tier actually produces the match is what gets recorded on the resulting collision.
    async function findCaptureMatches(column: "exif_fingerprint" | "exif_fingerprint_loose", value: string) {
      return pool.query<{ id: string; common_name: string | null; scientific_name: string; taxon_class: string | null }>(
        `SELECT c.id, s.common_name, s.scientific_name, s.taxon_class
         FROM captures c JOIN species s ON s.id = c.species_id
         WHERE c.user_id = $1 AND c.${column} = $2
           AND NOT EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind = 'raw')`,
        [userId, value],
      );
    }

    const filenameMatch = await findFilenameMatch();
    let matches: Array<{ id: string; common_name: string | null; scientific_name: string; taxon_class: string | null }> =
      filenameMatch ? [filenameMatch] : [];
    if (matches.length === 0) {
      matches = fingerprint.strict != null ? (await findCaptureMatches("exif_fingerprint", fingerprint.strict)).rows : [];
      if (matches.length === 0 && fingerprint.loose != null) {
        matches = (await findCaptureMatches("exif_fingerprint_loose", fingerprint.loose)).rows;
      }
    }

    if (matches.length === 1) {
      const match = matches[0];
      const folder = originalsFolder(ORIGINALS_DIR, {
        organizeByYear,
        speciesFolderName: await resolveSpeciesFolderName(match.common_name, match.scientific_name),
        taxonClass: match.taxon_class,
        takenAt: exif.takenAt,
        subfolder: "RAW",
      });
      mkdirSync(folder, { recursive: true });
      const dest = uniqueDestination(folder, originalFilename(rawFileName, exif.takenAt, path.extname(rawFileName).toLowerCase()));
      writeFileSync(dest, rawBuffer);
      // If this INSERT throws after the file above was already written, the file would be
      // left as a phantom on disk with no DB row to ever find it again. Clean it up on
      // failure rather than leaving an orphan.
      try {
        await pool.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id)
           VALUES ($1, 'raw', 'path', $2, true, $3, $4, $5, $6, $7)`,
          [match.id, dest, contentHash, rawBuffer.length, fingerprint.strict, fingerprint.loose, userId],
        );
      } catch (err) {
        rmSync(dest, { force: true });
        throw err;
      }
      return {
        filename: rawFileName,
        linked: true,
        collision: false,
        captureId: match.id,
        speciesCommonName: match.common_name,
        speciesScientificName: match.scientific_name,
      };
    }

    // No match, or an ambiguous match against more than one capture. The "point it at a
    // folder" bulk import only links RAWs that match a JPEG already kept, never guessing
    // what to do with the rest of a folder that could span any number of unrelated species.
    // But "Choose RAW files…" on a specific species' own page (allowUnmatchedFallback, only
    // set there — see RawUpload.tsx) DOES know unambiguously which species these belong to,
    // so a non-match there isn't a dead end: it's just a RAW with no JPEG counterpart yet,
    // filed straight into that species' own RAW folder.
    if (matches.length <= 1 && allowUnmatchedFallback && speciesId) {
      const speciesRes = await pool.query<{ common_name: string | null; scientific_name: string; taxon_class: string | null }>(
        `SELECT common_name, scientific_name, taxon_class FROM species WHERE id = $1`,
        [speciesId],
      );
      const species = speciesRes.rows[0];
      if (species) {
        // A content-identical file (same hash) already filed for this species is the same
        // photo, not a new one; skip it rather than writing a redundant copy.
        const existing = await pool.query(
          `SELECT 1 FROM originals WHERE kind = 'raw' AND species_id = $1 AND content_hash = $2 LIMIT 1`,
          [speciesId, contentHash],
        );
        if (existing.rows.length > 0) {
          return { filename: rawFileName, linked: false, collision: false, duplicate: true };
        }

        const folder = originalsFolder(ORIGINALS_DIR, {
          organizeByYear,
          speciesFolderName: await resolveSpeciesFolderName(species.common_name, species.scientific_name),
          taxonClass: species.taxon_class,
          takenAt: exif.takenAt,
          subfolder: "RAW",
        });
        mkdirSync(folder, { recursive: true });
        // uniqueDestination already appends "-2", "-3", etc. on a plain filename collision —
        // that's the desired behavior once the identical-content check above has ruled out
        // "this is just the same file again."
        const dest = uniqueDestination(folder, originalFilename(rawFileName, exif.takenAt, path.extname(rawFileName).toLowerCase()));
        writeFileSync(dest, rawBuffer);
        try {
          await pool.query(
            `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id, species_id)
             VALUES (NULL, 'raw', 'path', $1, true, $2, $3, $4, $5, $6, $7)`,
            [dest, contentHash, rawBuffer.length, fingerprint.strict, fingerprint.loose, userId, speciesId],
          );
        } catch (err) {
          rmSync(dest, { force: true });
          throw err;
        }
        return {
          filename: rawFileName,
          linked: false,
          collision: false,
          filed: true,
          speciesCommonName: species.common_name,
          speciesScientificName: species.scientific_name,
        };
      }
    }

    // Otherwise: this endpoint exists specifically to pull RAWs that match a JPEG already
    // kept, not to import every RAW in the folder. A RAW with no match here just isn't one
    // with a kept JPEG — never copied into Lifer's storage at all, left exactly where it was
    // on the source filesystem.
    return { filename: rawFileName, linked: false, collision: matches.length > 1 };
  }

  app.post("/uploads/raw", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    // Reading each part's bytes off the wire has to happen sequentially (one multipart
    // stream), but per-file PROCESSING (exiftool, DB queries, the disk write) doesn't need to
    // wait for that — kicking each one off as soon as its buffer is in hand, instead of
    // awaiting it before reading the next part, means a batch of N files takes roughly as
    // long as the slowest one rather than the sum of all of them. exiftool-vendored and the
    // Postgres pool each queue internally if a batch is large, so this is safe without an
    // explicit concurrency cap.
    // RawUpload.tsx sends these two fields ONLY from its non-folder "Choose RAW files…"
    // picker, never from "Choose a folder…", so the fallback-to-species-folder behavior
    // below only applies to that picker's uploads. Read as fields since request.parts()
    // interleaves them with the file parts on the same stream — the frontend sends them
    // before any file part, so they're already set by the time the first file needs them.
    let speciesId: string | null = null;
    let allowUnmatchedFallback = false;
    const pending: Promise<RawUploadOutcome>[] = [];
    for await (const part of request.parts()) {
      if (part.type !== "file") {
        if (part.fieldname === "speciesId") speciesId = String(part.value);
        else if (part.fieldname === "allowUnmatchedFallback") allowUnmatchedFallback = String(part.value) === "1";
        continue;
      }
      if (!part.filename) continue;
      if (!RAW_EXTENSIONS.has(path.extname(part.filename).toLowerCase())) {
        // A folder picker routinely includes non-RAW siblings (JPEGs, .DS_Store, XMP
        // sidecars, THM thumbnails) that get skipped here — but @fastify/multipart's
        // underlying busboy parser is a single sequential stream; a skipped file part whose
        // bytes are never read leaves that part's stream un-drained, which stalls the parser
        // and blocks it from ever handing back the NEXT part. Every skip must still consume
        // (or explicitly drain) that part's stream before moving on.
        part.file.resume();
        continue;
      }
      const buffer = await part.toBuffer();
      pending.push(processOneRawUpload(buffer, part.filename, userId, speciesId, allowUnmatchedFallback));
    }
    if (pending.length === 0) {
      return reply.code(400).send({ error: "No supported RAW files found in that upload" });
    }
    const results = await Promise.all(pending);
    return reply.code(201).send({ results });
  });

  app.post("/uploads", { preHandler: requireAuth }, async (request, reply) => {
    // mode=store sends a `file` part; mode=link sends a `path` field instead
    // (the absolute path a native Finder dialog returned — see src/originals/browse.ts) and
    // no file bytes at all. request.parts() reads both fields and files off one stream, since
    // request.file() alone only knows how to wait for a file part. Each file part's stream
    // must be fully drained before moving on to the next part (busboy backpressure) — buffer
    // it immediately inside the loop rather than holding the raw part for later.
    const fields: Record<string, string> = {};
    let fileBuffer: Buffer | null = null;
    let fileMimetype: string | null = null;
    let fileName: string | null = null;
    // Optionally imports a RAW sibling in the very same request as its edited JPEG — a
    // shortcut for uploading one photo when both files are already in hand, rather than
    // relying on the separate fingerprint-matching fallback below to find and link it later.
    let rawBuffer: Buffer | null = null;
    let rawFileName: string | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file" && part.fieldname === "rawFile") {
        rawBuffer = await part.toBuffer();
        rawFileName = part.filename;
      } else if (part.type === "file") {
        fileBuffer = await part.toBuffer();
        fileMimetype = part.mimetype;
        fileName = part.filename;
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const mode: UploadMode = fields.mode === "link" ? "link" : fields.mode === "s3" ? "s3" : "store";
    const speciesId = fields.speciesId;
    if (!speciesId) return reply.code(400).send({ error: "speciesId field is required" });

    const speciesRes = await pool.query<{
      id: string;
      common_name: string | null;
      scientific_name: string;
      taxon_class: string | null;
      family: string | null;
    }>(`SELECT id, common_name, scientific_name, taxon_class, family FROM species WHERE id = $1`, [speciesId]);
    if (speciesRes.rows.length === 0) return reply.code(400).send({ error: "Unknown species" });
    const species = speciesRes.rows[0];

    let buffer: Buffer;
    let originalRef: string | null = null;

    if (mode === "link") {
      const linkPath = fields.path;
      if (!linkPath || !path.isAbsolute(linkPath)) {
        return reply.code(400).send({ error: "path must be an absolute filesystem path" });
      }
      if (!existsSync(linkPath)) {
        return reply.code(400).send({ error: "That file doesn't exist on this server" });
      }
      buffer = readFileSync(linkPath);
      originalRef = linkPath;
    } else if (mode === "s3") {
      // Links an object already sitting in a bucket instead of duplicating it into Lifer's
      // own storage — the object is fetched once here only to derive thumb/display webps
      // and read EXIF, never written back to disk under Lifer's own directory.
      const bucketKey = fields.bucketKey;
      if (!bucketKey) return reply.code(400).send({ error: "bucketKey field is required for mode=s3" });
      try {
        buffer = await fetchS3Object(bucketKey);
      } catch (err) {
        return reply.code(400).send({ error: `Couldn't fetch that S3 object: ${(err as Error).message}` });
      }
      originalRef = bucketKey;
    } else {
      if (!fileBuffer) return reply.code(400).send({ error: "No file uploaded" });
      if (!fileMimetype || !(fileMimetype in ACCEPTED_PHOTO_EXTENSION_BY_MIMETYPE)) {
        return reply.code(400).send({ error: "Only JPEG or PNG uploads are supported" });
      }
      buffer = fileBuffer;
    }
    const photoExtension = fileMimetype ? (ACCEPTED_PHOTO_EXTENSION_BY_MIMETYPE[fileMimetype] ?? ".jpg") : ".jpg";

    if (rawBuffer && mode !== "store") {
      return reply.code(400).send({ error: "rawFile is only supported for mode=store" });
    }
    if (rawBuffer && (!rawFileName || !RAW_EXTENSIONS.has(path.extname(rawFileName).toLowerCase()))) {
      return reply.code(400).send({ error: "rawFile doesn't look like a supported RAW format" });
    }

    const fingerprint = createHash("sha256").update(buffer).digest("hex");

    // exiftool-vendored needs a real file path — write to a scratch dir, then clean up.
    // (Skipped for link mode's own file, since it's already got a real path on disk.)
    const tmpDir = path.join(APP_DATA_DIR, "tmp");
    let exifSourcePath = originalRef;
    if (mode === "store") {
      mkdirSync(tmpDir, { recursive: true });
      exifSourcePath = path.join(tmpDir, `${randomUUID()}${photoExtension}`);
      writeFileSync(exifSourcePath, buffer);
    }

    let exif: ExtractedExif;
    let exifFingerprint: { strict: string | null; loose: string | null };
    try {
      const tags = await readExifTags(exifSourcePath!);
      exif = await extractExif(exifSourcePath!, tags);
      // Computed now, while the JPEG's own EXIF is already being read, so a RAW sibling
      // discovered later by the indexing job can be auto-linked to this capture. Both
      // tiers are kept (see exif.ts) since an exported/edited JPEG commonly loses
      // SubSecTimeOriginal/SerialNumber, which only the loose fingerprint survives without.
      exifFingerprint = await computeExifFingerprint(exifSourcePath!, tags);
    } finally {
      if (mode === "store") rmSync(exifSourcePath!, { force: true });
    }

    const userId = request.user!.id;
    const organizeRes = await pool.query<{ organize_originals_by_year: boolean }>(
      `SELECT organize_originals_by_year FROM users WHERE id = $1`,
      [userId],
    );
    const organizeByYear = organizeRes.rows[0]?.organize_originals_by_year ?? false;

    // This candidate lookup and its EXIF-verification file read/exiftool call happen BEFORE
    // opening the DB transaction below, not inside it. Filesystem/exiftool I/O has no
    // business holding a live Postgres connection checked out of the pool — if this ever
    // runs slow (a huge file, a cold exiftool process, a weird edge case), it would block a
    // connection the whole pool could eventually run out of, stalling unrelated requests too.
    let filenameVerifiedRaw: { id: string; ref: string; managed: boolean } | null = null;
    if (!rawBuffer && fileName && exif.takenAt) {
      const stem = sanitizeForFilesystem(path.basename(fileName, path.extname(fileName))).toLowerCase();
      if (stem) {
        // Filename comparison happens IN THE QUERY (see /uploads/raw's own identical
        // pattern) — only an actual match is ever pulled back.
        const candidates = await pool.query<{ id: string; ref: string; managed: boolean }>(
          `SELECT id, ref, managed FROM originals
           WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $1
             AND lower(regexp_replace(regexp_replace(ref, '^.*/', ''), '(-[0-9]+)?\.[^.]+$', '')) = $2`,
          [userId, stem],
        );
        if (candidates.rows.length === 1 && existsSync(candidates.rows[0].ref)) {
          const candidateExif = await extractExif(candidates.rows[0].ref);
          if (candidateExif.takenAt && Math.abs(candidateExif.takenAt.getTime() - exif.takenAt.getTime()) <= 1000) {
            filenameVerifiedRaw = candidates.rows[0];
          }
        }
      }
    }

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
          speciesId,
          fingerprint,
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
      const { displayPath, thumbPath } = await generateDerivatives(buffer, photoId);

      const photoRes = await client.query<{ id: string }>(
        `INSERT INTO photos (id, capture_id, display_path, thumb_path) VALUES ($1,$2,$3,$4) RETURNING id`,
        [photoId, captureId, displayPath, thumbPath],
      );

      await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoRes.rows[0].id, captureId]);

      await client.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
         VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
         ON CONFLICT (user_id, species_id) DO UPDATE SET
           state = 'collected',
           cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
        [userId, speciesId, photoRes.rows[0].id, exif.takenAt],
      );

      // Store mode: write the full-res original into a human-browsable tree (see this
      // file's top-of-file comment) instead of a flat {uuid}.jpg, and embed species
      // metadata directly in the JPEG so it's still meaningfully organized even outside
      // Lifer. Link/s3 modes: the file already lives elsewhere (a local path, or a bucket)
      // — just remember the reference, never copy the bytes into Lifer's own storage, and
      // never rewrite its metadata (not Lifer's file to modify).
      let finalOriginalRef = originalRef;
      let managed = false;
      if (mode === "store") {
        const folder = originalsFolder(ORIGINALS_DIR, {
          organizeByYear,
          speciesFolderName: await resolveSpeciesFolderName(species.common_name, species.scientific_name),
          taxonClass: species.taxon_class,
          takenAt: exif.takenAt,
          subfolder: "Adjusted",
        });
        mkdirSync(folder, { recursive: true });
        finalOriginalRef = uniqueDestination(folder, originalFilename(fileName, exif.takenAt, photoExtension));
        writeFileSync(finalOriginalRef, buffer);
        await writeSpeciesMetadata(finalOriginalRef, [
          {
            commonName: species.common_name,
            scientificName: species.scientific_name,
            taxonClass: species.taxon_class,
            family: species.family,
          },
        ]);
        managed = true;
      }
      const refType = mode === "s3" ? "s3" : "path";

      await client.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose)
         VALUES ($1, 'jpeg', $6, $2, $3, $4, $5, $7, $8)`,
        [captureId, finalOriginalRef, managed, fingerprint, buffer.length, refType, exifFingerprint.strict, exifFingerprint.loose],
      );

      // The RAW sibling, when submitted in the same request (see this file's top comment),
      // is known to belong to this exact capture already, so it's linked directly instead
      // of going through the separate fingerprint-matching auto-link below.
      if (rawBuffer && rawFileName) {
        const rawFolder = originalsFolder(ORIGINALS_DIR, {
          organizeByYear,
          speciesFolderName: await resolveSpeciesFolderName(species.common_name, species.scientific_name),
          taxonClass: species.taxon_class,
          takenAt: exif.takenAt,
          subfolder: "RAW",
        });
        mkdirSync(rawFolder, { recursive: true });
        const rawExt = path.extname(rawFileName).toLowerCase();
        const rawDest = uniqueDestination(rawFolder, originalFilename(rawFileName, exif.takenAt, rawExt));
        writeFileSync(rawDest, rawBuffer);
        const rawHash = createHash("sha256").update(rawBuffer).digest("hex");
        await client.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose)
           VALUES ($1, 'raw', 'path', $2, true, $3, $4, $5, $6)`,
          [captureId, rawDest, rawHash, rawBuffer.length, exifFingerprint.strict, exifFingerprint.loose],
        );
      }

      // Opportunistic auto-link: a RAW sibling may already have been indexed by the
      // scan job before this JPEG was uploaded — link it now instead of waiting for the next
      // scheduled rescan. Only when exactly one unlinked RAW shares this fingerprint; the
      // indexing job's own collision handling covers the ambiguous case. Skipped entirely
      // when a RAW was already submitted directly above — this capture already has its one
      // allowed 'raw' original (UNIQUE (capture_id, kind)), so a stray pre-scanned duplicate
      // sharing the same fingerprint must stay unlinked for manual review rather than
      // erroring out the whole upload.
      //
      // Strict fingerprint first, then loose as a fallback (see exif.ts) — this JPEG may be
      // the export that already lost SubSecTimeOriginal/SerialNumber, in which case only the
      // loose match against the RAW's own strict-computed-at-index-time fingerprint can find it.
      if (!rawBuffer) {
        // Filename-stem match, already verified before this transaction even opened (see
        // above) — re-checking capture_id IS NULL here (rather than trusting that earlier
        // read) closes the small race window between that lookup and this UPDATE.
        let linked = false;
        if (filenameVerifiedRaw) {
          const res = await client.query(
            `UPDATE originals SET capture_id = $1 WHERE id = $2 AND capture_id IS NULL`,
            [captureId, filenameVerifiedRaw.id],
          );
          linked = (res.rowCount ?? 0) === 1;
          if (linked) {
            const newRef = await moveManagedOriginalToSpeciesFolder(
              filenameVerifiedRaw.ref,
              filenameVerifiedRaw.managed,
              species.common_name,
              species.scientific_name,
              "raw",
              organizeByYear,
              species.taxon_class,
              exif.takenAt,
            );
            if (newRef !== filenameVerifiedRaw.ref) {
              await client.query(`UPDATE originals SET ref = $1 WHERE id = $2`, [newRef, filenameVerifiedRaw.id]);
            }
          }
        }

        if (!linked) {
          let unlinkedRaw: { id: string; ref: string; managed: boolean }[] = [];
          if (exifFingerprint.strict) {
            const res = await client.query<{ id: string; ref: string; managed: boolean }>(
              `SELECT id, ref, managed FROM originals WHERE kind = 'raw' AND capture_id IS NULL AND exif_fingerprint = $1 LIMIT 2`,
              [exifFingerprint.strict],
            );
            unlinkedRaw = res.rows;
          }
          if (unlinkedRaw.length === 0 && exifFingerprint.loose) {
            const res = await client.query<{ id: string; ref: string; managed: boolean }>(
              `SELECT id, ref, managed FROM originals WHERE kind = 'raw' AND capture_id IS NULL AND exif_fingerprint_loose = $1 LIMIT 2`,
              [exifFingerprint.loose],
            );
            unlinkedRaw = res.rows;
          }
          if (unlinkedRaw.length === 1) {
            const match = unlinkedRaw[0];
            await client.query(`UPDATE originals SET capture_id = $1 WHERE id = $2`, [captureId, match.id]);
            const newRef = await moveManagedOriginalToSpeciesFolder(
              match.ref,
              match.managed,
              species.common_name,
              species.scientific_name,
              "raw",
              organizeByYear,
              species.taxon_class,
              exif.takenAt,
            );
            if (newRef !== match.ref) {
              await client.query(`UPDATE originals SET ref = $1 WHERE id = $2`, [newRef, match.id]);
            }
          }
        }
      }

      await client.query("COMMIT");
      return reply.code(201).send({ captureId, photoId: photoRes.rows[0].id });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
