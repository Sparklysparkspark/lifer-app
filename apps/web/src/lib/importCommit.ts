import type { CullMarksOption } from "@lifer/shared";
import { mapWithConcurrency } from "./concurrency";
import type { StagedPlace } from "../components/importReview/importGroups";

// The commit and undo steps of PhotoImportRows, kept free of React and the network so they can be
// tested on their own. Callers pass in the upload and request functions.

export interface CommittedImport {
  key: string;
  captureId: string;
}

export interface ImportTarget {
  speciesId: string;
  isVideo: boolean;
  cullOption: CullMarksOption;
  tripId?: string;
  albumId?: string;
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
  // Stored on the capture so Stats can count countries without relying on GPS EXIF.
  if (t.regionId) fields.push(["regionId", t.regionId]);
  const label = t.locationLabel.trim();
  if (label) fields.push(["locationLabel", label]);
  return fields;
}

export type CommitOutcome = { kind: "imported"; captureId: string } | { kind: "rejected" };

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
    ) => Promise<{ captureId?: string; linkedExisting?: boolean; skipped?: "rejected" }>;
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
  return res.captureId ? { kind: "imported", captureId: res.captureId } : { kind: "rejected" };
}

export interface UndoResult {
  undone: CommittedImport[];
  failed: CommittedImport[];
}

/** Deletes each capture of the last import. One that fails to delete is still on the server, so
 *  it's reported rather than treated as undone. */
export async function undoImports(
  batch: CommittedImport[],
  deleteCapture: (captureId: string) => Promise<unknown>,
  concurrency: number,
): Promise<UndoResult> {
  const ok = await mapWithConcurrency(batch, concurrency, async ({ captureId }) =>
    deleteCapture(captureId).then(
      () => true,
      () => false,
    ),
  );
  return { undone: batch.filter((_, i) => ok[i]), failed: batch.filter((_, i) => !ok[i]) };
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
