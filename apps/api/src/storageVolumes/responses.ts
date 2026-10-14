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
