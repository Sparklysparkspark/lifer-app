// Source: Wikipedia REST media-list API (en.wikipedia.org/api/rest_v1/page/media-list/...),
// resolved through Wikimedia Commons for real per-file license/credit (fetch-commons-photo.ts).
// Gives a small gallery of reference photos per species — for comparing your own upload
// against multiple real photos, not just the one Wikidata infobox image.
//
// The media list includes anything used in the article: the IUCN status icon, a range map,
// sometimes an audio-player icon, unrelated photos (a license plate, in one real case seen
// during testing). Filtered here to plausible photographs: real image extensions, and
// filenames that don't look like an icon/map/diagram. Imperfect by nature — this is a
// "probably a photo of the bird" heuristic, not a guarantee.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchCommonsFileMetadata, type CommonsPhotoRow } from "./fetch-commons-photo.js";
import { fetchWithRetry } from "../fetch-with-retry.js";

const MEDIA_LIST_API = "https://en.wikipedia.org/api/rest_v1/page/media-list/";
const MAX_PHOTOS = 6;
const PHOTO_EXTENSIONS = /\.(jpe?g|png)$/i;
const EXCLUDE_PATTERNS = /map|iucn|status|logo|icon|diagram|distribution|range|locator|plate|sound|chart/i;

interface MediaListItem {
  title?: string;
  type?: string;
}

export interface WikipediaMediaPhoto extends CommonsPhotoRow {
  sortOrder: number;
}

export async function fetchWikipediaMediaPhotos(title: string): Promise<WikipediaMediaPhoto[]> {
  const url = MEDIA_LIST_API + encodeURIComponent(title.replace(/ /g, "_"));
  const res = await fetchWithRetry(url, { headers: { "User-Agent": "lifer-data-pipeline/0.1 (personal project)" } });
  if (!res.ok) return [];

  const data = (await res.json()) as { items?: MediaListItem[] };
  const candidates = (data.items ?? [])
    .filter((item) => item.type === "image" && item.title)
    .map((item) => item.title!.replace(/^File:/, ""))
    .filter((filename) => PHOTO_EXTENSIONS.test(filename) && !EXCLUDE_PATTERNS.test(filename))
    .slice(0, MAX_PHOTOS);

  const results: WikipediaMediaPhoto[] = [];
  for (const filename of candidates) {
    const photo = await fetchCommonsFileMetadata(filename);
    if (photo.photoUrl) {
      results.push({ ...photo, sortOrder: results.length });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return results;
}

async function main() {
  const wikidataPath = path.join(BUILD_DIR, "wikidata.json");
  const rows = JSON.parse((await import("node:fs")).readFileSync(wikidataPath, "utf-8")) as Array<{
    scientificName: string;
    wikipediaTitle: string | null;
  }>;

  const results: Record<string, WikipediaMediaPhoto[]> = {};
  for (const r of rows) {
    if (!r.wikipediaTitle) continue;
    results[r.scientificName] = await fetchWikipediaMediaPhotos(r.wikipediaTitle);
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "wikipedia-media.json");
  writeFileSync(dest, JSON.stringify(results, null, 2));
  const total = Object.values(results).reduce((sum, list) => sum + list.length, 0);
  console.log(`[wikipedia-media] wrote galleries for ${Object.keys(results).length} species (${total} photos total) to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
