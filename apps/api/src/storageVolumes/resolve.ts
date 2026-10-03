// Tags a linked file with the registered volume it's on, and resolves a tagged original's current
// path (or reports its volume disconnected).
// A volume is a 'drive' (desktop, identified by hardware UUID) or a 'root' (a server's
// LIFER_LIBRARY_ROOTS). Both store paths relative to a root; they differ only in how connection
// is checked.
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

// Only tags against an explicitly registered volume (a drive added in Settings, or an admin
// root); an unregistered drive behaves as a plain absolute path.
export async function tagWithRegisteredVolume(userId: string, absolutePath: string): Promise<VolumeTag> {
  const rootTag = await tagWithLibraryRoot(absolutePath);
  if (rootTag) return rootTag;
  // Drive detection shells out and can't identify anything inside a container, so skip it on a server.
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
  /** Where new managed files go: a dedicated subfolder, since the drive may hold other things. */
  baseDir: string;
  /** The volume's root (baseDir minus "/Lifer Originals"). volume_relative_path is always relative
   *  to this, never baseDir, because resolveOriginalPath rebuilds paths as mountPath + relative path. */
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

// Where a store-mode upload to a chosen volume goes. The volume must be the user's (or an
// install-wide root) and connected: writing to an unmounted path can silently create a plain
// folder on the main drive.
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

// Without a volume_id, `ref` is the path. With one, `ref` only caches the last path; the real one
// is recomputed from the volume's current state, which can change between requests.
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
  if (!volume) return { path: original.ref, connected: true }; // volume was deleted (the FK already nulls volume_id); defensive fallback

  const mountPath = await currentMountPath(volume);
  if (!mountPath || original.volume_relative_path == null) {
    return { path: null, connected: false, volumeLabel: volume.label };
  }
  return { path: `${mountPath}${original.volume_relative_path}`, connected: true, volumeLabel: volume.label };
}
