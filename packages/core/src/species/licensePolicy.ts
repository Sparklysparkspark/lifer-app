// Shared CC-license allowlist for anything sourced from iNaturalist or Wikimedia Commons.
// Commercial-safe by default; LIFER_ALLOW_NONCOMMERCIAL_PHOTOS=1 also allows
// CC-BY-NC/CC-BY-NC-SA/CC-BY-ND/CC-BY-NC-ND for local dev. The license code is always stored
// (species.reference_license), so tightening later is a filter, not a re-fetch.

const COMMERCIAL_SAFE_LICENSES = new Set(["cc0", "cc-by", "cc-by-sa"]);
const RESTRICTED_LICENSES = new Set(["cc-by-nc", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"]);

/** Strips version suffixes like "cc-by-sa-3.0" -> "cc-by-sa" for a stable comparison key. */
export function normalizeLicense(code: string): string {
  return code.toLowerCase().replace(/-\d+(\.\d+)*$/, "");
}

export function isLicenseAllowed(code: string): boolean {
  const normalized = normalizeLicense(code);
  if (COMMERCIAL_SAFE_LICENSES.has(normalized)) return true;
  if (process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS === "1") {
    return RESTRICTED_LICENSES.has(normalized);
  }
  return false;
}

export function isRestrictedLicense(code: string): boolean {
  return RESTRICTED_LICENSES.has(normalizeLicense(code));
}

/** Licenses whose photos the project publishes (packs, the photo store, the catalog seed).
 *  Lifer is free and non-commercial and keeps every photo's credit and license, which is what the
 *  NC licenses ask. No-derivatives photos are included too: Lifer only resizes them and converts
 *  them to WebP, which CC 4.0 (section 2(a)(4)) counts as a technical modification, never an
 *  adaptation; framing a photo in a card is done at display time, not baked into the file. Never
 *  published: "all rights reserved" (or no license) and GFDL, whose terms need the full license
 *  text alongside. Anyone reusing the published data commercially has to drop the NC photos;
 *  THIRD_PARTY_NOTICES.md says so. */
const PUBLISHABLE_LICENSES = new Set([
  "cc0",
  "pd",
  "cc-by",
  "cc-by-sa",
  "cc-by-nd",
  "cc-by-nc",
  "cc-by-nc-sa",
  "cc-by-nc-nd",
]);

/** Whether a photo may be published. Fixed by policy: LIFER_ALLOW_NONCOMMERCIAL_PHOTOS is for
 *  local development and never changes what the project redistributes. iNaturalist's "pd" is the
 *  Public Domain Mark. */
export function isPublishableLicense(code: string | null | undefined): boolean {
  return code != null && PUBLISHABLE_LICENSES.has(normalizeLicense(code));
}
