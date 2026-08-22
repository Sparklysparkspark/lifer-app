// Source: iNaturalist API (api.inaturalist.org/v1). Per-photo license, so every stored
// image path carries a mandatory reference_credit + reference_license (schema.sql enforces
// this via a CHECK constraint — see lifer-spec.md §6).
// License filter: iNaturalist's open-licensed photos are served from the
// inaturalist-open-data.s3 domain (AWS Open Data); anything else is not confirmed open,
// so we skip it rather than guess. Allowed license set (and the LIFER_ALLOW_NONCOMMERCIAL_PHOTOS
// escape hatch) live in ../license-policy.ts, shared with the Wikimedia Commons fallback fetcher.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { isLicenseAllowed, isRestrictedLicense, normalizeLicense } from "../license-policy.js";

const INAT_API = "https://api.inaturalist.org/v1";
const OPEN_DATA_DOMAIN = "inaturalist-open-data.s3";

export interface ReferencePhotoRow {
  scientificName: string;
  inatTaxonId: number | null;
  photoUrl: string | null;
  credit: string | null;
  license: string | null;
}

interface InatTaxon {
  id: number;
  name: string;
  default_photo: {
    medium_url: string;
    license_code: string | null;
    attribution: string;
  } | null;
}

async function lookupTaxon(scientificName: string): Promise<InatTaxon | null> {
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { results: InatTaxon[] };
  return data.results[0] ?? null;
}

export async function fetchReferencePhoto(scientificName: string): Promise<ReferencePhotoRow> {
  const taxon = await lookupTaxon(scientificName);
  if (!taxon) return { scientificName, inatTaxonId: null, photoUrl: null, credit: null, license: null };

  const photo = taxon.default_photo;
  const license = photo?.license_code ? normalizeLicense(photo.license_code) : null;
  const isUsable = photo && license && isLicenseAllowed(license) && photo.medium_url.includes(OPEN_DATA_DOMAIN);

  return {
    scientificName,
    inatTaxonId: taxon.id,
    photoUrl: isUsable ? photo!.medium_url : null,
    credit: isUsable ? photo!.attribution : null,
    license: isUsable ? license : null,
  };
}

export async function fetchReferencePhotos(scientificNames: string[]): Promise<ReferencePhotoRow[]> {
  const rows: ReferencePhotoRow[] = [];
  for (const name of scientificNames) {
    rows.push(await fetchReferencePhoto(name));
    // iNaturalist asks for a small delay between requests when hitting the API in bulk.
    await new Promise((r) => setTimeout(r, 1000));
  }
  return rows;
}

async function main() {
  const gbifPath = path.join(BUILD_DIR, "gbif-backbone-aves.json");
  const gbifRows = JSON.parse((await import("node:fs")).readFileSync(gbifPath, "utf-8")) as Array<{
    scientificName: string;
    canonicalName: string | null;
  }>;
  // canonicalName is the plain binomial; scientificName carries the authorship string
  // ("... Linnaeus, 1758") which iNaturalist's search wouldn't match cleanly.
  const names = gbifRows.map((r) => r.canonicalName ?? r.scientificName);

  const rows = await fetchReferencePhotos(names);
  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "reference-photos.json");
  writeFileSync(dest, JSON.stringify(rows, null, 2));
  const withPhoto = rows.filter((r) => r.photoUrl).length;
  const restricted = rows.filter((r) => r.license && isRestrictedLicense(r.license)).length;
  console.log(
    `[reference-photos] wrote ${rows.length} rows (${withPhoto} with a usable photo, ` +
      `${restricted} not commercial-safe) to ${dest}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
