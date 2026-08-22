// Source: Wikimedia Commons (commons.wikimedia.org). License: CC/PD per file (lifer-spec.md §5).
// Fallback reference photo for species where iNaturalist has no usable default photo — takes
// the Commons file Wikidata already points at (P18, fetched in fetch-wikidata.ts) and pulls its
// real license + photographer credit from the Commons API, same allowlist as iNaturalist
// (../license-policy.ts) so both sources are held to the same commercial-safe-by-default bar.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { isLicenseAllowed, normalizeLicense } from "../license-policy.js";
import { fetchWithRetry } from "../fetch-with-retry.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

export interface CommonsPhotoRow {
  photoUrl: string | null;
  credit: string | null;
  license: string | null;
}

interface CommonsImageInfo {
  url: string;
  extmetadata: {
    Artist?: { value: string };
    LicenseShortName?: { value: string };
    License?: { value: string };
  };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

/** commonsImageUrl looks like "http://commons.wikimedia.org/wiki/Special:FilePath/Foo%20bar.jpg". */
function filenameFromCommonsUrl(commonsImageUrl: string): string | null {
  const m = commonsImageUrl.match(/Special:FilePath\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Looks up a Commons file by its bare filename (no "File:" prefix, no URL wrapper). */
export async function fetchCommonsFileMetadata(filename: string): Promise<CommonsPhotoRow> {
  const url =
    `${COMMONS_API}?action=query&titles=${encodeURIComponent(`File:${filename}`)}` +
    `&prop=imageinfo&iiprop=extmetadata|url&format=json&origin=*`;
  const res = await fetchWithRetry(url, { headers: { "User-Agent": "lifer-data-pipeline/0.1 (personal project)" } });
  if (!res.ok) return { photoUrl: null, credit: null, license: null };

  const data = (await res.json()) as { query: { pages: Record<string, { imageinfo?: CommonsImageInfo[] }> } };
  const page = Object.values(data.query.pages)[0];
  const info = page?.imageinfo?.[0];
  if (!info) return { photoUrl: null, credit: null, license: null };

  const rawLicense = info.extmetadata.License?.value ?? info.extmetadata.LicenseShortName?.value;
  const license = rawLicense ? normalizeLicense(rawLicense) : null;
  if (!license || !isLicenseAllowed(license)) return { photoUrl: null, credit: null, license: null };

  const artist = info.extmetadata.Artist?.value ? stripHtml(info.extmetadata.Artist.value) : "Unknown";
  return {
    photoUrl: info.url,
    credit: `${artist}, via Wikimedia Commons (${info.extmetadata.LicenseShortName?.value ?? license})`,
    license,
  };
}

export async function fetchCommonsPhoto(commonsImageUrl: string): Promise<CommonsPhotoRow> {
  const filename = filenameFromCommonsUrl(commonsImageUrl);
  if (!filename) return { photoUrl: null, credit: null, license: null };
  return fetchCommonsFileMetadata(filename);
}

async function main() {
  const wikidataPath = path.join(BUILD_DIR, "wikidata.json");
  const rows = JSON.parse((await import("node:fs")).readFileSync(wikidataPath, "utf-8")) as Array<{
    scientificName: string;
    commonsImage: string | null;
  }>;

  const results: Array<{ scientificName: string } & CommonsPhotoRow> = [];
  for (const r of rows) {
    if (!r.commonsImage) {
      results.push({ scientificName: r.scientificName, photoUrl: null, credit: null, license: null });
      continue;
    }
    const photo = await fetchCommonsPhoto(r.commonsImage);
    results.push({ scientificName: r.scientificName, ...photo });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "commons-photos.json");
  writeFileSync(dest, JSON.stringify(results, null, 2));
  console.log(`[commons-photo] wrote ${results.length} rows (${results.filter((r) => r.photoUrl).length} usable) to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
