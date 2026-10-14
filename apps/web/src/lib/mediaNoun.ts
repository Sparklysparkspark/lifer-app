/** What to call a set of files in "Delete 3 …?": photos, videos, or "files" when it has both.
 *  `allRaw`: every one is a photo whose only original is a RAW, so "RAW". */
export function mediaNoun(hasVideo: boolean, hasPhoto: boolean, allRaw = false): "file" | "video" | "photo" | "RAW" {
  return hasVideo && hasPhoto ? "file" : hasVideo ? "video" : allRaw ? "RAW" : "photo";
}
