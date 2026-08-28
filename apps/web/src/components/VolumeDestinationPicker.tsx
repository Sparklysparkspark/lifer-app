import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useStorageVolumes } from "../hooks/useStorageVolumes";

interface VolumeUsage {
  volumeId: string | null;
  label: string | null;
  count: number;
}

/** Shared by UploadDropzone and RawUpload — both write into the same species' folder tree and
 *  should offer (and default to) the same destination drive, rather than each picking
 *  independently. Only meaningful for JPEG/RAW files actually written by Lifer (mode=store),
 *  never for Trips' reference-in-place imports, which tag whatever drive the file already
 *  happens to be on. */
export function useVolumeDestination(speciesId: string) {
  const { volumes } = useStorageVolumes();
  const connectedVolumes = volumes.filter((v) => v.connected);
  const [volumeUsage, setVolumeUsage] = useState<VolumeUsage[]>([]);
  const [volumeId, setVolumeId] = useState<string>("");

  useEffect(() => {
    // Fetched whenever ANY drive is registered, connected or not — the recommendation hint
    // below is exactly as useful ("your other photos are on X, plug it in") whether or not
    // that drive happens to be plugged in at the moment this dialog was opened.
    if (volumes.length === 0) return;
    api
      .get<{ volumes: VolumeUsage[] }>(`/species/${speciesId}/volume-usage`)
      .then((res) => setVolumeUsage(res.volumes))
      .catch(() => setVolumeUsage([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speciesId, volumes.length]);

  // Default to wherever this species' existing photos already mostly are (if that drive's
  // actually connected right now), falling back to whichever registered drive is marked
  // default, then to the primary drive. Never auto-picks a disconnected drive — the picker
  // itself can only ever select a connected one, since you can't write to an unplugged drive.
  useEffect(() => {
    const topUsage = volumeUsage.find((u) => u.volumeId && connectedVolumes.some((v) => v.id === u.volumeId));
    if (topUsage?.volumeId) {
      setVolumeId(topUsage.volumeId);
      return;
    }
    const defaultVolume = connectedVolumes.find((v) => v.isDefault);
    if (defaultVolume) setVolumeId(defaultVolume.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeUsage, connectedVolumes.length]);

  const recommended = volumeUsage.find((u) => u.volumeId === volumeId && u.volumeId);

  // The species' top-usage drive, even when it's not currently connected — this is what makes
  // "all your other Fox photos are on X, want to mount it?" possible instead of only ever
  // recommending among whatever's plugged in right now.
  const topUsage = [...volumeUsage].sort((a, b) => b.count - a.count).find((u) => u.volumeId);
  const disconnectedRecommendation =
    topUsage && !connectedVolumes.some((v) => v.id === topUsage.volumeId)
      ? { label: topUsage.label ?? "a registered drive", count: topUsage.count }
      : null;

  return {
    volumeId,
    setVolumeId,
    connectedVolumes,
    recommendedCount: recommended?.count ?? 0,
    disconnectedRecommendation,
  };
}

export function VolumeDestinationPicker({
  volumeId,
  setVolumeId,
  connectedVolumes,
  recommendedCount,
  disconnectedRecommendation,
}: ReturnType<typeof useVolumeDestination>) {
  if (connectedVolumes.length === 0 && !disconnectedRecommendation) return null;

  return (
    <div className="space-y-1 text-left">
      {disconnectedRecommendation && (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {disconnectedRecommendation.count} existing photo{disconnectedRecommendation.count === 1 ? "" : "s"} of this species{" "}
          {disconnectedRecommendation.count === 1 ? "is" : "are"} on "{disconnectedRecommendation.label}", which isn't connected right now.
          Plug it in to keep these together, or choose a different destination below.
        </p>
      )}
      {connectedVolumes.length > 0 && (
        <>
          <label className="text-xs font-medium text-muted">Save these photos to</label>
          <select value={volumeId} onChange={(e) => setVolumeId(e.target.value)} className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink">
            <option value="">This computer (default)</option>
            {connectedVolumes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
          {volumeId && recommendedCount > 0 && (
            <p className="text-xs text-muted">
              {recommendedCount} existing photo{recommendedCount === 1 ? "" : "s"} of this species {recommendedCount === 1 ? "is" : "are"} already on this drive.
            </p>
          )}
        </>
      )}
    </div>
  );
}
