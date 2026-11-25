// HDR renditions for the viewer (Settings > General > Show HDR photos in the viewer), kept beside
// the display previews in APP_DATA_DIR/hdr and flagged in photos.hdr_rendition. A background pass
// looks at each photo once, after imports go quiet and for photos already in the library; a photo
// whose drive is away is tried again after a restart. Never part of the normal SDR pipeline.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { log } from "@lifer/core/lib/log.js";
import { createJob } from "../../lib/job.js";
import { statFile } from "../../lib/cachedFile.js";
import { filesCaptureOf } from "../../lib/versionFiles.js";
import { resolveOriginalPath, type OriginalLocation } from "../../storageVolumes/resolve.js";
import { lastOriginalInsertAt } from "../../uploads/captureRows.js";
import { detectHdr } from "./detect.js";
import { renderHdr } from "./render.js";

export const hdrRenditionPath = (photoId: string) => path.join(APP_DATA_DIR, "hdr", `${photoId}.jpg`);
// Which original (and its version) the rendition was made from, so a re-edited, relinked or
// swapped-in file is made again rather than showing a stale picture.
const sourceNote = (photoId: string) => path.join(APP_DATA_DIR, "hdr", `${photoId}.source`);

type State = "ready" | "none";

/** Makes the rendition from the original at `file`; the state to record. */
async function make(photoId: string, file: string, mtimeMs: number): Promise<State> {
  const source = await detectHdr(file);
  const bytes = source ? await renderHdr(file, source) : null;
  if (!bytes) {
    await rm(hdrRenditionPath(photoId), { force: true });
    return "none";
  }
  await ensureDir(path.dirname(hdrRenditionPath(photoId)));
  const tmp = `${hdrRenditionPath(photoId)}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, hdrRenditionPath(photoId));
  await writeFile(sourceNote(photoId), `${file}\n${mtimeMs}`);
  return "ready";
}

const inFlight = new Map<string, Promise<State | null>>();

/** Makes (or keeps) one photo's rendition and records the outcome. Null when the original can't
 *  be read right now (its drive is away), so nothing is recorded and it's tried again later. */
export function updateHdrRendition(photoId: string, original: OriginalLocation | null): Promise<State | null> {
  const pending = inFlight.get(photoId);
  if (pending) return pending;
  const job = (async (): Promise<State | null> => {
    let state: State = "none";
    if (original) {
      const file = (await resolveOriginalPath(original)).path;
      const st = file ? await statFile(file) : null;
      if (!file || !st) return null;
      try {
        state = await make(photoId, file, st.mtimeMs);
      } catch (err) {
        // A file the HDR reader can't follow just keeps its SDR preview.
        log.warn({ err, photoId }, "[hdr] couldn't make an HDR rendition");
        state = "none";
      }
    }
    await pool.query(`UPDATE photos SET hdr_rendition = $2 WHERE id = $1`, [photoId, state]);
    return state;
  })().finally(() => inFlight.delete(photoId));
  inFlight.set(photoId, job);
  return job;
}

/** The rendition file to serve for the viewer, made again first when the original changed since.
 *  Null when the photo has none (or isn't the user's). */
export async function currentHdrRendition(photoId: string, userId: string): Promise<string | null> {
  const res = await pool.query<OriginalLocation & { hdr_rendition: string | null }>(
    // The photo's 'jpeg' original (any edited format), as the photo routes resolve it.
    `SELECT o.ref, o.volume_id, o.volume_relative_path, p.hdr_rendition
     FROM photos p
     JOIN captures_all c ON c.id = p.capture_id
     JOIN originals o ON o.capture_id = ${filesCaptureOf("c")} AND o.kind = 'jpeg'
     WHERE p.id = $1 AND c.user_id = $2`,
    [photoId, userId],
  );
  const row = res.rows[0];
  if (row?.hdr_rendition !== "ready") return null;
  const file = (await resolveOriginalPath(row)).path;
  const st = file ? await statFile(file) : null;
  const note = await readFile(sourceNote(photoId), "utf8").catch(() => "");
  const made = await statFile(hdrRenditionPath(photoId));
  // The drive is away: the last rendition still shows, as the display preview does.
  if (!st) return made ? hdrRenditionPath(photoId) : null;
  if (made && note === `${file}\n${st.mtimeMs}`) return hdrRenditionPath(photoId);
  return (await updateHdrRendition(photoId, row)) === "ready" ? hdrRenditionPath(photoId) : null;
}

export const hdrRenditionJob = createJob("hdr-renditions");
// Photos whose original couldn't be read this run; tried again after a restart.
const unreachable = new Set<string>();

/** One pass over every photo not looked at yet. Each photo's outcome is saved as it goes, so a
 *  pass stopped part way resumes where it was, and no photo is looked at twice. */
export function startHdrRenditionPass(): boolean {
  return hdrRenditionJob.start(async (ctx) => {
    const res = await pool.query<{
      id: string;
      ref: string | null;
      volume_id: string | null;
      volume_relative_path: string | null;
    }>(
      `SELECT p.id, o.ref, o.volume_id, o.volume_relative_path
       FROM photos p
       JOIN captures_all c ON c.id = p.capture_id
       LEFT JOIN originals o ON o.capture_id = ${filesCaptureOf("c")} AND o.kind = 'jpeg'
       WHERE p.hdr_rendition IS NULL AND p.display_path IS NOT NULL AND NOT (p.id = ANY($1::uuid[]))`,
      [[...unreachable]],
    );
    ctx.update({ total: res.rows.length, processed: 0 });
    let processed = 0;
    for (const row of res.rows) {
      ctx.throwIfCancelled();
      const state = await updateHdrRendition(row.id, row.ref ? { ...row, ref: row.ref } : null).catch(() => null);
      if (state === null) unreachable.add(row.id);
      ctx.update({ processed: ++processed });
    }
    return null;
  });
}

const IMPORT_QUIET_MS = 15_000;
const TICK_MS = 30_000;

/** Starts a pass whenever photos are waiting and imports have gone quiet. */
export function scheduleHdrRenditions(): void {
  const tick = async () => {
    if (hdrRenditionJob.status.running || Date.now() - lastOriginalInsertAt < IMPORT_QUIET_MS) return;
    const any = await pool.query(
      `SELECT 1 FROM photos WHERE hdr_rendition IS NULL AND display_path IS NOT NULL AND NOT (id = ANY($1::uuid[])) LIMIT 1`,
      [[...unreachable]],
    );
    if (any.rowCount) startHdrRenditionPass();
  };
  setInterval(() => void tick().catch((err) => log.warn({ err }, "[hdr] pass failed")), TICK_MS).unref();
}
