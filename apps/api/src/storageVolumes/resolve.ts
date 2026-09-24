// Shared between uploads/routes.ts (tag a newly-linked file with which registered volume it's
// on) and photos/routes.ts (resolve a volume-tagged original's current absolute path, or report
// it as unavailable if that volume isn't connected right now).
//
// A volume is one of two kinds (migration 104): a 'drive' the desktop app identified by its
// hardware UUID, or a 'root' folder a self-hosted admin declared in LIFER_LIBRARY_ROOTS. Both
// store files relative to a root path; they only differ in how "is it connected" is answered.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { SINGLE_USER_MODE } from "../config.js";
import { listMountedVolumes, mountPathFor, getVolumeId } from "./volumeIdentity.js";

export const VOLUME_ORIGINALS_SUBDIR = "Lifer Originals";

export interface VolumeTag {
  volumeId: string | null;
  volumeRelativePath: string | null;
}

const UNTAGGED: VolumeTag = { volumeId: null, volumeRelativePath: null };

export function isReadableDir(p: string): boolean {
  try {
    if (!statSync(p).isDirectory()) return false;
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Longest active root containing absolutePath, if any. Nested roots are allowed; the most
// specific one owns the file.
async function tagWithLibraryRoot(absolutePath: string): Promise<VolumeTag | null> {
  const res = await pool.query<{ id: string; root_path: string }>(
    `SELECT id, root_path FROM storage_volumes WHERE kind = 'root' AND removed_at IS NULL`,
  );
  if (res.rows.length === 0) return null;
  const abs = path.resolve(absolutePath);
  let best: { id: string; root_path: string } | null = null;
  for (const row of res.rows) {
    const inside = abs === row.root_path || abs.startsWith(row.root_path + path.sep);
    if (inside && (!best || row.root_path.length > best.root_path.length)) best = row;
  }
  return best ? { volumeId: best.id, volumeRelativePath: abs.slice(best.root_path.length) } : null;
}

// Only tags a file against a volume that was EXPLICITLY registered (a drive the user added in
// Settings, or a root the admin declared) - never auto-tags against just any mounted drive,
// since an un-registered external drive should behave exactly as a plain absolute path.
export async function tagWithRegisteredVolume(userId: string, absolutePath: string): Promise<VolumeTag> {
  const rootTag = await tagWithLibraryRoot(absolutePath);
  if (rootTag) return rootTag;
  // Drive detection shells out to findmnt/diskutil and can't identify anything inside a
  // container anyway; skip it entirely on a server rather than spawning it per upload.
  if (!SINGLE_USER_MODE) return UNTAGGED;

  const mountPath = await mountPathFor(absolutePath);
  if (mountPath === "/") return UNTAGGED;
  const platformVolumeId = await getVolumeId(mountPath);
  if (!platformVolumeId) return UNTAGGED;

  const res = await pool.query<{ id: string }>(
    `SELECT id FROM storage_volumes WHERE kind = 'drive' AND user_id = $1 AND platform_volume_id = $2`,
    [userId, platformVolumeId],
  );
  const volume = res.rows[0];
  if (!volume) return UNTAGGED;

  return { volumeId: volume.id, volumeRelativePath: absolutePath.slice(mountPath.length) };
}

export interface ChosenVolumeDestination {
  /** Absolute path to write new managed files under - a dedicated subfolder so a drive (or
   *  mounted folder) doing double duty for other things isn't mistaken for being entirely Lifer's. */
  baseDir: string;
  /** The volume's own root (baseDir minus "/Lifer Originals") - volume_relative_path is
   *  always stored relative to THIS, never baseDir, so it stays computed the exact same way
   *  regardless of which code path wrote it (tagWithRegisteredVolume, for a link-mode/Trips
   *  file already sitting anywhere on the volume, has no concept of "Lifer Originals" at all).
   *  resolveOriginalPath's own reconstruction (mountPath + volume_relative_path) assumes this
   *  same convention — mixing the two silently drops the "Lifer Originals" segment and makes
   *  an otherwise-connected volume's files 404. */
  mountPath: string;
  volumeId: string;
}

interface VolumeRow {
  kind: "drive" | "root";
  label: string;
  platform_volume_id: string | null;
  root_path: string | null;
  removed_at: string | null;
}

// Current root of a volume, or null if it isn't reachable right now.
async function currentMountPath(volume: VolumeRow): Promise<string | null> {
  if (volume.kind === "root") {
    return volume.removed_at == null && volume.root_path && isReadableDir(volume.root_path) ? volume.root_path : null;
  }
  const volumes = await listMountedVolumes();
  return volumes.find((v) => v.platformVolumeId === volume.platform_volume_id)?.mountPath ?? null;
}

// Store-mode uploads (apps/api/src/uploads/routes.ts) call this to write directly onto a
// user-chosen volume instead of the primary ORIGINALS_DIR - the volume must be this user's (or an
// install-wide root) AND be reachable right now, since writing into a stale, no-longer-mounted
// path would either fail outright or (worse, on some OSes) silently recreate the mount point as a
// plain folder on the primary drive.
export async function resolveChosenVolumeDestination(userId: string, volumeId: string): Promise<ChosenVolumeDestination | null> {
  const res = await pool.query<VolumeRow>(
    `SELECT kind, label, platform_volume_id, root_path, removed_at FROM storage_volumes
     WHERE id = $1 AND (user_id = $2 OR kind = 'root')`,
    [volumeId, userId],
  );
  const volume = res.rows[0];
  if (!volume) return null;
  const mountPath = await currentMountPath(volume);
  if (!mountPath) return null;
  return { baseDir: `${mountPath}/${VOLUME_ORIGINALS_SUBDIR}`, mountPath, volumeId };
}

export interface ResolvedOriginal {
  path: string | null;
  connected: boolean;
  volumeLabel?: string;
}

// `ref` is used as-is when there's no volume_id (every original before this feature, and
// anything on the primary always-on DATA_DIR) — that's the plain, pre-existing behavior. When
// volume_id IS set, `ref` is only a cache of the last-resolved path; the real answer is always
// recomputed from the volume's current status, since that's exactly what can change between one
// request and the next (a drive getting plugged in or removed, a mount going away).
export async function resolveOriginalPath(original: {
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
}): Promise<ResolvedOriginal> {
  if (!original.volume_id) return { path: original.ref, connected: true };

  const volumeRes = await pool.query<VolumeRow>(
    `SELECT kind, label, platform_volume_id, root_path, removed_at FROM storage_volumes WHERE id = $1`,
    [original.volume_id],
  );
  const volume = volumeRes.rows[0];
  if (!volume) return { path: original.ref, connected: true }; // volume was deleted — FK already nulled volume_id elsewhere; defensive fallback

  const mountPath = await currentMountPath(volume);
  if (!mountPath || original.volume_relative_path == null) {
    return { path: null, connected: false, volumeLabel: volume.label };
  }
  return { path: `${mountPath}${original.volume_relative_path}`, connected: true, volumeLabel: volume.label };
}
