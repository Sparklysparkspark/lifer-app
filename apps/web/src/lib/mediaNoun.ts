/** What to call a set of files in "Delete 3 …?": photos, videos, recordings, or "files" when it mixes
 *  kinds. `allRaw`: every one is a photo whose only original is a RAW, so "RAW". */
export function mediaNoun(
  hasVideo: boolean,
  hasPhoto: boolean,
  allRaw = false,
  hasAudio = false,
): "file" | "video" | "photo" | "RAW" | "recording" {
  if (Number(hasVideo) + Number(hasPhoto) + Number(hasAudio) > 1) return "file";
  if (hasAudio) return "recording";
  return hasVideo ? "video" : allRaw ? "RAW" : "photo";
}
