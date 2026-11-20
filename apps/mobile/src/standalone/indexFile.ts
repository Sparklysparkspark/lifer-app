import { Directory, File, Paths } from "expo-file-system";
import { PACK_INDEX_URL, parsePackIndex, type PackIndex } from "./packs";

/** Downloads the public pack index (about 20 MB, only when asked) and reads it; the file is deleted after. */
export async function fetchPackIndex(): Promise<PackIndex> {
  const dir = new Directory(Paths.cache, "lifer");
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, "pack-index.json");
  try {
    await File.downloadFileAsync(PACK_INDEX_URL, file, { idempotent: true });
    const index = parsePackIndex(await file.text());
    if (!index) throw new Error("bad pack index");
    return index;
  } finally {
    if (file.exists) file.delete();
  }
}
