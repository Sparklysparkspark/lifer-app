// Given a file already sitting on disk, computes the same two identity signals used
// everywhere else in this app for matching/dedup: a sha256 content hash (exact-duplicate
// detection) and an EXIF fingerprint pair (see exif.ts's own comment on strict vs loose —
// cross-format matching, e.g. a RAW to its JPEG sibling, or here, a moved/renamed file back to
// its original database row). Factored out so trips/scan.ts's rescan logic and
// uploads/routes.ts's upload handlers compute these identically, from one place.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { computeExifFingerprint, readExifTags, type ExifFingerprint, type ExifTags } from "./exif.js";

export interface FileFingerprint {
  contentHash: string;
  exifFingerprint: ExifFingerprint;
}

export function computeContentHash(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

// `tags` is optional and reused when the caller already ran readExifTags itself (e.g.
// trips/import.ts, which needs the same tags for extractExif too) — recomputing it here
// otherwise means a second full exiftool round-trip per file, which is exactly what made a
// 7-photo trip import noticeably slow before this existed.
export async function computeFileFingerprint(absolutePath: string, tags?: ExifTags): Promise<FileFingerprint> {
  const contentHash = computeContentHash(absolutePath);
  const exifFingerprint = await computeExifFingerprint(absolutePath, tags);
  return { contentHash, exifFingerprint };
}
