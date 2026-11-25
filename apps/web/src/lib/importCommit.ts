import type { CullMarksOption } from "@lifer/shared";
import { mapWithConcurrency } from "./concurrency";
import type { StagedPlace } from "../components/importReview/importGroups";

// The commit and undo steps of PhotoImportRows, kept free of React and the network so they can be
// tested on their own. Callers pass in the upload and request functions.

export interface CommittedImport {
  key: string;
  captureId: string;
  /** Set when the file joined a photo already in Lifer (a RAW paired to an older edit): Undo takes
   *  off only that file, and puts back the species this import changed. A null originalId means
   *  the server didn't say which file it added, so Undo leaves the photo alone. */
  joined?: { originalId: string | null; previousSpeciesId?: string };
}

export interface ImportTarget {
  speciesId: string;
  isVideo: boolean;
  cullOption: CullMarksOption;
  tripId?: string;
  albumId?: string;
  /** A registered drive to save into (VolumeDestinationPicker); the main library when unset. */
  volumeId?: string;
  regionId: string | null;
  locationLabel: string;
}

/** The form fields every import request for a row carries. */
export function importFields(t: ImportTarget): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  // /uploads/video is store-mode only, so no mode field for videos.
  if (!t.isVideo) {
    fields.push(["mode", "store"]);
    fields.push(["cullMarks", t.cullOption]);
  }
  fields.push(["speciesId", t.speciesId]);
  if (t.tripId) fields.push(["tripId", t.tripId]);
  if (t.albumId) fields.push(["albumId", t.albumId]);
  if (t.volumeId) fields.push(["volumeId", t.volumeId]);
  // Stored on the capture so Stats can count countries without relying on GPS EXIF.
  if (t.regionId) fields.push(["regionId", t.regionId]);
  const label = t.locationLabel.trim();
  if (label) fields.push(["locationLabel", label]);
  return fields;
}

/** Desktop, "Move photos into my library": whether the original went to the Trash. */
export interface SourceMove {
  moved: boolean;
  reason: string | null;
  /** XMP sidecars that went to the Trash with it. */
  sidecars?: number;
}

export type CommitOutcome =
  | { kind: "imported"; captureId: string; sourceMove?: SourceMove; joined?: { originalId: string | null } }
  | { kind: "rejected" };

/** Imports one row from its finished upload. A photo the server reads as a culling reject comes
 *  back without a capture: the import skips those. A RAW matching an imported JPEG is filed as
 *  its sibling (linkedExisting) and still counts as imported. */
export async function commitImport(
  t: ImportTarget,
  deps: {
    ensureUploaded: () => Promise<string>;
    post: (
      endpoint: "/uploads" | "/uploads/video",
      uploadId: string,
      addFields: (form: FormData) => void,
    ) => Promise<{
      captureId?: string;
      linkedExisting?: boolean;
      linkedOriginalId?: string;
      skipped?: "rejected";
      sourceMove?: SourceMove;
    }>;
  },
): Promise<CommitOutcome> {
  const fields = importFields(t);
  const addFields = (form: FormData) => {
    for (const [k, v] of fields) form.append(k, v);
  };
  // The upload from the species check is reused (awaited if it's still going), so files aren't
  // sent twice.
  const uploadId = await deps.ensureUploaded();
  const res = await deps.post(t.isVideo ? "/uploads/video" : "/uploads", uploadId, addFields);
  if (!res.captureId) return { kind: "rejected" };
  const joined = res.linkedExisting ? { originalId: res.linkedOriginalId ?? null } : undefined;
  return { kind: "imported", captureId: res.captureId, sourceMove: res.sourceMove, joined };
}

export interface UndoResult {
  undone: CommittedImport[];
  failed: CommittedImport[];
  /** Joined an older photo without saying which file it added: left exactly as it is. */
  kept: CommittedImport[];
}

export interface UndoDeps {
  /** Sends a photo this import created to the Trash. */
  deleteCapture: (captureId: string) => Promise<unknown>;
  /** Takes the RAW this import added off an older photo. */
  undoLink: (originalId: string) => Promise<unknown>;
  reassign: (captureId: string, speciesId: string) => Promise<unknown>;
}

/** Undoes the last import: photos it created go to the Trash, and a file it added to a photo
 *  already in Lifer comes off that photo, which keeps everything else. One step that fails is
 *  still on the server, so it's reported rather than treated as undone. */
export async function undoImports(batch: CommittedImport[], deps: UndoDeps, concurrency: number): Promise<UndoResult> {
  // A file that joined a photo this same import created goes to the Trash with that photo.
  const created = new Set(batch.filter((c) => !c.joined).map((c) => c.captureId));
  const stepOf = (c: CommittedImport) =>
    created.has(c.captureId) ? `capture:${c.captureId}` : c.joined?.originalId ? `raw:${c.joined.originalId}` : null;
  const steps = new Map<string, () => Promise<unknown>>();
  for (const c of batch) {
    const id = stepOf(c);
    if (!id || steps.has(id)) continue;
    const joined = c.joined;
    steps.set(
      id,
      !joined || created.has(c.captureId)
        ? () => deps.deleteCapture(c.captureId)
        : async () => {
            // Species first, so a failure leaves the RAW in place for another try.
            if (joined.previousSpeciesId) await deps.reassign(c.captureId, joined.previousSpeciesId);
            await deps.undoLink(joined.originalId!);
          },
    );
  }
  const ids = [...steps.keys()];
  const ok = await mapWithConcurrency(ids, concurrency, (id) =>
    steps.get(id)!().then(
      () => true,
      () => false,
    ),
  );
  const done = new Set(ids.filter((_, i) => ok[i]));
  const result: UndoResult = { undone: [], failed: [], kept: [] };
  for (const c of batch) {
    const id = stepOf(c);
    (id === null ? result.kept : done.has(id) ? result.undone : result.failed).push(c);
  }
  return result;
}

/** One entry of POST /places/apply. */
export interface PlaceApply {
  captureIds: string[];
  spotId?: string;
  lat?: number;
  lon?: number;
  regionId?: string;
  label?: string;
}

/** The places staged on the import screen, for the photos that imported, one entry per distinct
 *  place. A photo with no place is left as it is: its camera GPS stays, or it waits in Needs placing. */
export function placeAssignments(
  rows: Array<{ captureId: string; place?: StagedPlace | null; label?: string }>,
): PlaceApply[] {
  const byPlace = new Map<string, PlaceApply>();
  for (const { captureId, place, label } of rows) {
    if (!place) continue;
    // A label typed for the photos stays rather than being replaced by the spot's name.
    const typed = label?.trim() || undefined;
    const target: Omit<PlaceApply, "captureIds"> | null = place.spotId
      ? { spotId: place.spotId, label: typed }
      : place.point
        ? { lat: place.point.lat, lon: place.point.lon, regionId: place.regionId ?? undefined }
        : place.regionId
          ? { regionId: place.regionId }
          : null;
    if (!target) continue;
    const key = JSON.stringify(target);
    const entry = byPlace.get(key);
    if (entry) entry.captureIds.push(captureId);
    else byPlace.set(key, { captureIds: [captureId], ...JSON.parse(key) });
  }
  return [...byPlace.values()];
}

/** Rows whose capture was deleted go back to "ready" for another import; the rest are unchanged. */
export function resetUndoneRows<R extends { key: string; status: string; captureId?: string }>(
  rows: R[],
  undone: CommittedImport[],
): R[] {
  const keys = new Set(undone.map((u) => u.key));
  return rows.map((r) => (keys.has(r.key) ? { ...r, status: "ready", captureId: undefined } : r));
}
