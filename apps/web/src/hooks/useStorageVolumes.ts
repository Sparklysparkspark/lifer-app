import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface StorageVolume {
  id: string;
  label: string;
  mountPath: string;
  connected: boolean;
  lastSeenAt: string;
  isDefault: boolean;
}

// GET /storage-volumes 404s outside desktop mode (see storageVolumes/routes.ts's
// requireDesktopMode), same convention as useDesktopMode — that's the signal for "not
// available here" rather than a second endpoint just to ask the same question.
export function useStorageVolumes(): { volumes: StorageVolume[]; multiDriveInUse: boolean } {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);

  useEffect(() => {
    api
      .get<{ volumes: StorageVolume[] }>("/storage-volumes")
      .then((res) => setVolumes(res.volumes))
      .catch(() => setVolumes([]));
  }, []);

  // At least one registered external drive means photos could genuinely be split between it
  // and the primary drive — with none registered, everything is on the primary drive and a
  // per-photo "which drive" badge would just be redundant noise (see task feedback).
  return { volumes, multiDriveInUse: volumes.length > 0 };
}
