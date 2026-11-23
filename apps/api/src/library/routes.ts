// Library reimport. Reading every file's EXIF and rebuilding derivatives takes minutes, so it's a
// single background job the client polls.
import { CULL_MARKS_OPTIONS, idleJobStatus, type CullMarksOption } from "@lifer/shared";
import { cp, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Type } from "typebox";
import sharp from "sharp";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { claimedPhotoFormat, sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import { prepareWorkingImage, type WorkingImage } from "../uploads/workingImage.js";
import { requireAuth } from "../auth/session.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { Ok, Uuid, replies, withSchemas } from "../lib/schema.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import {
  listManagedFiles,
  recoverJpeg,
  recoverRaw,
  findMissingReferenceData,
  ignoreLibraryFile,
  type VolumeContext,
} from "./reimport.js";
import { resolveChosenVolumeDestination } from "../storageVolumes/resolve.js";
import { friendlyFsErrorMessage } from "../lib/friendlyFsError.js";
import { libraryFolderStatus } from "@lifer/core/lib/libraryFolder.js";
import {
  isLiferLibrary,
  libraryRecord,
  mergeLibraryRecord,
  restoreCards,
  restoreCollectionState,
  restoreOtherTaxa,
} from "../lib/collectionState.js";
import { pool } from "@lifer/core/db.js";
import { candidateNames, lookUpName, type SpeciesSuggestion } from "./unmatchedSuggestions.js";
import { fetchPackIndex } from "../offlinePacks/index.js";
import { restoreLibraryRecords } from "../lib/libraryRecords.js";
import { createJob, describeError, type JobContext } from "../lib/job.js";
import { log } from "@lifer/core/lib/log.js";
import { stemOf } from "../trips/rawLink.js";
import { catchUpPhotoBackfills } from "../species/embeddingBackfill.js";

// Each file costs an exiftool round-trip and often a resize, so files run in parallel.
const CONCURRENCY = 4;

interface UnmatchedFile {
  relativePath: string;
  contentHash: string | null;
  /** Set only when several species matched; null means no species tag was found. */
  scientificNames: string[] | null;
  /** iNaturalist's guess from the photo's tags or folder, for the user to confirm. */
  suggestion?: SpeciesSuggestion | null;
}

// Live counters, top-level on the status next to the shared JobStatus fields. Phases are
// "jpegs" then "raws"; processed/total track the current phase.
interface ReimportExtra {
  processedJpegs: number;
  totalJpegs: number;
  processedRaws: number;
  totalRaws: number;
  jpegsRecovered: number;
  jpegsAlreadyKnown: number;
  jpegsRelinked: number;
  /** Left in place by an earlier import, now moved into the library. */
  jpegsMoved: number;
  jpegsIgnored: number;
  /** Rejected in a culling app and left out, as the reimport's cullMarks option asked. */
  jpegsRejected: number;
  /** Rejected in a culling app and recovered hidden. */
  jpegsHidden: number;
  // Unrecognized and ambiguous files form one review list; both can be ignored so they stop
  // resurfacing.
  unmatched: UnmatchedFile[];
  rawsRecovered: number;
  rawsAlreadyKnown: number;
  rawsRelinked: number;
  rawsMoved: number;
  rawsUnmatched: number;
}

// Distinct scientific names this run recovered that have no reference photo/description in
// the current catalog, the direct input to the pack-recommendation feature.
interface ReimportResult {
  missingReferenceData: string[];
}

function freshExtra(): ReimportExtra {
  return {
    processedJpegs: 0,
    totalJpegs: 0,
    processedRaws: 0,
    totalRaws: 0,
    jpegsRecovered: 0,
    jpegsAlreadyKnown: 0,
    jpegsRelinked: 0,
    jpegsMoved: 0,
    jpegsIgnored: 0,
    jpegsRejected: 0,
    jpegsHidden: 0,
    unmatched: [],
    rawsRecovered: 0,
    rawsAlreadyKnown: 0,
    rawsRelinked: 0,
    rawsMoved: 0,
    rawsUnmatched: 0,
  };
}

const reimportJob = createJob<ReimportResult, ReimportExtra>("library-reimport", freshExtra());
// Root the current job's relative paths resolve against. Server-side only, for previews.
let jobWalkDir: string | null = null;
// Whose scan the shared job belongs to. A server can have several accounts; only the one that
// started it may see its unmatched files (and their previews), cancel it, or ignore from it.
let jobUserId: string | null = null;
// How the current job imports, so a photo the user assigns later goes in the same way.
let jobImport: {
  volumeContext: VolumeContext | null;
  organize: boolean;
  foreign: boolean;
  cullOption: CullMarksOption;
} | null = null;

function isJobOwner(userId: string): boolean {
  return jobUserId == null || jobUserId === userId;
}

// Looks up a species for each photo nothing matched, from its tags or folder. One lookup per
// distinct name; stops quietly when offline, leaving the rest without a suggestion. Only with
// "Search iNaturalist" on, the setting that tells the user names are sent there.
async function suggestSpecies(
  ctx: JobContext<ReimportResult, ReimportExtra>,
  userId: string,
  unmatched: UnmatchedFile[],
  tagsByPath: Map<string, string[]>,
): Promise<void> {
  const setting = await pool.query<{ any_taxa_search_enabled: boolean }>(
    `SELECT any_taxa_search_enabled FROM users WHERE id = $1`,
    [userId],
  );
  if (!setting.rows[0]?.any_taxa_search_enabled) return;
  const pending = unmatched.filter((f) => f.scientificNames === null && f.contentHash);
  if (pending.length === 0) return;
  ctx.update({ phase: "suggestions", processed: 0, total: pending.length, currentItem: null });
  const byName = new Map<string, SpeciesSuggestion | null>();
  let offline = false;
  for (const [i, file] of pending.entries()) {
    if (ctx.signal.aborted || offline) break;
    for (const name of candidateNames(file.relativePath, tagsByPath.get(file.relativePath) ?? [])) {
      if (!byName.has(name)) {
        try {
          byName.set(name, await lookUpName(name));
        } catch {
          offline = true;
          break;
        }
      }
      const found = byName.get(name);
      if (found) {
        file.suggestion = found;
        if (found.exact) break;
      }
    }
    ctx.update({ processed: i + 1 });
  }
}

// Cancel is checked between files: in-flight files finish, no new one starts.
async function runReimportJob(
  ctx: JobContext<ReimportResult, ReimportExtra>,
  userId: string,
  walkDir: string,
  volumeContext: VolumeContext | null,
  organize: boolean,
  foreign: boolean,
  cullOption: CullMarksOption,
): Promise<ReimportResult> {
  const job = reimportJob.status;
  try {
    const { jpegs, raws } = await listManagedFiles(walkDir);
    ctx.update({ totalJpegs: jpegs.length, totalRaws: raws.length, phase: "jpegs", processed: 0, total: jpegs.length });
    // A reject on a photo's RAW twin (same file stem) counts for the photo too, as at upload.
    const rawsByStem = new Map<string, string[]>();
    for (const raw of raws) {
      const stem = stemOf(path.basename(raw));
      rawsByStem.set(stem, [...(rawsByStem.get(stem) ?? []), raw]);
    }

    const recoveredScientificNames = new Set<string>();
    // Another Lifer library brings its own record; anything else leans on this library's.
    const recordDir = foreign && isLiferLibrary(walkDir) ? walkDir : ORIGINALS_DIR;
    // Hand-added species first, so photos filed under them match.
    await restoreOtherTaxa(userId, recordDir).catch((err) =>
      log.warn(`[collection-state] couldn't re-add hand-added species: ${(err as Error).message}`),
    );
    const tagsByPath = new Map<string, string[]>();

    // JPEGs first, in full: RAW recovery matches against already committed JPEG captures.
    await mapWithConcurrency(jpegs, CONCURRENCY, async (absolutePath) => {
      if (ctx.signal.aborted) return;
      const relativePath = path.relative(walkDir, absolutePath);
      ctx.update({ currentItem: relativePath });
      try {
        const outcome = await recoverJpeg(userId, absolutePath, volumeContext, organize, foreign, {
          option: cullOption,
          raws: rawsByStem.get(stemOf(path.basename(absolutePath))),
        });
        if (outcome.status === "recovered") {
          job.jpegsRecovered++;
          if (outcome.hidden) job.jpegsHidden++;
          recoveredScientificNames.add(outcome.scientificName);
        } else if (outcome.status === "rejected") {
          job.jpegsRejected++;
        } else if (outcome.status === "already-known") {
          job.jpegsAlreadyKnown++;
        } else if (outcome.status === "relinked") {
          job.jpegsRelinked++;
        } else if (outcome.status === "moved") {
          job.jpegsMoved++;
        } else if (outcome.status === "ignored") {
          job.jpegsIgnored++;
        } else if (outcome.status === "unrecognized") {
          tagsByPath.set(relativePath, outcome.candidates);
          job.unmatched.push({ relativePath, contentHash: outcome.contentHash, scientificNames: null });
        } else {
          job.unmatched.push({
            relativePath,
            contentHash: outcome.contentHash,
            scientificNames: outcome.scientificNames,
          });
        }
      } catch (err) {
        job.unmatched.push({
          relativePath: `${relativePath} (error: ${(err as Error).message})`,
          contentHash: null,
          scientificNames: null,
        });
      } finally {
        job.processedJpegs++;
        ctx.update({ processed: job.processedJpegs });
      }
    });
    ctx.throwIfCancelled();

    ctx.update({ phase: "raws", processed: 0, total: raws.length });
    await mapWithConcurrency(raws, CONCURRENCY, async (absolutePath) => {
      if (ctx.signal.aborted) return;
      ctx.update({ currentItem: path.relative(walkDir, absolutePath) });
      try {
        const outcome = await recoverRaw(userId, absolutePath, volumeContext, organize, foreign);
        if (outcome.status === "recovered") job.rawsRecovered++;
        else if (outcome.status === "already-known") job.rawsAlreadyKnown++;
        else if (outcome.status === "relinked") job.rawsRelinked++;
        else if (outcome.status === "moved") job.rawsMoved++;
        else job.rawsUnmatched++;
      } catch {
        job.rawsUnmatched++;
      } finally {
        job.processedRaws++;
        ctx.update({ processed: job.processedRaws });
      }
    });
    ctx.throwIfCancelled();

    await suggestSpecies(ctx, userId, job.unmatched, tagsByPath);

    if (recordDir === ORIGINALS_DIR) {
      // Pointing a fresh install at an old library: also bring back archived, hidden, seen and
      // target species from the library's own record (only if this install has none of its own).
      await restoreCollectionState(userId).catch((err) =>
        log.warn(`[collection-state] couldn't restore: ${(err as Error).message}`),
      );
      // Card covers and crops, now that the photos they point at are back.
      await restoreCards(userId).catch((err) =>
        log.warn(`[collection-state] couldn't restore card covers: ${(err as Error).message}`),
      );
    } else {
      // Another Lifer library: whatever its record has that this one doesn't, added alongside.
      await mergeLibraryRecord(userId, recordDir).catch((err) =>
        log.warn(`[collection-state] couldn't merge the library's record: ${(err as Error).message}`),
      );
    }
    // And trips (from each trip folder's .lifer/trip.json) and album details, now that the photos
    // they point at are back.
    await restoreLibraryRecords(userId, walkDir)
      .then((r) => {
        if (r.trips || r.albums) log.info(r, "[library-records] restored trips and album details");
      })
      .catch((err) => log.warn(`[library-records] couldn't restore: ${(err as Error).message}`));
    if (job.jpegsRecovered > 0) catchUpPhotoBackfills();
    return { missingReferenceData: await findMissingReferenceData([...recoveredScientificNames]) };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(friendlyFsErrorMessage(err), { cause: err });
  }
}

function startScan(
  userId: string,
  walkDir: string,
  volumeContext: VolumeContext | null,
  organize: boolean,
  foreign: boolean,
  cullOption: CullMarksOption,
): boolean {
  const started = reimportJob.start(
    (ctx) => runReimportJob(ctx, userId, walkDir, volumeContext, organize, foreign, cullOption),
    freshExtra(),
  );
  if (!started) return false;
  jobWalkDir = walkDir;
  jobUserId = userId;
  jobImport = { volumeContext, organize, foreign, cullOption };
  return true;
}

/** The scan a watched folder triggers: in place, culling rejects left out, like a folder import. */
export function startWatchedFolderScan(userId: string, folder: string): boolean {
  return startScan(userId, folder, null, false, true, "skip");
}

/** A folder import a connected app asked for: files stay where they are (`copy` false) or a copy is
 *  staged in the library and filed by species. Returns false while another scan runs. */
export function startFolderImport(userId: string, folder: string, copy: boolean): boolean {
  if (!copy) return startScan(userId, folder, null, false, true, "skip");
  const staged = path.join(ORIGINALS_DIR, "Imported by apps", `${path.basename(folder)} ${Date.now()}`);
  const started = reimportJob.start(async (ctx) => {
    ctx.update({ phase: "copying", currentItem: path.basename(folder) });
    await cp(folder, staged, { recursive: true });
    ctx.throwIfCancelled();
    return runReimportJob(ctx, userId, staged, null, true, true, "skip");
  }, freshExtra());
  if (!started) return false;
  jobWalkDir = staged;
  jobUserId = userId;
  jobImport = { volumeContext: null, organize: true, foreign: true, cullOption: "skip" };
  return true;
}

/** The progress of the current scan, for the owner only. */
export function folderImportProgress(userId: string) {
  const s = reimportJob.status;
  if (!isJobOwner(userId)) return { running: s.running, processed: 0, total: 0 };
  const done = s.processedJpegs + s.processedRaws;
  return {
    running: s.running,
    processed: done,
    total: s.totalJpegs + s.totalRaws,
    imported: s.jpegsRecovered + s.rawsRecovered,
    alreadyHad: s.jpegsAlreadyKnown + s.rawsAlreadyKnown,
    skipped: s.jpegsRejected + s.jpegsIgnored,
    needReview: s.unmatched.length + s.rawsUnmatched,
    error: s.error,
    cancelled: s.cancelled,
  };
}

export async function libraryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Polled by the app's banner: is the photo library folder still there?
  app.get("/library/folder-status", { preValidation: requireAuth, schema: {} }, async () => libraryFolderStatus());

  // Setup asks whether the chosen folder already holds a Lifer library, to offer back the
  // countries and animal groups it had and then its photos (a reimport).
  app.get(
    "/library/existing",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            found: Type.Boolean(),
            regions: Type.Array(Type.String({ description: "Country names, as the region list has them" })),
            taxa: Type.Array(Type.String({ description: "Animal groups; empty means every group" })),
            checked: Type.Boolean({
              description:
                "False when the list of downloads couldn't be reached: regions and taxa are unknown, not none",
            }),
          }),
        ),
      },
    },
    async () => {
      const record = libraryRecord();
      if (!record) return { found: false, regions: [], taxa: [], checked: true };
      const ids = new Set(record.packs ?? []);
      // Offline-first: an unreachable list means "couldn't check yet", never "it had nothing".
      const index = ids.size > 0 ? await fetchPackIndex().catch(() => null) : null;
      if (ids.size > 0 && !index) return { found: true, regions: [], taxa: [], checked: false };
      const entries = (index?.packs ?? []).filter((p) => ids.has(p.id) || ids.has(`${p.id}.small`));
      const regions = [...new Set(entries.map((p) => p.region).filter((r): r is string => !!r))];
      // An all-groups download (no taxon) means every group.
      const taxa = entries.some((p) => p.region && !p.taxon)
        ? []
        : [...new Set(entries.map((p) => p.taxon).filter((t): t is string => !!t))];
      return { found: true, regions, taxa, checked: true };
    },
  );

  // The import picker asks whether a folder is another Lifer library, to say everything comes
  // back with it (seen, targets, card covers, trips and albums), not just photos.
  app.get(
    "/library/inspect-folder",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ path: Type.String({ minLength: 1 }) }),
        response: replies(Type.Object({ liferLibrary: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      if (!path.isAbsolute(request.query.path))
        return reply.code(400).send({ error: "path must be an absolute folder path" });
      return { liferLibrary: isLiferLibrary(assertAllowedPath(request.query.path)) };
    },
  );

  // Imports unmatched photos from the last scan as the species the user confirmed (usually
  // iNaturalist's suggestion), adding it as a hand-added species when the catalog lacks it.
  app.post(
    "/library/reimport/assign",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            contentHashes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 500 }),
            inatTaxonId: Type.Integer({ minimum: 1 }),
            scientificName: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ assigned: Type.Integer() })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (reimportJob.status.running) return reply.code(409).send({ error: "Wait for the scan to finish" });
      if (!isJobOwner(userId) || !jobWalkDir || !jobImport)
        return reply.code(409).send({ error: "Scan the folder again first" });
      const { contentHashes, inatTaxonId, scientificName } = request.body;
      const inCatalog = await pool.query<{ id: string }>(
        `SELECT id FROM species WHERE inat_taxon_id = $1 OR lower(scientific_name) = lower($2)
         ORDER BY is_other_taxa ASC LIMIT 1`,
        [inatTaxonId, scientificName],
      );
      let speciesId = inCatalog.rows[0]?.id;
      if (!speciesId) {
        const { resolveOrCreateOtherTaxaSpecies } = await import("../species/otherTaxaSpecies.js");
        try {
          ({ speciesId } = await resolveOrCreateOtherTaxaSpecies(inatTaxonId, { enrichLater: true }));
        } catch (err) {
          request.log.warn({ err }, "Couldn't add the taxon");
          return reply.code(502).send({ error: describeError(err) });
        }
      }
      const wanted = new Set(contentHashes);
      const files = reimportJob.status.unmatched.filter((f) => f.contentHash && wanted.has(f.contentHash));
      // A new scan during the loop replaces both; this request keeps to the scan it was sent for.
      const walkDir = jobWalkDir;
      const scan = jobImport;
      const { volumeContext, organize, foreign, cullOption } = scan;
      const done = new Set<string>();
      let recovered = 0;
      for (const file of files) {
        const outcome = await recoverJpeg(
          userId,
          path.join(walkDir, file.relativePath),
          volumeContext,
          organize,
          foreign,
          { option: cullOption },
          speciesId,
        ).catch(() => null);
        if (outcome && outcome.status !== "unrecognized" && outcome.status !== "ambiguous") {
          done.add(file.contentHash!);
          if (outcome.status === "recovered") recovered++;
        }
      }
      if (jobImport === scan) {
        reimportJob.status.jpegsRecovered += recovered;
        reimportJob.status.unmatched = reimportJob.status.unmatched.filter(
          (f) => !f.contentHash || !done.has(f.contentHash),
        );
      }
      if (done.size > 0) catchUpPhotoBackfills();
      return { assigned: done.size };
    },
  );

  app.post(
    "/library/reimport",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            volumeId: Type.Optional(Uuid()),
            path: Type.Optional(Type.String()),
            organize: Type.Optional(Type.Boolean()),
            cullMarks: Type.Optional(
              Type.Enum([...CULL_MARKS_OPTIONS], {
                description:
                  "Photos a culling app rejected: skip leaves them out (the default for a folder path), hide recovers them hidden (the default when rescanning the library), ignore recovers them as usual",
              }),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      if (reimportJob.status.running) return reply.code(409).send({ error: "A reimport is already running" });
      const userId = request.user!.id;

      // volumeId walks that drive's "Lifer Originals" folder (as a store-mode upload would use) and
      // repairs known files whose ref or volume drifted.
      // `path` is a folder from another app's layout; `organize` (only with it) moves matched files into
      // Lifer's species folders.
      let walkDir = ORIGINALS_DIR;
      let volumeContext: VolumeContext | null = null;
      if (request.body.path) {
        if (!path.isAbsolute(request.body.path))
          return reply.code(400).send({ error: "path must be an absolute folder path" });
        const candidate = assertAllowedPath(request.body.path);
        if (!(await isDirectory(candidate))) {
          return reply.code(400).send({ error: "That folder doesn't exist" });
        }
        walkDir = candidate;
      } else if (request.body.volumeId) {
        const resolved = await resolveChosenVolumeDestination(userId, request.body.volumeId);
        if (!resolved) return reply.code(400).send({ error: "That drive isn't connected right now" });
        walkDir = resolved.baseDir;
        volumeContext = resolved;
      }

      const organize = Boolean(request.body.organize);

      // Background job, polled via /status.
      const foreign = Boolean(request.body.path);
      const cullOption = request.body.cullMarks ?? (foreign ? "skip" : "hide");
      if (!startScan(userId, walkDir, volumeContext, organize, foreign, cullOption))
        return reply.code(409).send({ error: "A reimport is already running" });

      return { started: true };
    },
  );

  app.get("/library/reimport/status", { preValidation: requireAuth, schema: {} }, async (request) => {
    if (isJobOwner(request.user!.id)) return reimportJob.status;
    // Someone else's scan: report only that one is running, none of its results.
    return { ...idleJobStatus<ReimportResult>(), ...freshExtra(), running: reimportJob.status.running };
  });

  // Stops between files; in-flight files finish and queued ones are left untouched.
  app.post(
    "/library/reimport/cancel",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id)) return reply.code(409).send({ error: "No reimport is running" });
      if (!reimportJob.cancel()) return reply.code(409).send({ error: "No reimport is running" });
      return { ok: true };
    },
  );

  // Marks an unmatched file so it stops resurfacing, and drops it from the current job's list.
  app.post(
    "/library/ignore",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ contentHash: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request) => {
      const { contentHash } = request.body;
      await ignoreLibraryFile(request.user!.id, contentHash);
      if (isJobOwner(request.user!.id)) {
        reimportJob.status.unmatched = reimportJob.status.unmatched.filter((f) => f.contentHash !== contentHash);
      }
      return { ok: true };
    },
  );

  // A small thumbnail of one unmatched file for the review UI. The file is picked from the last
  // scan's own list (by position or content hash), never from a client-supplied path.
  async function sendUnmatchedPreview(entry: { relativePath: string } | undefined, reply: FastifyReply) {
    if (!entry || !jobWalkDir) return reply.code(404).send({ error: "Not found" });
    const absolutePath = path.join(jobWalkDir, entry.relativePath);
    if (!(await stat(absolutePath).catch(() => null))) return reply.code(404).send({ error: "Not found" });
    let working: WorkingImage | null = null;
    try {
      // A HEIC is read through its working JPEG, since sharp can't decode it.
      const format = (await sniffPhotoFormat(absolutePath)) ?? claimedPhotoFormat(null, absolutePath);
      if (format === "heic") working = await prepareWorkingImage(absolutePath, format);
      const source = working?.decodePath ?? absolutePath;
      const buffer = await sharp(source, originalSharpOptions())
        .rotate()
        .resize({ width: 300, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      reply.header("Content-Type", "image/webp");
      return reply.send(buffer);
    } catch {
      return reply.code(404).send({ error: "Couldn't read this file" });
    } finally {
      await working?.release();
    }
  }

  app.get(
    "/library/reimport/unmatched-preview/:index",
    {
      preValidation: requireAuth,
      // A bad index is a file that isn't in the list, as before.
      config: { invalidInput: { params: { status: 404, error: "Not found" } } },
      schema: { params: Type.Object({ index: Type.Integer({ minimum: 0 }) }) },
    },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id)) return reply.code(404).send({ error: "Not found" });
      return sendUnmatchedPreview(reimportJob.status.unmatched[request.params.index], reply);
    },
  );

  // Keyed by content hash, so a preview stays right when the list changes (a file ignored or
  // assigned shifts every index after it).
  app.get(
    "/library/reimport/unmatched-preview-by-hash/:hash",
    { preValidation: requireAuth, schema: { params: Type.Object({ hash: Type.String({ minLength: 1 }) }) } },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id)) return reply.code(404).send({ error: "Not found" });
      return sendUnmatchedPreview(
        reimportJob.status.unmatched.find((f) => f.contentHash === request.params.hash),
        reply,
      );
    },
  );
}
