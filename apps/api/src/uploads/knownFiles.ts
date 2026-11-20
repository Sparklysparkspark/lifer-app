// Importing a folder again: which picked files the library already has (imported, or left out of an
// earlier import), keyed by the quick hash of movedPhotos/fingerprint.ts, which the web computes the
// same way. Desktop also remembers the folders imported from, to offer their new photos later.
import { stat } from "node:fs/promises";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { ACCEPTED_PHOTO_EXTENSIONS, VENDOR_RAW_EXTENSIONS } from "@lifer/core/uploads/formats.js";
import { quickHash } from "../movedPhotos/fingerprint.js";
import { walkFiles } from "../library/walkFiles.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";

export type KnownStatus = "imported" | "skipped";
export type SkipReason = "removed" | "not_wildlife" | "no_animal";

/** The fingerprints among `fingerprints` this user has imported or left out before. */
export async function knownFingerprints(
  userId: string,
  fingerprints: string[],
): Promise<Map<string, { status: KnownStatus; reason: SkipReason | null }>> {
  const out = new Map<string, { status: KnownStatus; reason: SkipReason | null }>();
  if (fingerprints.length === 0) return out;
  const res = await pool.query<{ fp: string; status: KnownStatus; reason: SkipReason | null }>(
    `SELECT DISTINCT source_quick_hash AS fp, 'imported' AS status, NULL AS reason
       FROM originals WHERE user_id = $1 AND source_quick_hash = ANY($2::text[])
     UNION ALL
     SELECT fingerprint, 'skipped', reason
       FROM import_skipped_files WHERE user_id = $1 AND fingerprint = ANY($2::text[])`,
    [userId, fingerprints],
  );
  // Imported wins over an older "left out".
  for (const r of res.rows)
    if (out.get(r.fp)?.status !== "imported") out.set(r.fp, { status: r.status, reason: r.reason });
  return out;
}

export async function rememberSkipped(
  userId: string,
  files: Array<{ fingerprint: string; name: string; size: number; reason: SkipReason }>,
): Promise<void> {
  if (files.length === 0) return;
  await pool.query(
    `INSERT INTO import_skipped_files (user_id, fingerprint, reason, name, size)
     SELECT $1, f.fingerprint, f.reason, f.name, f.size
       FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[]) AS f(fingerprint, reason, name, size)
     ON CONFLICT (user_id, fingerprint) DO UPDATE SET reason = EXCLUDED.reason, name = EXCLUDED.name`,
    [
      userId,
      files.map((f) => f.fingerprint),
      files.map((f) => f.reason),
      files.map((f) => f.name),
      files.map((f) => f.size),
    ],
  );
}

const IMPORTABLE = new Set([...ACCEPTED_PHOTO_EXTENSIONS, ...VENDOR_RAW_EXTENSIONS, ".mp4", ".mov"]);
export const isImportableName = (name: string) => IMPORTABLE.has(path.extname(name).toLowerCase());

export interface FolderFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  fingerprint: string | null;
  status: "new" | KnownStatus;
  /** Same path as a file imported before, but its size or date changed: probably edited since. */
  edited: boolean;
}

/** Every importable file in `folder` and whether it's new. `hash: false` is the stat-only look for
 *  the Import page's count: a file whose size and mtime match the last look reuses its hash, and
 *  anything else counts as new without being read. */
export async function lookAtFolder(userId: string, folder: string, { hash }: { hash: boolean }): Promise<FolderFile[]> {
  const seen: Array<{ path: string; name: string }> = [];
  for await (const f of walkFiles(folder))
    if (isImportableName(f.name)) seen.push({ path: f.absolutePath, name: f.name });
  const stats = await mapWithConcurrency(seen, 16, (f) =>
    stat(f.path).then(
      (s) => ({ ...f, size: s.size, mtimeMs: s.mtimeMs }),
      () => null,
    ),
  );
  const files = stats.filter((f): f is NonNullable<typeof f> => f != null);
  const paths = files.map((f) => f.path);

  const [cacheRes, linkedRes] = await Promise.all([
    pool.query<{ path: string; size: string; mtime_ms: number; quick_hash: string }>(
      `SELECT path, size, mtime_ms, quick_hash FROM import_source_files WHERE user_id = $1 AND path = ANY($2::text[])`,
      [userId, paths],
    ),
    // Linked in place: the library points at this very path.
    pool.query<{ ref: string }>(`SELECT ref FROM originals WHERE user_id = $1 AND ref = ANY($2::text[])`, [
      userId,
      paths,
    ]),
  ]);
  const cache = new Map(cacheRes.rows.map((r) => [r.path, r]));
  const linked = new Set(linkedRes.rows.map((r) => r.ref));

  const out: FolderFile[] = await mapWithConcurrency(files, 32, async (f) => {
    const cached = cache.get(f.path);
    const unchanged = cached && Number(cached.size) === f.size && cached.mtime_ms === f.mtimeMs;
    let fingerprint = unchanged ? cached.quick_hash : null;
    if (!fingerprint && hash) fingerprint = await quickHash(f.path, f.size).catch(() => null);
    return {
      ...f,
      fingerprint,
      status: linked.has(f.path) ? "imported" : "new",
      // Settled below once the old hash's status is known.
      edited: Boolean(cached && !unchanged),
    } satisfies FolderFile;
  });

  const oldHashes = out.flatMap((f) => (f.edited ? [cache.get(f.path)!.quick_hash] : []));
  const known = await knownFingerprints(userId, [
    ...new Set([...out.flatMap((f) => (f.fingerprint ? [f.fingerprint] : [])), ...oldHashes]),
  ]);
  for (const f of out) {
    const k = f.fingerprint ? known.get(f.fingerprint) : undefined;
    if (k && f.status === "new") f.status = k.status;
    // Edited only matters for a photo that was imported in its earlier state.
    if (f.edited) f.edited = f.status === "new" && known.get(cache.get(f.path)!.quick_hash)?.status === "imported";
  }

  if (hash) {
    const fresh = out.filter((f) => f.fingerprint && cache.get(f.path)?.quick_hash !== f.fingerprint);
    for (let i = 0; i < fresh.length; i += 2000) {
      const chunk = fresh.slice(i, i + 2000);
      await pool.query(
        `INSERT INTO import_source_files (user_id, path, size, mtime_ms, quick_hash)
         SELECT $1, f.path, f.size, f.mtime_ms, f.quick_hash
           FROM unnest($2::text[], $3::bigint[], $4::float8[], $5::text[]) AS f(path, size, mtime_ms, quick_hash)
         ON CONFLICT (user_id, path) DO UPDATE
           SET size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms, quick_hash = EXCLUDED.quick_hash`,
        [
          userId,
          chunk.map((f) => f.path),
          chunk.map((f) => f.size),
          chunk.map((f) => f.mtimeMs),
          chunk.map((f) => f.fingerprint),
        ],
      );
    }
    await pool.query(
      `INSERT INTO import_source_folders (user_id, path, photo_count) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, path) DO UPDATE SET last_imported_at = now(), photo_count = EXCLUDED.photo_count`,
      [userId, folder, out.filter((f) => f.status === "imported").length],
    );
  }
  return out;
}

/** Whether `file` is inside one of this user's remembered folders. */
export async function inSourceFolder(userId: string, file: string): Promise<boolean> {
  const res = await pool.query<{ path: string }>(`SELECT path FROM import_source_folders WHERE user_id = $1`, [userId]);
  const resolved = canonicalPath(file);
  return res.rows.some((r) => resolved !== canonicalPath(r.path) && isWithin(canonicalPath(r.path), resolved));
}
