import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useStorageVolumes } from "../hooks/useStorageVolumes";
import { pluralize, pluralWord } from "../lib/pluralize";
import Select from "./Select";

interface VolumeUsage {
  volumeId: string | null;
  label: string | null;
  count: number;
}

/** One destination drive shared by UploadDropzone and RawUpload for files Lifer writes itself
 *  (mode=store). Trip imports reference files in place and don't use this. */
export function useVolumeDestination(speciesId: string) {
  const { volumes } = useStorageVolumes();
  const connectedVolumes = volumes.filter((v) => v.connected);
  const [volumeUsage, setVolumeUsage] = useState<VolumeUsage[]>([]);
  const [volumeId, setVolumeId] = useState<string>("");

  useEffect(() => {
    // Any registered drive counts, connected or not: "your other photos are on X" helps either way.
    if (volumes.length === 0) return;
    api
      .get<{ volumes: VolumeUsage[] }>(`/species/${speciesId}/volume-usage`)
      .then((res) => setVolumeUsage(res.volumes))
      .catch(() => setVolumeUsage([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speciesId, volumes.length]);

  // Default to the connected drive holding most of this species' photos, then the default drive,
  // then the main library. Never a disconnected drive, which can't be written to.
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

  // The top-usage drive even when unplugged, so the hint can suggest mounting it.
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
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {pluralize(disconnectedRecommendation.count, "existing photo")} of this species{" "}
          {pluralWord(disconnectedRecommendation.count, "is", "are")} on "{disconnectedRecommendation.label}", which isn't connected right now.
          Plug it in to keep these together, or choose a different destination below.
        </p>
      )}
      {connectedVolumes.length > 0 && (
        <>
          <label className="text-xs font-medium text-muted">Save these photos to</label>
          <Select variant="form" value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
            <option value="">Main library</option>
            {connectedVolumes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.isDefault ? " (default)" : ""}
              </option>
            ))}
          </Select>
          {volumeId && recommendedCount > 0 && (
            <p className="text-xs text-muted">
              {pluralize(recommendedCount, "existing photo")} of this species {pluralWord(recommendedCount, "is", "are")} already on this drive.
            </p>
          )}
        </>
      )}
    </div>
  );
}
