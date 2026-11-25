// Response schemas for the storage volume routes. They document the answer in the OpenAPI
// document and type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";

// StorageVolume in @lifer/shared storageVolume.ts.
export const StorageVolumeList = Open({
  volumes: Type.Array(
    Open({
      id: Uuid(),
      label: Type.String(),
      kind: Type.Enum(["drive", "root"]),
      mountPath: Type.String(),
      rootPath: Nullable(Type.String()),
      connected: Type.Boolean(),
      lastSeenAt: DateTime(),
      isDefault: Type.Boolean(),
      managedByEnv: Type.Boolean({ description: "Declared in the server's environment, not editable here" }),
    }),
  ),
});

export const AddedStorageVolume = Open({
  id: Uuid(),
  label: Type.String(),
  mountPath: Type.String(),
  connected: Type.Boolean(),
  readopted: Type.Integer({ description: "Photos already on the drive that were linked back to it" }),
});

// LibraryLocation in networkShares.ts.
export const LibraryLocation = Open({
  mountPath: Type.String({ description: "The share or drive's mount point, as the library's file paths name it" }),
  name: Type.String(),
  status: Type.Enum(["connected", "not_connected", "not_responding"]),
  connectable: Type.Boolean({ description: "Lifer remembers the share's address and can ask the OS to mount it" }),
  mountedAt: Nullable(Type.String({ description: "Where the share is mounted now, when that differs" })),
  serverConnected: Type.Boolean({ description: "Another share on the same server is mounted" }),
});

export const LibraryLocationList = Open({ locations: Type.Array(LibraryLocation) });
