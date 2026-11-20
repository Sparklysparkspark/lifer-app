// Where a Lifer-managed original was filed, and where it goes when its species changes or the
// library is reorganized. A managed file always stays under the folder it was filed under (its
// root): the main library (ORIGINALS_DIR), a chosen drive's or library root's "Lifer Originals"
// folder, or a trip's destination folder. It never moves to another drive or out of a trip, unless
// its photo's trip changed (reorganizeOriginals.ts's followTrip).
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
import { PLACE_FOLDER_LEVELS, type FolderLevel } from "@lifer/shared";
import { originalsFolder } from "./organizedPath.js";
import { photoPlaceForRegion } from "../regions/photoPlace.js";
import { resolveSpeciesFolderName } from "./speciesFolderName.js";

export type Subfolder = "RAW" | "Adjusted" | "Video" | "Audio";
const SUBFOLDERS = new Set<string>(["RAW", "Adjusted", "Video", "Audio"]);

export function subfolderFor(kind: string): Subfolder {
  return kind === "raw" ? "RAW" : kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Adjusted";
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
 *  connected, so nothing can be moved. `otherTripFolders` are roots too, for a file whose photo
 *  just left that trip. */
export async function locateManagedOriginal(
  userId: string,
  row: ManagedOriginalRow,
  otherTripFolders: string[] = [],
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
  for (const dir of otherTripFolders) roots.push({ dir, trip: true });
  // A file on a volume was filed in its "Lifer Originals" folder; anything else in the library.
  roots.push({ dir: mountPath ? path.join(mountPath, VOLUME_ORIGINALS_SUBDIR) : ORIGINALS_DIR, trip: false });
  const root = roots.find((r) => isWithinResolved(r.dir, filePath)) ?? null;
  return { path: filePath, mountPath, root: root?.dir ?? null, tripRoot: root?.trip ?? false };
}

/** The camera's wall-clock time from the file, which the year folder goes by. Null when
 *  unreadable, so the folder falls back to taken_at. */
async function fileWallClock(filePath: string): Promise<string | null> {
  try {
    return captureTimeFromTags(await readExifTags(filePath))?.wallClock ?? null;
  } catch {
    return null;
  }
}

async function speciesFolderParts(userId: string, speciesId: string, namingStyles: string[]) {
  const res = await pool.query<{
    taxon_class: string | null;
    inat_iconic_taxon: string | null;
    taxon_order: string | null;
    family: string | null;
  }>(`SELECT taxon_class, inat_iconic_taxon, taxon_order, family FROM species WHERE id = $1`, [speciesId]);
  return {
    speciesFolderName: await resolveSpeciesFolderName(userId, speciesId),
    taxonClass: res.rows[0]?.taxon_class ?? null,
    inatIconicTaxon: res.rows[0]?.inat_iconic_taxon ?? null,
    taxonOrder: res.rows[0]?.taxon_order ?? null,
    family: res.rows[0]?.family ?? null,
    namingStyles,
  };
}

const DATE_LEVELS = new Set<FolderLevel>(["wildlifeYear", "year", "month", "date"]);
const TAXON_LEVELS = new Set<FolderLevel>(["group", "order", "family", "species"]);

/** The folder a new or refiled original goes in under `base` (the library, a drive's or root's
 *  "Lifer Originals" folder, or a trip folder), following the user's folder layout. Every caller
 *  files through here so a species' JPEGs, RAWs and videos always share one species folder.
 *  `allowLocation: false` leaves out the trip, country, province and place levels (a trip's own
 *  folder, a reimport). Pass `settings` to reuse ones already read. */
export async function speciesFolder(
  userId: string,
  speciesId: string,
  base: string,
  o: {
    subfolder: Subfolder;
    takenAt: Date | null;
    wallClock?: string | null;
    locationLabel?: string | null;
    /** The capture's region, for the country and province folders. */
    regionId?: string | null;
    /** The capture's trip, for the trip folder. */
    tripId?: string | null;
    allowLocation?: boolean;
  },
  settings?: UserFileSettings,
): Promise<string> {
  const s = settings ?? (await getUserFileSettings(userId));
  const layout = (o.allowLocation ?? true) ? s.layout : s.layout.filter((l) => !PLACE_FOLDER_LEVELS.has(l));
  const place =
    layout.includes("country") || layout.includes("province")
      ? await photoPlaceForRegion(pool, o.regionId ?? null)
      : null;
  const tripName =
    layout.includes("trip") && o.tripId
      ? ((await pool.query<{ name: string | null }>(`SELECT name FROM trips WHERE id = $1`, [o.tripId])).rows[0]
          ?.name ?? null)
      : null;
  return originalsFolder(base, {
    ...(await speciesFolderParts(userId, speciesId, s.namingStyles)),
    layout,
    tripName,
    locationLabel: o.locationLabel ?? null,
    country: place?.country ?? null,
    province: place?.state ?? null,
    takenAt: o.takenAt,
    takenAtWallClock: o.wallClock ?? null,
    subfolder: o.subfolder,
  });
}

/** The folder the user's current layout files a managed original in, under its own root: what
 *  Reorganize applies. A trip's own folder never gets the trip or location levels, as trip
 *  imports file it. Null for a file outside every root Lifer knows. */
export async function organizedFolderFor(
  userId: string,
  location: ManagedFileLocation,
  original: {
    kind: string;
    speciesId: string;
    takenAt: Date | null;
    locationLabel: string | null;
    regionId: string | null;
    tripId: string | null;
  },
  settings: UserFileSettings,
): Promise<string | null> {
  if (!location.root) return null;
  return speciesFolder(
    userId,
    original.speciesId,
    location.root,
    {
      subfolder: subfolderFor(original.kind),
      takenAt: original.takenAt,
      wallClock: settings.layout.some((l) => DATE_LEVELS.has(l)) ? await fileWallClock(location.path) : null,
      locationLabel: original.locationLabel,
      regionId: original.regionId,
      tripId: original.tripId,
      allowLocation: !location.tripRoot,
    },
    settings,
  );
}

export interface MovedOriginal {
  from: string;
  to: string;
  /** The new path relative to the volume's mount, for a file on a volume; else null. */
  volumeRelativePath: string | null;
}

/** Files a Lifer-managed original into its species' folder after its species changed (or a
 *  capture claimed an unmatched RAW). When the layout ends in group and species folders, only
 *  those change: the root and the folders above them stay as they are. Otherwise, or for a file
 *  that isn't in that layout, it's filed under its own root with the current layout; one outside every root Lifer knows, or on
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
      taken_at: Date | null;
      location_label: string | null;
      region_id: string | null;
      trip_id: string | null;
    }
  >(
    // captures_all: a hidden photo's files are filed like any other.
    `SELECT o.ref, o.kind, o.managed, o.volume_id, o.volume_relative_path,
            t.destination_folder AS trip_destination, c.taken_at, c.location_label, c.region_id, c.trip_id
     FROM originals o
     LEFT JOIN captures_all c ON c.id = o.capture_id
     LEFT JOIN trips t ON t.id = c.trip_id
     WHERE o.id = $1`,
    [originalId],
  );
  const row = res.rows[0];
  if (!row || !row.managed) return null;
  const location = await locateManagedOriginal(userId, row);
  if (!location || !existsSync(location.path)) return null;

  const sourceDir = path.dirname(location.path);
  const subfolder = path.basename(sourceDir);
  const settings = await getUserFileSettings(userId);
  // The taxon levels the layout ends with. Only group and species always have a folder, so with
  // an order or family among them the path can't be counted back: the file is refiled whole.
  let tailStart = settings.layout.length;
  while (tailStart > 0 && TAXON_LEVELS.has(settings.layout[tailStart - 1])) tailStart--;
  const tail = settings.layout.slice(tailStart);
  const countable = tail.length > 0 && tail.every((l) => l === "group" || l === "species");
  // <above>/<tail folders>/<RAW|Adjusted|Video>: everything in <above> is kept.
  let above = sourceDir;
  for (let i = 0; i <= tail.length; i++) above = path.dirname(above);
  let folder: string | null;
  if (countable && SUBFOLDERS.has(subfolder) && (!location.root || isWithinResolved(location.root, above))) {
    folder = originalsFolder(above, {
      ...(await speciesFolderParts(userId, speciesId, settings.namingStyles)),
      layout: tail,
      takenAt: null,
      subfolder: subfolder as Subfolder,
    });
  } else {
    folder = await organizedFolderFor(
      userId,
      location,
      {
        kind: row.kind,
        speciesId,
        takenAt: row.taken_at,
        locationLabel: row.location_label,
        regionId: row.region_id,
        tripId: row.trip_id,
      },
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

/** Where `layout` would file one of the user's recent photos, as a path under the library (one
 *  with the most levels filled, so the example shows them), or a sample photo's before there are
 *  any: Settings' live example. */
export async function folderLayoutExample(
  userId: string,
  layout: FolderLevel[],
): Promise<{ path: string; sample: boolean }> {
  const settings = { ...(await getUserFileSettings(userId)), layout };
  const res = await pool.query<{
    species_id: string;
    taken_at: Date | null;
    location_label: string | null;
    region_id: string | null;
    trip_id: string | null;
    kind: string;
    ref: string;
  }>(
    `SELECT c.species_id, c.taken_at, c.location_label, c.region_id, c.trip_id, o.kind, o.ref
       FROM (SELECT * FROM captures WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50) c
       JOIN originals o ON o.capture_id = c.id AND o.kind <> 'raw'
      ORDER BY (c.location_label IS NOT NULL)::int + (c.region_id IS NOT NULL)::int
             + (c.trip_id IS NOT NULL)::int + (c.taken_at IS NOT NULL)::int DESC, c.created_at DESC
      LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  if (row) {
    const folder = await speciesFolder(
      userId,
      row.species_id,
      "",
      {
        subfolder: subfolderFor(row.kind),
        takenAt: row.taken_at,
        locationLabel: row.location_label,
        regionId: row.region_id,
        tripId: row.trip_id,
      },
      settings,
    );
    return { path: path.join(folder, path.basename(row.ref)), sample: false };
  }
  const folder = originalsFolder("", {
    layout,
    speciesFolderName: "American Robin",
    taxonClass: "aves",
    taxonOrder: "Passeriformes",
    family: "Turdidae",
    tripName: "Alberta 2025",
    country: "Canada",
    province: "Alberta",
    locationLabel: "Pigeon Lake",
    takenAt: null,
    takenAtWallClock: "2025-06-14T08:30:00",
    subfolder: "Adjusted",
  });
  return { path: path.join(folder, "IMG_4411.jpg"), sample: true };
}
