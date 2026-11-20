// The animal detector as a file in the species-matching models folder. Installs don't download it
// (the model download job doesn't call download()); inference uses it only when its file is
// there, the basic detector bundled with the source otherwise (inference.ts).
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ANIMAL_DETECTOR_URL, ANIMAL_DETECTOR_VERSION, MODELS_DIR } from "../config.js";
import { downloadResumable } from "../lib/resumableDownload.js";
import { releaseModels, useAnimalDetector } from "./inference.js";
import { expectedModelSha256 } from "./modelChecksums.js";

const filePath = path.join(MODELS_DIR, `${ANIMAL_DETECTOR_VERSION}.onnx`);
useAnimalDetector(filePath);

export const animalDetector = {
  path: filePath,
  url: ANIMAL_DETECTOR_URL,
  version: ANIMAL_DETECTOR_VERSION,
  isDownloaded: () => existsSync(filePath),
  /** Resumable, with the sha256 checked when the default URL's checksum is known. */
  async download(
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(MODELS_DIR, { recursive: true });
    await downloadResumable(ANIMAL_DETECTOR_URL, filePath, {
      signal,
      onProgress,
      label: "the animal detector",
      expectedSha256: expectedModelSha256(ANIMAL_DETECTOR_URL),
    });
  },
  release: () => releaseModels(filePath),
};
