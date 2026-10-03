// The photo store: every photo a pack can install, stored once instead of once per pack, since
// widespread species would otherwise be copied into hundreds of packs. Packs carry only their
// checklist; an install fetches the photos it's missing from here by byte range (GitHub serves
// release files with Range support), so a pack's size shown in the app is exactly what it adds.
//
// Layout: shard files (lifer-photos-<build>-<n>.bin, each under GitHub's 2 GB asset limit) of
// photo bytes back to back, and an index (lifer-photo-store.json.gz) giving each photo's shard,
// offset, length and SHA-1:
//   species[speciesId] = { d?: Ref, t?: Ref, g?: { [photoUrl]: { d?: Ref, t?: Ref } } }
// d/t are the display and thumbnail sizes; g the gallery, keyed by photo URL (the install already
// has those rows from the catalog seed). Ref = [shard index, offset, length, sha1].
//
// Builds are incremental: a photo whose SHA-1 matches the previous index keeps its old location,
// so a refresh writes (and uploads) new shards only for photos that are new or changed.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { pool } from "../db.js";
import { GITHUB_REPO } from "../build/release-groups.js";

export const PHOTO_STORE_RELEASE_TAG = "photos-latest";
export const PHOTO_STORE_INDEX_NAME = "lifer-photo-store.json.gz";
export const photoStoreIndexUrl = (): string => `https://github.com/${GITHUB_REPO}/releases/download/${PHOTO_STORE_RELEASE_TAG}/${PHOTO_STORE_INDEX_NAME}`;
// Kept well under GitHub's 2 GB per-asset limit.
const MAX_SHARD_BYTES = 1_500_000_000;

export type PhotoRef = [shard: number, offset: number, length: number, sha1: string];
export interface PhotoPair {
  d?: PhotoRef;
  t?: PhotoRef;
}
export interface PhotoStoreIndex {
  v: 1;
  builtAt: string;
  shards: Array<{ name: string; bytes: number; sha256: string }>;
  species: Record<string, PhotoPair & { g?: Record<string, PhotoPair> }>;
}

export function readPhotoStoreIndex(file: string): PhotoStoreIndex {
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as PhotoStoreIndex;
}

// Only a 404 means nothing is published. Any other failure throws: building from scratch would
// rewrite and re-upload every photo.
async function fetchPublishedIndex(log: (m: string) => void): Promise<PhotoStoreIndex | null> {
  const res = await fetch(photoStoreIndexUrl(), { signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) {
    log("[photo-store] no published store yet; building on the last local build, if any");
    return null;
  }
  if (!res.ok) throw new Error(`Couldn't fetch the published photo store index: HTTP ${res.status}`);
  return JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")) as PhotoStoreIndex;
}

const sha1 = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");

export interface PhotoStoreBuild {
  indexPath: string;
  /** Shard files this build wrote, the only ones a publish needs to upload. */
  newShards: string[];
  photos: number;
  reused: number;
  newBytes: number;
  totalBytes: number;
}

/** Writes the store for every species on some checklist into outDir. `previous` is the index to
 *  build on (the published one by default); pass null to build from scratch. */
export async function buildPhotoStore(opts: {
  outDir: string;
  previous?: PhotoStoreIndex | null;
  log?: (m: string) => void;
}): Promise<PhotoStoreBuild> {
  const log = opts.log ?? console.log;
  mkdirSync(opts.outDir, { recursive: true });
  // Builds on the published store, or on the last local build when nothing is published yet
  // (its shards are still in outDir), so a rebuild never rewrites photos it already has.
  const localIndex = path.join(opts.outDir, PHOTO_STORE_INDEX_NAME);
  const previous =
    opts.previous !== undefined
      ? opts.previous
      : ((await fetchPublishedIndex(log)) ?? (existsSync(localIndex) ? readPhotoStoreIndex(localIndex) : null));

  const main = await pool.query<{ id: string; reference_display_path: string | null; reference_thumb_path: string | null }>(
    `SELECT s.id, s.reference_display_path, s.reference_thumb_path FROM species s
     WHERE NOT s.is_other_taxa
       AND (EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
            OR EXISTS (SELECT 1 FROM sea_zone_species z WHERE z.species_id = s.id))
       AND (s.reference_display_path IS NOT NULL OR s.reference_thumb_path IS NOT NULL)
     ORDER BY s.id`,
  );
  const gallery = await pool.query<{ species_id: string; photo_url: string; display_path: string | null; thumb_path: string | null }>(
    `SELECT p.species_id, p.photo_url, p.display_path, p.thumb_path FROM species_reference_photos p
     JOIN species s ON s.id = p.species_id
     WHERE NOT s.is_other_taxa AND (p.display_path IS NOT NULL OR p.thumb_path IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM reference_photo_blocklist b WHERE b.photo_url = p.photo_url)
       AND (EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
            OR EXISTS (SELECT 1 FROM sea_zone_species z WHERE z.species_id = s.id))
     ORDER BY p.species_id, p.sort_order`,
  );

  // Previous locations by content, so an unchanged photo is never written or uploaded again.
  const reusable = new Map<string, PhotoRef>();
  const keptShards = new Map<number, number>(); // previous shard index -> new index
  const shards: PhotoStoreIndex["shards"] = [];
  if (previous) {
    for (const entry of Object.values(previous.species)) {
      for (const pair of [entry, ...Object.values(entry.g ?? {})]) {
        for (const ref of [pair.d, pair.t]) if (ref) reusable.set(ref[3], ref);
      }
    }
  }
  const reuse = (ref: PhotoRef): PhotoRef => {
    let idx = keptShards.get(ref[0]);
    if (idx === undefined) {
      idx = shards.length;
      shards.push(previous!.shards[ref[0]]);
      keptShards.set(ref[0], idx);
    }
    return [idx, ref[1], ref[2], ref[3]];
  };

  const build = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const newShards: string[] = [];
  let fd: number | null = null;
  let shardIndex = -1;
  let shardBytes = 0;
  let shardHash = createHash("sha256");
  const closeShard = () => {
    if (fd == null) return;
    closeSync(fd);
    shards[shardIndex] = { ...shards[shardIndex], bytes: shardBytes, sha256: shardHash.digest("hex") };
    fd = null;
  };
  // Same bytes stored once within this build too (a gallery photo that's also the main photo).
  const writtenThisBuild = new Map<string, PhotoRef>();
  let reused = 0;
  let newBytes = 0;
  let photos = 0;
  let missing = 0;

  const store = (file: string | null): PhotoRef | undefined => {
    if (!file) return undefined;
    if (!existsSync(file)) {
      missing++;
      return undefined;
    }
    const buf = readFileSync(file);
    const hash = sha1(buf);
    photos++;
    const again = writtenThisBuild.get(hash);
    if (again) return again;
    const prior = reusable.get(hash);
    if (prior) {
      reused++;
      const ref = reuse(prior);
      writtenThisBuild.set(hash, ref);
      return ref;
    }
    if (fd == null || shardBytes + buf.length > MAX_SHARD_BYTES) {
      closeShard();
      shardIndex = shards.length;
      const name = `lifer-photos-${build}-${newShards.length}.bin`;
      shards.push({ name, bytes: 0, sha256: "" });
      newShards.push(path.join(opts.outDir, name));
      fd = openSync(path.join(opts.outDir, name), "w");
      shardBytes = 0;
      shardHash = createHash("sha256");
    }
    writeSync(fd, buf);
    shardHash.update(buf);
    const ref: PhotoRef = [shardIndex, shardBytes, buf.length, hash];
    shardBytes += buf.length;
    newBytes += buf.length;
    writtenThisBuild.set(hash, ref);
    return ref;
  };

  const species: PhotoStoreIndex["species"] = {};
  for (const [i, r] of main.rows.entries()) {
    const d = store(r.reference_display_path);
    const t = store(r.reference_thumb_path);
    if (d || t) species[r.id] = { ...(d && { d }), ...(t && { t }) };
    if (i % 10_000 === 0) log(`[photo-store] main photos ${i}/${main.rows.length}`);
  }
  for (const [i, g] of gallery.rows.entries()) {
    const d = store(g.display_path);
    const t = store(g.thumb_path);
    if (!d && !t) continue;
    const entry = (species[g.species_id] ??= {});
    (entry.g ??= {})[g.photo_url] = { ...(d && { d }), ...(t && { t }) };
    if (i % 20_000 === 0) log(`[photo-store] gallery photos ${i}/${gallery.rows.length}`);
  }
  closeShard();

  const index: PhotoStoreIndex = { v: 1, builtAt: new Date().toISOString(), shards, species };
  const indexPath = path.join(opts.outDir, PHOTO_STORE_INDEX_NAME);
  writeFileSync(indexPath, gzipSync(JSON.stringify(index)));
  const totalBytes = shards.reduce((a, s) => a + s.bytes, 0);
  log(
    `[photo-store] ${photos} photos for ${Object.keys(species).length} species: ${reused} reused, ` +
      `${(newBytes / 1e9).toFixed(2)} GB new in ${newShards.length} shard(s), ${(totalBytes / 1e9).toFixed(2)} GB in the store` +
      (missing > 0 ? `; ${missing} files the database lists are missing on disk` : "") +
      `; index ${(statSync(indexPath).size / 1e6).toFixed(1)} MB`,
  );
  return { indexPath, newShards, photos, reused, newBytes, totalBytes };
}

/** Uploads a build's new shards, then its index (so the index never names a shard not uploaded
 *  yet), then deletes shards the new index no longer uses. */
export async function publishPhotoStore(build: PhotoStoreBuild, log: (m: string) => void = console.log): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const gh = (args: string[], inherit = true) =>
    execFileSync("gh", args, { encoding: "utf8", stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
  try {
    gh(["release", "view", PHOTO_STORE_RELEASE_TAG, "--json", "tagName"], false);
  } catch {
    gh(["release", "create", PHOTO_STORE_RELEASE_TAG, "--title", "Pack photos", "--notes", "Photos for offline packs, fetched by byte range. See packages/data-pipeline/src/pipeline/photoStore.ts."]);
  }
  // Every shard the index uses that the release doesn't have yet, which after a local rebuild
  // can include shards an earlier build wrote.
  const used = readPhotoStoreIndex(build.indexPath).shards;
  let assets = JSON.parse(gh(["release", "view", PHOTO_STORE_RELEASE_TAG, "--json", "assets", "--jq", "[.assets[].name]"], false)) as string[];
  const toUpload = used.filter((s) => !assets.includes(s.name));
  for (const [i, shard] of toUpload.entries()) {
    const file = path.join(path.dirname(build.indexPath), shard.name);
    if (!existsSync(file)) throw new Error(`Shard ${shard.name} isn't on the release or on disk`);
    log(`[photo-store] uploading shard ${i + 1}/${toUpload.length}: ${shard.name} (${(statSync(file).size / 1e9).toFixed(2)} GB)`);
    gh(["release", "upload", PHOTO_STORE_RELEASE_TAG, file, "--clobber"]);
  }
  gh(["release", "upload", PHOTO_STORE_RELEASE_TAG, build.indexPath, "--clobber"]);
  const usedNames = new Set(used.map((s) => s.name));
  assets = JSON.parse(gh(["release", "view", PHOTO_STORE_RELEASE_TAG, "--json", "assets", "--jq", "[.assets[].name]"], false)) as string[];
  for (const name of assets.filter((n) => n.endsWith(".bin") && !usedNames.has(n))) {
    log(`[photo-store] deleting ${name}, no longer used`);
    gh(["release", "delete-asset", PHOTO_STORE_RELEASE_TAG, name, "--yes"]);
  }
}
