// The species-matching models and the offline map download by themselves on a new install, so
// suggestions and maps work from the first import. Removing either in Settings turns its
// automatic download off (install_settings), and Download turns it back on; nothing a user
// removed comes back on the next start.
import { existsSync } from "node:fs";
import type { Pool } from "pg";
import { MAP_DOWNLOAD_URL } from "@lifer/core/config.js";
import { isModelDownloaded } from "@lifer/core/species/embeddings.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";

export const AUTO_MODELS_KEY = "auto_download_models";
export const AUTO_MAP_KEY = "auto_download_map";

export interface AutoDownloadState {
  modelsWanted: boolean;
  mapWanted: boolean;
  modelsDownloaded: boolean;
  mapDownloaded: boolean;
  mapAvailable: boolean;
}

/** Which downloads to start now. */
export function plannedAutoDownloads(s: AutoDownloadState): { models: boolean; map: boolean } {
  return { models: s.modelsWanted && !s.modelsDownloaded, map: s.mapWanted && s.mapAvailable && !s.mapDownloaded };
}

export async function setAutoDownload(
  pool: Pool,
  key: typeof AUTO_MODELS_KEY | typeof AUTO_MAP_KEY,
  on: boolean,
): Promise<void> {
  await setInstallSetting(pool, key, on);
}

/** Starts whatever is wanted and missing, through the same jobs Settings uses. */
export async function startAutoDownloads(
  pool: Pool,
  mapFilePaths: string[],
  start: { models: () => boolean; map: () => boolean },
): Promise<{ models: boolean; map: boolean }> {
  const wanted = async (key: string) => (await getInstallSetting<boolean>(pool, key)) !== false;
  const plan = plannedAutoDownloads({
    modelsWanted: await wanted(AUTO_MODELS_KEY),
    mapWanted: await wanted(AUTO_MAP_KEY),
    modelsDownloaded: isModelDownloaded(),
    mapDownloaded: mapFilePaths.every((f) => existsSync(f)),
    mapAvailable: MAP_DOWNLOAD_URL != null,
  });
  return { models: plan.models && start.models(), map: plan.map && start.map() };
}
