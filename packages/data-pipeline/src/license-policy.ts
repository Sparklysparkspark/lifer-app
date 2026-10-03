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
