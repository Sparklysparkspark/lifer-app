// The two identity signals for a file on disk: a sha256 content hash (exact duplicates) and the
// EXIF fingerprint pair (exif.ts), which matches a RAW to its JPEG or a moved file to its row.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { computeExifFingerprint, readExifTags, type ExifFingerprint, type ExifTags } from "./exif.js";

export interface FileFingerprint {
  contentHash: string;
  exifFingerprint: ExifFingerprint;
}

// Streamed, so hashing a 25-60 MB RAW doesn't block the event loop and several files can hash at
// once.
export function computeContentHash(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(absolutePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

// Pass `tags` when the caller already read them, to save a second exiftool call.
export async function computeFileFingerprint(absolutePath: string, tags?: ExifTags): Promise<FileFingerprint> {
  const contentHash = await computeContentHash(absolutePath);
  const exifFingerprint = await computeExifFingerprint(absolutePath, tags);
  return { contentHash, exifFingerprint };
}
