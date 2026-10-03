// The user guide (Docusaurus, published to GitHub Pages from docs/).
export const DOCS_BASE_URL = "https://sparklysparkspark.github.io/lifer-app";

/** docsUrl("/settings#species-naming") -> the full docs URL. Opens externally via a target="_blank" link. */
export function docsUrl(path = "/"): string {
  return `${DOCS_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
