// Where Lifer's release files live on GitHub. Packs and pack-index.json are on packs-latest (see
// pipeline/packStore.ts), the one release packages/core/src/config.ts's PACK_INDEX_URL points at.
// LIFER_DATA_REPO points a fork's pipeline at its own releases (owner/name).
export const GITHUB_REPO = process.env.LIFER_DATA_REPO?.trim() || "Sparklysparkspark/lifer-app";
export const INDEX_RELEASE_TAG = "packs-latest";
