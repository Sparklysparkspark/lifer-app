// Shared CC-license allowlist for anything sourced from iNaturalist or Wikimedia Commons
// (lifer-spec.md §5). Commercial-safe by default. Set LIFER_ALLOW_NONCOMMERCIAL_PHOTOS=1
// to additionally allow CC-BY-NC/CC-BY-NC-SA/CC-BY-ND/CC-BY-NC-ND for local dev/test runs
// on a personal, non-commercial MVP. The actual license code is always stored alongside the
// photo (species.reference_license), so tightening back to commercial-safe-only later is a
// one-line filter (reference_license NOT IN (...)), not a re-fetch.

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
