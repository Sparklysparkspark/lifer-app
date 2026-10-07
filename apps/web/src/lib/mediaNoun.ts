/** What to call a set of files in "Delete 3 …?": photos, videos, or "files" when it has both. */
export function mediaNoun(hasVideo: boolean, hasPhoto: boolean): "file" | "video" | "photo" {
  return hasVideo && hasPhoto ? "file" : hasVideo ? "video" : "photo";
}
