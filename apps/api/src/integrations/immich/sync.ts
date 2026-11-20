// Brings photos from the user's chosen Immich albums into Lifer by reference: the original stays in
// Immich, Lifer keeps the capture and its derivatives. Each asset is looked at once (immich_assets);
// a later sync reads only new assets, and unrecognized ones again when Immich's updated time moves.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { ensureRoom } from "@lifer/core/lib/freeSpace.js";
import { log } from "@lifer/core/lib/log.js";
import { generateDerivatives } from "@lifer/core/uploads/image.js";
import { isRawFile } from "@lifer/core/uploads/formats.js";
import { createJob, type Job, type JobContext } from "../../lib/job.js";
import { SECRET_CONTEXT, SecretUnavailableError, secretBox, type SecretBox } from "../../lib/secretBox.js";
import { uploadTempDir } from "../../lib/uploadWorkDir.js";
import { markCollected } from "../../lib/userSpecies.js";
import { ensureDefaultCardCropLater } from "../../collection/defaultCardCrop.js";
import { proposeIdentificationForFile } from "../../captures/identification.js";
import { catchUpPhotoBackfills } from "../../species/embeddingBackfill.js";
import { groupByScientificName, matchSpeciesByKeywords } from "../../species/matchByKeywords.js";
import { matchSpeciesFromFilename } from "../../species/matchByFilename.js";
import { insertCapture } from "../../uploads/captureRows.js";
import { derivativeFiles, removeFiles, uploadTempPath } from "../../uploads/common.js";
import {
  computeExifFingerprint,
  extractExif,
  extractKeywordsWithSidecar,
  extractLocationLabel,
  readExifTags,
} from "../../uploads/exif.js";
import { computeContentHash } from "../../uploads/fileFingerprint.js";
import { ImmichClient, type ImmichAsset } from "./client.js";

export interface ImmichLink {
  serverUrl: string;
  apiKey: string;
  serverVersion: string;
  albumIds: string[];
  writeTags: boolean;
  lastSyncAt: Date | null;
  lastError: string | null;
}

type Outcome = "imported" | "duplicate" | "unrecognized" | "skipped";

export interface SyncResult {
  imported: number;
  duplicates: number;
  unrecognized: number;
  skipped: number;
  failed: number;
  tagged: number;
}

export async function saveLink(
  userId: string,
  link: { serverUrl: string; apiKey: string; serverVersion: string },
  box: SecretBox = secretBox,
): Promise<void> {
  // A different server's albums mean nothing here, so they're cleared; the same server keeps them.
  await pool.query(
    `INSERT INTO immich_links (user_id, server_url, api_key, server_version) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       album_ids = CASE WHEN immich_links.server_url = EXCLUDED.server_url THEN immich_links.album_ids ELSE '{}' END,
       server_url = EXCLUDED.server_url, api_key = EXCLUDED.api_key,
       server_version = EXCLUDED.server_version, last_error = NULL, linked_at = now()`,
    [userId, link.serverUrl, box.encrypt(link.apiKey, SECRET_CONTEXT.immichApiKey), link.serverVersion],
  );
}

/** The user's link, or null when there's none or its key can't be decrypted (link again). */
export async function loadLink(userId: string, box: SecretBox = secretBox): Promise<ImmichLink | null> {
  const res = await pool.query<{
    server_url: string;
    api_key: string;
    server_version: string;
    album_ids: string[];
    write_tags: boolean;
    last_sync_at: Date | null;
    last_error: string | null;
  }>(`SELECT * FROM immich_links WHERE user_id = $1`, [userId]);
  const row = res.rows[0];
  if (!row) return null;
  try {
    return {
      serverUrl: row.server_url,
      apiKey: box.decrypt(row.api_key, SECRET_CONTEXT.immichApiKey),
      serverVersion: row.server_version,
      albumIds: row.album_ids,
      writeTags: row.write_tags,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
    };
  } catch (err) {
    if (!(err instanceof SecretUnavailableError)) throw err;
    log.warn("[immich] The stored Immich API key can't be decrypted (its key file is missing); link again");
    return null;
  }
}

const jobs = new Map<string, Job<SyncResult>>();

/** One sync job per user, so two people on a server can sync at once. */
export function syncJob(userId: string): Job<SyncResult> {
  let job = jobs.get(userId);
  if (!job) {
    job = createJob<SyncResult>(`immich-sync-${userId}`);
    jobs.set(userId, job);
  }
  return job;
}

export async function runSync(userId: string, ctx: JobContext<SyncResult>): Promise<SyncResult> {
  const link = await loadLink(userId);
  if (!link) throw new Error("Link an Immich server first.");
  const client = new ImmichClient(link.serverUrl, link.apiKey);
  const result: SyncResult = { imported: 0, duplicates: 0, unrecognized: 0, skipped: 0, failed: 0, tagged: 0 };
  try {
    ctx.update({ phase: "listing" });
    const assets = new Map<string, ImmichAsset>();
    for (const albumId of link.albumIds) {
      ctx.throwIfCancelled();
      for (const a of (await client.albumAssets(albumId, ctx.signal)).assets) assets.set(a.id, a);
    }
    const seen = await pool.query<{ immich_asset_id: string; immich_updated_at: Date; outcome: Outcome }>(
      `SELECT immich_asset_id, immich_updated_at, outcome FROM immich_assets WHERE user_id = $1`,
      [userId],
    );
    const known = new Map(seen.rows.map((r) => [r.immich_asset_id, r]));
    const todo = [...assets.values()].filter((a) => {
      const row = known.get(a.id);
      return !row || (row.outcome === "unrecognized" && row.immich_updated_at.getTime() !== Date.parse(a.updatedAt));
    });

    ctx.update({ phase: "importing", processed: 0, total: todo.length });
    for (const [i, asset] of todo.entries()) {
      ctx.throwIfCancelled();
      ctx.update({ currentItem: asset.originalFileName });
      try {
        const { outcome, captureId } = await importAsset(userId, client, asset, ctx.signal);
        await recordAsset(userId, asset, outcome, captureId);
        result[outcome === "duplicate" ? "duplicates" : outcome]++;
      } catch (err) {
        if (ctx.signal.aborted || (err as { code?: string }).code === "disk_full") throw err;
        result.failed++;
        log.warn({ assetId: asset.id, err: (err as Error).message }, "[immich] couldn't bring in an asset");
      }
      ctx.update({ processed: i + 1 });
    }
    if (link.writeTags) {
      ctx.update({ phase: "tagging", currentItem: null });
      result.tagged = await writeSpeciesTags(userId, client);
    }
    await pool.query(`UPDATE immich_links SET last_sync_at = now(), last_error = NULL WHERE user_id = $1`, [userId]);
  } catch (err) {
    if (!ctx.signal.aborted)
      await pool.query(`UPDATE immich_links SET last_error = $2 WHERE user_id = $1`, [userId, (err as Error).message]);
    throw err;
  } finally {
    if (result.imported > 0) catchUpPhotoBackfills();
  }
  return result;
}

async function recordAsset(userId: string, a: ImmichAsset, outcome: Outcome, captureId: string | null) {
  await pool.query(
    `INSERT INTO immich_assets (user_id, immich_asset_id, capture_id, immich_updated_at, checksum, outcome)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, immich_asset_id) DO UPDATE SET capture_id = EXCLUDED.capture_id,
       immich_updated_at = EXCLUDED.immich_updated_at, checksum = EXCLUDED.checksum, outcome = EXCLUDED.outcome`,
    [userId, a.id, captureId, a.updatedAt, a.checksum, outcome],
  );
}

async function importAsset(
  userId: string,
  client: ImmichClient,
  asset: ImmichAsset,
  signal: AbortSignal,
): Promise<{ outcome: Outcome; captureId: string | null }> {
  // shortcut: videos and RAW originals are skipped; bring them in once Lifer reads RAW previews from Immich.
  if (asset.type !== "IMAGE" || asset.isTrashed) return { outcome: "skipped", captureId: null };

  // The same file in another album (Immich's checksum) or already in Lifer (its sha256).
  const twin = await pool.query<{ capture_id: string }>(
    `SELECT capture_id FROM immich_assets WHERE user_id = $1 AND checksum = $2 AND capture_id IS NOT NULL LIMIT 1`,
    [userId, asset.checksum],
  );
  if (twin.rows[0]) return { outcome: "duplicate", captureId: twin.rows[0].capture_id };

  await ensureRoom(uploadTempDir(), asset.exifInfo?.fileSizeInByte ?? 0);
  const file = await uploadTempPath(asset.originalFileName);
  try {
    await client.downloadOriginal(asset.id, file, signal);
    if (await isRawFile(file, asset.originalFileName)) return { outcome: "skipped", captureId: null };
    const contentHash = await computeContentHash(file);
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM captures_all WHERE user_id = $1 AND fingerprint = $2 LIMIT 1`,
      [userId, contentHash],
    );
    if (existing.rows[0]) return { outcome: "duplicate", captureId: existing.rows[0].id };
    const captureId = await fileAsCapture(userId, file, asset.originalFileName, contentHash);
    return captureId ? { outcome: "imported", captureId } : { outcome: "unrecognized", captureId: null };
  } finally {
    await rm(file, { force: true });
  }
}

/** The library reimport's species matching (keywords, then file name, then a confident suggestion),
 *  and its rows, without an originals row: the original lives in Immich. Null when unrecognized. */
async function fileAsCapture(
  userId: string,
  file: string,
  fileName: string,
  contentHash: string,
): Promise<string | null> {
  const tags = await readExifTags(file);
  const exif = await extractExif(file, tags);
  const keywords = await extractKeywordsWithSidecar(file, tags);
  let matches = [
    ...(await matchSpeciesByKeywords(pool, keywords)),
    ...(await matchSpeciesFromFilename(pool, path.basename(fileName, path.extname(fileName)))),
  ];
  let filing: Awaited<ReturnType<typeof proposeIdentificationForFile>> = null;
  if (matches.length === 0) {
    filing = await proposeIdentificationForFile(userId, file, exif.lat, exif.lon, exif.takenAt);
    if (filing) {
      const res = await pool.query(
        `SELECT id, scientific_name, common_name, taxon_class, family FROM species WHERE id = $1`,
        [filing.speciesId],
      );
      matches = res.rows;
    }
  }
  const byName = groupByScientificName(matches);
  // Two different species, or one name on several rows: left for the user, never guessed.
  if (byName.size !== 1) return null;
  const rows = [...byName.values()][0];
  if (rows.length !== 1) return null;
  const species = rows[0];

  const exifFingerprint = await computeExifFingerprint(file, tags);
  const photoId = randomUUID();
  const derivatives = await generateDerivatives(file, photoId).catch((err: unknown) => {
    removeFiles(derivativeFiles(photoId));
    throw err;
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const captureId = await insertCapture(client, {
      userId,
      speciesId: species.id,
      fingerprint: contentHash,
      exifFingerprint,
      exif,
      locationLabel: extractLocationLabel(tags),
      ...(filing && {
        regionId: filing.regionId,
        identificationState: "suggested" as const,
        suggestionPercent: filing.matchPercent,
      }),
    });
    await client.query(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6)`,
      [photoId, captureId, derivatives.displayPath, derivatives.thumbPath, derivatives.width, derivatives.height],
    );
    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);
    await markCollected(client, userId, species.id, photoId, exif.takenAt);
    await client.query("COMMIT");
    ensureDefaultCardCropLater(userId, species.id);
    return captureId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    removeFiles(derivativeFiles(photoId));
    throw err;
  } finally {
    client.release();
  }
}

/** Puts "Lifer/<species>" on each asset whose photo the user confirmed, and moves it when the
 *  species changes or the photo goes. Only tags under "Lifer/" are ever touched. Returns how many
 *  assets changed. */
export async function writeSpeciesTags(userId: string, client: ImmichClient): Promise<number> {
  const res = await pool.query<{ immich_asset_id: string; tagged_as: string | null; wanted: string | null }>(
    `SELECT a.immich_asset_id, a.tagged_as, 'Lifer/' || COALESCE(s.common_name, s.scientific_name) AS wanted
       FROM immich_assets a
       LEFT JOIN captures c ON c.id = a.capture_id AND c.identification_state = 'confirmed'
       LEFT JOIN species s ON s.id = c.species_id
      WHERE a.user_id = $1`,
    [userId],
  );
  const changed = res.rows.filter((r) => r.tagged_as !== r.wanted);
  if (changed.length === 0) return 0;

  const group = (pick: (r: (typeof changed)[number]) => string | null) => {
    const by = new Map<string, string[]>();
    for (const r of changed) {
      const tag = pick(r);
      if (tag) by.set(tag, [...(by.get(tag) ?? []), r.immich_asset_id]);
    }
    return by;
  };
  const remove = group((r) => r.tagged_as);
  if (remove.size > 0) {
    const ids = new Map((await client.tags()).map((t) => [t.value, t.id]));
    for (const [value, assetIds] of remove) {
      const id = ids.get(value);
      // Already removed in Immich: nothing left to undo.
      if (id) await client.untagAssets(id, assetIds);
    }
  }
  const add = group((r) => r.wanted);
  if (add.size > 0) {
    const ids = new Map((await client.upsertTags([...add.keys()])).map((t) => [t.value, t.id]));
    for (const [value, assetIds] of add) {
      const id = ids.get(value);
      if (id) await client.tagAssets(id, assetIds);
    }
  }
  await pool.query(
    `UPDATE immich_assets a SET tagged_as = v.wanted
       FROM unnest($2::text[], $3::text[]) AS v(asset_id, wanted)
      WHERE a.user_id = $1 AND a.immich_asset_id = v.asset_id`,
    [userId, changed.map((r) => r.immich_asset_id), changed.map((r) => r.wanted)],
  );
  return changed.length;
}
