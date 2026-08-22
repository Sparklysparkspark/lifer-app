// Ported from packages/data-pipeline/src/license-policy.ts for the lazy on-demand gallery
// fetch (see lazyGallery.ts) — kept as a small duplicate rather than a cross-package import,
// since data-pipeline is a one-off ETL tool with its own heavy/unrelated deps (exiftool-vendored,
// sharp, etc.) that shouldn't become a runtime dependency of the live API server.
const COMMERCIAL_SAFE_LICENSES = new Set(["cc0", "cc-by", "cc-by-sa"]);
const RESTRICTED_LICENSES = new Set(["cc-by-nc", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"]);

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
