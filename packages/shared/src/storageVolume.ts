// A place Lifer stores photos besides the main library folder. "drive" = an external drive
// registered from the desktop app; "root" = a folder an admin declared via LIFER_LIBRARY_ROOTS.
export type StorageVolumeKind = "drive" | "root";

export interface StorageVolume {
  id: string;
  label: string;
  kind: StorageVolumeKind;
  mountPath: string;
  rootPath: string | null;
  connected: boolean;
  lastSeenAt: string;
  isDefault: boolean;
  // Declared in the server's environment, so not editable from the UI.
  managedByEnv: boolean;
}

export interface LibraryRoot {
  label: string;
  path: string;
}
