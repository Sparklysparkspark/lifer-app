// Where a Lifer-managed original was filed, and where it goes when its species changes or the
// library is reorganized. A managed file always stays under the folder it was filed under (its
// root): the main library (ORIGINALS_DIR), a chosen drive's or library root's "Lifer Originals"
// folder, or a trip's destination folder. It never moves to another drive or out of a trip.
import { existsSync } from "node:fs";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { isWithin, isWithinResolved } from "@lifer/core/lib/pathContainment.js";
import { moveToFolder } from "@lifer/core/lib/safeFs.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { getUserFileSettings, type UserFileSettings } from "../lib/userFileSettings.js";
import { resolveChosenVolumeDestination, VOLUME_ORIGINALS_SUBDIR } from "../storageVolumes/resolve.js";
import { captureTimeFromTags, readExifTags } from "./exif.js";
import { originalsFolder } from "./organizedPath.js";
import { resolveSpeciesFolderName } from "./speciesFolderName.js";

type Subfolder = "RAW" | "Adjusted" | "Video";
const SUBFOLDERS = new Set<string>(["RAW", "Adjusted", "Video"]);

export function subfolderFor(kind: string): Subfolder {
  return kind === "raw" ? "RAW" : kind === "video" ? "Video" : "Adjusted";
}

export interface ManagedOriginalRow {
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
  /** The destination folder of the trip its capture belongs to, if any. */
  trip_destination: string | null;
}

export interface ManagedFileLocation {
  /** The file's current path: on a volume, its current mount plus the stored relative path. */
  path: string;
  /** The volume's current mount when the file is on one; relative paths are kept against it. */
  mountPath: string | null;
  /** The folder the file was filed under, or null when it's under none Lifer knows. */
  root: string | null;
  /** The root is a trip's destination folder, which never gets a location folder. */
  tripRoot: boolean;
}

/** Where a managed original is and which root it was filed under. Null when its volume isn't
 *  connected, so nothing can be moved. */
export async function locateManagedOriginal(
  userId: string,
  row: ManagedOriginalRow,
): Promise<ManagedFileLocation | null> {
  let filePath = row.ref;
  let mountPath: string | null = null;
  if (row.volume_id) {
    const volume = await resolveChosenVolumeDestination(userId, row.volume_id);
    if (!volume || row.volume_relative_path == null) return null;
    mountPath = volume.mountPath;
    filePath = `${mountPath}${row.volume_relative_path}`;
  }
  const roots: Array<{ dir: string; trip: boolean }> = [];
  if (row.trip_destination) roots.push({ dir: row.trip_destination, trip: true });
  // A file on a volume was filed in its "Lifer Originals" folder; anything else in the library.
  roots.push({ dir: mountPath ? path.join(mountPath, VOLUME_ORIGINALS_SUBDIR) : ORIGINALS_DIR, trip: false });
  const root = roots.find((r) => isWithinResolved(r.dir, filePath)) ?? null;
  return { path: filePath, mountPath, root: root?.dir ?? null, tripRoot: root?.trip ?? false };
}

/** The camera's wall-clock time from the file, which the year folder goes by. Null when
 *  unreadable, so the folder falls back to taken_at. */
export async function fileWallClock(filePath: string): Promise<string | null> {
  try {
    return captureTimeFromTags(await readExifTags(filePath))?.wallClock ?? null;
  } catch {
    return null;
  }
}

async function speciesFolderParts(userId: string, speciesId: string, namingStyles: string[]) {
  const res = await pool.query<{ taxon_class: string | null; inat_iconic_taxon: string | null }>(
    `SELECT taxon_class, inat_iconic_taxon FROM species WHERE id = $1`,
    [speciesId],
  );
  return {
    speciesFolderName: await resolveSpeciesFolderName(userId, speciesId),
    taxonClass: res.rows[0]?.taxon_class ?? null,
    inatIconicTaxon: res.rows[0]?.inat_iconic_taxon ?? null,
    namingStyles,
  };
}

/** The folder the user's current settings file a managed original in, under its own root: what
 *  Reorganize applies. Trip folders get the year layer but never a location one, as trip imports
 *  file them. Null for a file outside every root Lifer knows. */
export async function organizedFolderFor(
  userId: string,
  location: ManagedFileLocation,
  original: { kind: string; speciesId: string; takenAt: Date | null; locationLabel: string | null },
  settings: UserFileSettings,
): Promise<string | null> {
  if (!location.root) return null;
  return originalsFolder(location.root, {
    ...(await speciesFolderParts(userId, original.speciesId, settings.namingStyles)),
    organizeByYear: settings.organizeByYear,
    organizeByLocation: settings.organizeByLocation && !location.tripRoot,
    locationLabel: original.locationLabel,
    takenAt: original.takenAt,
    takenAtWallClock: settings.organizeByYear ? await fileWallClock(location.path) : null,
    subfolder: subfolderFor(original.kind),
  });
}

export interface MovedOriginal {
  from: string;
  to: string;
  /** The new path relative to the volume's mount, for a file on a volume; else null. */
  volumeRelativePath: string | null;
}

/** Files a Lifer-managed original into its species' folder after its species changed (or a
 *  capture claimed an unmatched RAW). Only the taxon and species folders change: the root and any
 *  year and location folders above them stay as they are. A file that isn't in that layout is
 *  filed under its own root with the current settings; one outside every root Lifer knows, or on
 *  a drive that isn't connected, stays where it is. A file Lifer doesn't manage is never moved.
 *  Returns null when nothing moved; the caller saves the new ref (and volume path). */
export async function moveManagedOriginalToSpeciesFolder(
  userId: string,
  originalId: string,
  speciesId: string,
): Promise<MovedOriginal | null> {
  const res = await pool.query<
    ManagedOriginalRow & {
      kind: string;
      managed: boolean;
      ref_type: string;
      taken_at: Date | null;
      location_label: string | null;
    }
  >(
    // captures_all: a hidden photo's files are filed like any other.
    `SELECT o.ref, o.kind, o.managed, o.ref_type, o.volume_id, o.volume_relative_path,
            t.destination_folder AS trip_destination, c.taken_at, c.location_label
     FROM originals o
     LEFT JOIN captures_all c ON c.id = o.capture_id
     LEFT JOIN trips t ON t.id = c.trip_id
     WHERE o.id = $1`,
    [originalId],
  );
  const row = res.rows[0];
  if (!row || !row.managed || row.ref_type !== "path") return null;
  const location = await locateManagedOriginal(userId, row);
  if (!location || !existsSync(location.path)) return null;

  const sourceDir = path.dirname(location.path);
  const subfolder = path.basename(sourceDir);
  // <above>/<taxon>/<species>/<RAW|Adjusted|Video>: everything in <above> is kept.
  const above = path.dirname(path.dirname(path.dirname(sourceDir)));
  const settings = await getUserFileSettings(userId);
  let folder: string | null;
  if (SUBFOLDERS.has(subfolder) && (!location.root || isWithinResolved(location.root, above))) {
    folder = originalsFolder(above, {
      ...(await speciesFolderParts(userId, speciesId, settings.namingStyles)),
      organizeByYear: false,
      takenAt: null,
      subfolder: subfolder as Subfolder,
    });
  } else {
    folder = await organizedFolderFor(
      userId,
      location,
      { kind: row.kind, speciesId, takenAt: row.taken_at, locationLabel: row.location_label },
      settings,
    );
  }
  // Already filed in the right folder: moving it would only rename it to "-2".
  if (!folder || path.resolve(folder) === path.resolve(sourceDir)) return null;
  // Never off the file's volume: its stored path is relative to that volume.
  if (location.mountPath && !isWithin(location.mountPath, folder)) return null;

  const dest = await moveToFolder(location.path, folder);
  // Removes the emptied RAW/Adjusted folder and then the species folder, never the shared
  // taxon, year and location folders above them. Best effort.
  await removeEmptyDirsUpward(sourceDir, path.dirname(path.dirname(sourceDir))).catch(() => {});
  return {
    from: location.path,
    to: dest,
    volumeRelativePath: location.mountPath ? dest.slice(location.mountPath.length) : null,
  };
}
