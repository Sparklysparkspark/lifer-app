import { useEffect, useState } from "react";
import type { StorageVolume } from "@lifer/shared";
import { api } from "../api/client";

export type { StorageVolume };

// Works in both modes: desktop lists registered drives, a server lists its LIFER_LIBRARY_ROOTS.
export function useStorageVolumes(): { volumes: StorageVolume[]; multiDriveInUse: boolean } {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);

  useEffect(() => {
    api
      .get<{ volumes: StorageVolume[] }>("/storage-volumes")
      .then((res) => setVolumes(res.volumes))
      .catch(() => setVolumes([]));
  }, []);

  // At least one extra drive/root means photos could genuinely be split between it and the
  // main library; with none, a per-photo "which drive" badge would just be redundant noise.
  return { volumes, multiDriveInUse: volumes.length > 0 };
}
