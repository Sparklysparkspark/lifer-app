// Given a file already sitting on disk, computes the same two identity signals used
// everywhere else in this app for matching/dedup: a sha256 content hash (exact-duplicate
// detection) and an EXIF fingerprint pair (see exif.ts's own comment on strict vs loose —
// cross-format matching, e.g. a RAW to its JPEG sibling, or here, a moved/renamed file back to
// its original database row). Factored out so trips/scan.ts's rescan logic and
// uploads/routes.ts's upload handlers compute these identically, from one place.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { computeExifFingerprint, readExifTags, type ExifFingerprint, type ExifTags } from "./exif.js";

export interface FileFingerprint {
  contentHash: string;
  exifFingerprint: ExifFingerprint;
}

// Streamed rather than a single readFileSync + sync hash — a RAW file is commonly 25-60MB
// (versus a few MB for a JPEG), and readFileSync blocks Node's single thread for however long
// that read takes. With several files hashed "concurrently" (see mapWithConcurrency callers),
// every one of those sync reads serializes behind the others instead of actually overlapping,
// which is what made a library reimport's RAW pass crawl relative to its JPEG pass even at the
// same file count. A stream lets libuv's async I/O do the waiting, so the event loop (and the
// other files' own hashing) isn't blocked while any one file's bytes are still coming off disk.
export function computeContentHash(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(absolutePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

// `tags` is optional and reused when the caller already ran readExifTags itself (e.g.
// trips/import.ts, which needs the same tags for extractExif too) — recomputing it here
// otherwise means a second full exiftool round-trip per file, which is exactly what made a
// 7-photo trip import noticeably slow before this existed.
export async function computeFileFingerprint(absolutePath: string, tags?: ExifTags): Promise<FileFingerprint> {
  const contentHash = await computeContentHash(absolutePath);
  const exifFingerprint = await computeExifFingerprint(absolutePath, tags);
  return { contentHash, exifFingerprint };
}
