// Publishes a built catalog seed (build-catalog-seed.ts output) to the catalog-latest release.
// Every asset goes up under a name carrying the manifest version, so a publish never overwrites
// a file an install is downloading against the previous manifest's checksum. The replaced
// manifest's files stay until the publish after, for installs still mid-download.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { isRecord } from "../lib/jsonGuards.js";

export const CATALOG_RELEASE_TAG = "catalog-latest";
const MANIFEST_NAME = "catalog-manifest.json";
// Clients without a manifest fall back to this fixed name, unchecked.
const FALLBACK_SEED_NAME = "lifer-catalog-seed.sql.gz";

type Manifest = Record<string, unknown> & { version: number };

/** The files a catalog manifest lists: the seed and each vector asset. Anything else in the folder
 *  (an older model's vectors, say) stays unpublished. */
export function catalogManifestFiles(manifest: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const value of Object.values(manifest)) {
    const url = value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
    if (typeof url === "string") files.push(url);
  }
  return files;
}

/** "lifer-catalog-seed.sql.gz" -> "lifer-catalog-seed-<version>.sql.gz". */
export function versionedAssetName(name: string, version: number): string {
  const ext = /\.[a-z0-9]+\.gz$/i.exec(name)?.[0] ?? path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${version}${ext}`;
}

/** The manifest with every asset url versioned, and the local file behind each new name. */
export function versionCatalogManifest(manifest: Manifest): { manifest: Manifest; files: Map<string, string> } {
  const files = new Map<string, string>();
  const out: Manifest = { ...manifest };
  for (const [key, value] of Object.entries(manifest)) {
    const url = value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
    if (typeof url !== "string") continue;
    const name = versionedAssetName(url, manifest.version);
    files.set(name, url);
    out[key] = { ...(value as object), url: name };
  }
  return { manifest: out, files };
}

/** Release assets neither the new manifest nor the one it replaced uses. */
export function staleCatalogAssets(assets: string[], current: Manifest, previous: Manifest): string[] {
  const keep = new Set([
    MANIFEST_NAME,
    FALLBACK_SEED_NAME,
    ...catalogManifestFiles(current),
    ...catalogManifestFiles(previous),
  ]);
  return assets.filter((n) => /\.(sql|bin)\.gz$/.test(n) && !keep.has(n));
}

/** Every file the built manifest lists exists with the size and sha256 it records, so nothing
 *  is uploaded from a build that came out short. */
export async function verifyCatalogSeed(dir: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), "utf8")) as Record<string, unknown>;
  if (!isRecord(manifest.seed) || typeof manifest.seed.url !== "string")
    throw new Error("The catalog manifest lists no seed");
  for (const [key, value] of Object.entries(manifest)) {
    if (!isRecord(value) || typeof value.url !== "string") continue;
    const file = path.join(dir, value.url);
    if (!existsSync(file)) throw new Error(`Catalog ${key}: ${value.url} is missing`);
    if (typeof value.bytes !== "number" || statSync(file).size !== value.bytes)
      throw new Error(`Catalog ${key}: ${value.url} is ${statSync(file).size} bytes, the manifest says ${value.bytes}`);
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    if (value.sha256 !== hash.digest("hex")) throw new Error(`Catalog ${key}: ${value.url} doesn't match its sha256`);
  }
}

/** Uploads every asset `dir`'s manifest names under versioned names, then the manifest, then the
 *  fixed-name seed fallback, then deletes assets no current or previous manifest uses. */
export function publishCatalogSeed(dir: string, log: (m: string) => void = console.log): void {
  const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const built = JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), "utf8")) as Manifest;
  const { manifest, files } = versionCatalogManifest(built);

  let previous: Manifest | null = null;
  try {
    previous = JSON.parse(
      gh(["release", "download", CATALOG_RELEASE_TAG, "--pattern", MANIFEST_NAME, "--output", "-"]),
    ) as Manifest;
  } catch {
    log("[catalog] couldn't read the published manifest; nothing old will be deleted");
  }

  const stage = mkdtempSync(path.join(dir, ".publish-"));
  try {
    const staged = [...files].map(([name, local]) => {
      const dest = path.join(stage, name);
      try {
        linkSync(path.join(dir, local), dest);
      } catch {
        copyFileSync(path.join(dir, local), dest);
      }
      return dest;
    });
    const manifestPath = path.join(stage, MANIFEST_NAME);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    // Assets before the manifest, so an install never reads one pointing at files not uploaded yet.
    gh(["release", "upload", CATALOG_RELEASE_TAG, ...staged, "--clobber"]);
    gh(["release", "upload", CATALOG_RELEASE_TAG, manifestPath, "--clobber"]);
    if ((built.seed as { url?: string } | undefined)?.url === FALLBACK_SEED_NAME)
      gh(["release", "upload", CATALOG_RELEASE_TAG, path.join(dir, FALLBACK_SEED_NAME), "--clobber"]);
    log(`[catalog] published version ${built.version}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  if (!previous) return;
  const assets = JSON.parse(
    gh(["release", "view", CATALOG_RELEASE_TAG, "--json", "assets", "--jq", "[.assets[].name]"]),
  ) as string[];
  for (const name of staleCatalogAssets(assets, manifest, previous)) {
    log(`[catalog] deleting ${name}, no longer used`);
    gh(["release", "delete-asset", CATALOG_RELEASE_TAG, name, "--yes"]);
  }
}
