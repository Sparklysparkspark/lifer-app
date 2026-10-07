import { useEffect, useState } from "react";
import type { StorageVolume } from "@lifer/shared";
import { api } from "../api/client";
import { useStorageVolumes } from "./useStorageVolumes";

interface VolumeUsage {
  volumeId: string | null;
  label: string | null;
  count: number;
}

// The connected drive holding most of this species' photos, then the default drive. Never a
// disconnected drive, which can't be written to. null when neither exists.
function defaultVolumeId(volumeUsage: VolumeUsage[], connectedVolumes: StorageVolume[]): string | null {
  const topUsage = volumeUsage.find((u) => u.volumeId && connectedVolumes.some((v) => v.id === u.volumeId));
  if (topUsage?.volumeId) return topUsage.volumeId;
  return connectedVolumes.find((v) => v.isDefault)?.id ?? null;
}

/** One destination drive shared by UploadDropzone and RawUpload for files Lifer writes itself
 *  (mode=store). Trip imports reference files in place and don't use this. */
export function useVolumeDestination(speciesId: string) {
  const { volumes } = useStorageVolumes();
  const connectedVolumes = volumes.filter((v) => v.connected);
  const [volumeUsage, setVolumeUsage] = useState<VolumeUsage[]>([]);
  // "" is the main library.
  const [volumeId, setVolumeId] = useState<string>("");

  useEffect(() => {
    // Any registered drive counts, connected or not: "your other photos are on X" helps either way.
    if (volumes.length === 0) return;
    api
      .get<{ volumes: VolumeUsage[] }>(`/species/${speciesId}/volume-usage`)
      .then((res) => setVolumeUsage(res.volumes))
      .catch(() => setVolumeUsage([]));
  }, [speciesId, volumes.length]);

  // Re-picks the default whenever the usage or the set of connected drives changes, falling back
  // to the main library. Done while rendering (React's "adjust state when a prop changes"), so the
  // picker never shows a stale choice for a frame. A user's own pick holds until then.
  const connectedCount = connectedVolumes.length;
  const [pickedFor, setPickedFor] = useState<{ usage: VolumeUsage[]; connected: number } | null>(null);
  if (pickedFor?.usage !== volumeUsage || pickedFor.connected !== connectedCount) {
    setPickedFor({ usage: volumeUsage, connected: connectedCount });
    const picked = defaultVolumeId(volumeUsage, connectedVolumes);
    if (picked) setVolumeId(picked);
  }

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
