// Shared between uploads/routes.ts (tag a newly-linked file with which registered volume it's
// on) and photos/routes.ts (resolve a volume-tagged original's current absolute path, or report
// it as unavailable if that volume isn't connected right now).
import { pool } from "../db.js";
import { listMountedVolumes, mountPathFor, getVolumeId } from "./volumeIdentity.js";

export interface VolumeTag {
  volumeId: string | null;
  volumeRelativePath: string | null;
}

// Only tags a file against a volume the user EXPLICITLY registered (see storageVolumes/routes.ts)
// — never auto-tags against just any mounted drive, since an un-registered external drive
// should behave exactly as it does today (a plain absolute path, no connected/disconnected
// tracking, no different from before this feature existed).
export async function tagWithRegisteredVolume(userId: string, absolutePath: string): Promise<VolumeTag> {
  const mountPath = await mountPathFor(absolutePath);
  if (mountPath === "/") return { volumeId: null, volumeRelativePath: null };
  const platformVolumeId = await getVolumeId(mountPath);
  if (!platformVolumeId) return { volumeId: null, volumeRelativePath: null };

  const res = await pool.query<{ id: string }>(
    `SELECT id FROM storage_volumes WHERE user_id = $1 AND platform_volume_id = $2`,
    [userId, platformVolumeId],
  );
  const volume = res.rows[0];
  if (!volume) return { volumeId: null, volumeRelativePath: null };

  return { volumeId: volume.id, volumeRelativePath: absolutePath.slice(mountPath.length) };
}

export interface ChosenVolumeDestination {
  /** Absolute path to write new managed files under — a dedicated subfolder so a drive doing
   *  double duty for other things isn't mistaken for being entirely Lifer's. */
  baseDir: string;
  /** The drive's own mount root (baseDir minus "/Lifer Originals") — volume_relative_path is
   *  always stored relative to THIS, never baseDir, so it stays computed the exact same way
   *  regardless of which code path wrote it (tagWithRegisteredVolume, for a link-mode/Trips
   *  file already sitting anywhere on the drive, has no concept of "Lifer Originals" at all).
   *  resolveOriginalPath's own reconstruction (mountPath + volume_relative_path) assumes this
   *  same convention — mixing the two silently drops the "Lifer Originals" segment and makes
   *  an otherwise-connected drive's files 404. */
  mountPath: string;
  volumeId: string;
}

// Store-mode uploads (apps/api/src/uploads/routes.ts) call this to write directly onto a
// user-chosen registered drive instead of the primary ORIGINALS_DIR — the drive must belong to
// this user AND be connected right now, since writing into a stale, no-longer-mounted path
// would either fail outright or (worse, on some OSes) silently recreate the mount point as a
// plain folder on the primary drive.
export async function resolveChosenVolumeDestination(userId: string, volumeId: string): Promise<ChosenVolumeDestination | null> {
  const res = await pool.query<{ platform_volume_id: string }>(
    `SELECT platform_volume_id FROM storage_volumes WHERE id = $1 AND user_id = $2`,
    [volumeId, userId],
  );
  const volume = res.rows[0];
  if (!volume) return null;

  const volumes = await listMountedVolumes();
  const mounted = volumes.find((v) => v.platformVolumeId === volume.platform_volume_id);
  if (!mounted) return null;

  return { baseDir: `${mounted.mountPath}/Lifer Originals`, mountPath: mounted.mountPath, volumeId };
}

export interface ResolvedOriginal {
  path: string | null;
  connected: boolean;
  volumeLabel?: string;
}

// `ref` is used as-is when there's no volume_id (every original before this feature, and
// anything on the primary always-on DATA_DIR) — that's the plain, pre-existing behavior. When
// volume_id IS set, `ref` is only a cache of the last-resolved path; the real answer is always
// recomputed from the volume's current mount status, since that's exactly what can change
// between one request and the next (a drive getting plugged in or removed).
export async function resolveOriginalPath(original: {
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
}): Promise<ResolvedOriginal> {
  if (!original.volume_id) return { path: original.ref, connected: true };

  const volumeRes = await pool.query<{ label: string; platform_volume_id: string }>(
    `SELECT label, platform_volume_id FROM storage_volumes WHERE id = $1`,
    [original.volume_id],
  );
  const volume = volumeRes.rows[0];
  if (!volume) return { path: original.ref, connected: true }; // volume was deleted — FK already nulled volume_id elsewhere; defensive fallback

  const volumes = await listMountedVolumes();
  const mounted = volumes.find((v) => v.platformVolumeId === volume.platform_volume_id);
  if (!mounted || original.volume_relative_path == null) {
    return { path: null, connected: false, volumeLabel: volume.label };
  }

  const currentPath = `${mounted.mountPath}${original.volume_relative_path}`;
  return { path: currentPath, connected: true, volumeLabel: volume.label };
}
