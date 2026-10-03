// A copy of packages/data-pipeline/src/license-policy.ts, kept here so the API doesn't depend on
// the data pipeline's heavy ETL dependencies.
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
