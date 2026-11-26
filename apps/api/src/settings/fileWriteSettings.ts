// Where Lifer writes keywords: sidecar names for RAW files, in-file writes for JPEG and the like,
// and sidecars next to linked files. Per user in install_settings, like metadataSettings.ts.
import { pool } from "@lifer/core/db.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { DEFAULT_FILE_WRITE, type FileWriteSettings, type SidecarNames } from "../uploads/sidecarNames.js";

export const fileWriteKey = (userId: string) => `file_writing:${userId}`;
export const SIDECAR_NAMES: readonly SidecarNames[] = ["stem", "full", "both"];

export async function getFileWriteSettings(userId: string): Promise<FileWriteSettings> {
  const saved = await getInstallSetting<Partial<FileWriteSettings>>(pool, fileWriteKey(userId));
  return {
    sidecarNames: SIDECAR_NAMES.includes(saved?.sidecarNames as SidecarNames)
      ? (saved!.sidecarNames as SidecarNames)
      : DEFAULT_FILE_WRITE.sidecarNames,
    insideFiles: saved?.insideFiles !== false,
    linkedFolders: saved?.linkedFolders === true,
    smartTags: saved?.smartTags === true,
  };
}

export async function setFileWriteSettings(
  userId: string,
  patch: Partial<FileWriteSettings>,
): Promise<FileWriteSettings> {
  const next = { ...(await getFileWriteSettings(userId)), ...patch };
  await setInstallSetting(pool, fileWriteKey(userId), next);
  return next;
}
