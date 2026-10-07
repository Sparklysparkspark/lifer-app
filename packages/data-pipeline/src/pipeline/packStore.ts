// The pack store: every pack archive back to back in a few shard files on the packs-latest
// release, next to pack-index.json, instead of one release asset per pack. A publish uploads
// the new shard or two and the index rather than thousands of assets, which would hit GitHub's
// upload rate limit and 1,000-asset-per-release cap.
//
// Each index entry's url is its shard, with `range: [offset, length]` and the archive's
// `sha256`; an install fetches just that range (GitHub serves release files with Range support,
// as the photo store relies on) and checks the hash. The archive itself is unchanged, so an
// install applies it exactly as before.
//
// Builds are incremental: a pack this run didn't rebuild keeps its published entry, pointing at
// the shard it's already in; rebuilt packs go into new shards. A shard nothing points at any more
// is deleted on publish.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { GITHUB_REPO, INDEX_RELEASE_TAG } from "../build/release-groups.js";
import type { IndexPack, PackIndex } from "./packs.js";

// Kept well under GitHub's 2 GB per-asset limit.
const MAX_SHARD_BYTES = 1_500_000_000;
export const PACK_SHARD_PREFIX = "lifer-packs-";
export const packShardUrl = (name: string): string => `https://github.com/${GITHUB_REPO}/releases/download/${INDEX_RELEASE_TAG}/${name}`;

const shardNameOf = (p: IndexPack): string | null => {
  const name = p.url.split("/").pop() ?? "";
  return p.range && name.startsWith(PACK_SHARD_PREFIX) ? name : null;
};

/** Writes the packs built into outDir (`builtFiles`, "<id>.pack.tar.gz") into new shards there and
 *  points their index entries at them. Every other entry must already be in the store. Returns the
 *  new shard files. */
export function writePackStore(outDir: string, index: PackIndex, builtFiles: Set<string>): string[] {
  const build = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const newShards: string[] = [];
  let fd: number | null = null;
  let offset = 0;
  const open = () => {
    if (fd != null) closeSync(fd);
    const file = path.join(outDir, `${PACK_SHARD_PREFIX}${build}-${newShards.length}.bin`);
    newShards.push(file);
    fd = openSync(file, "w");
    offset = 0;
  };
  try {
    for (const p of index.packs) {
      const file = `${p.id}.pack.tar.gz`;
      if (!builtFiles.has(file)) {
        if (!shardNameOf(p)) throw new Error(`${p.id} wasn't rebuilt and isn't in the pack store`);
        continue;
      }
      const buf = readFileSync(path.join(outDir, file));
      if (fd == null || offset + buf.length > MAX_SHARD_BYTES) open();
      writeSync(fd!, buf);
      p.url = packShardUrl(path.basename(newShards[newShards.length - 1]));
      p.range = [offset, buf.length];
      p.sha256 = createHash("sha256").update(buf).digest("hex");
      p.sizeBytes = buf.length;
      p.format = 3;
      offset += buf.length;
    }
  } finally {
    if (fd != null) closeSync(fd);
  }
  return newShards;
}

/** Uploads the shards the index uses that the release doesn't have, then the index (so it never
 *  names a shard not uploaded yet), then deletes shards nothing uses and the old per-continent
 *  pack releases. */
export async function publishPackStore(outDir: string, index: PackIndex, log: (m: string) => void = console.log): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const gh = (args: string[], inherit = true) =>
    execFileSync("gh", args, { encoding: "utf8", stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
  const assetNames = () => JSON.parse(gh(["release", "view", INDEX_RELEASE_TAG, "--json", "assets", "--jq", "[.assets[].name]"], false)) as string[];
  try {
    gh(["release", "view", INDEX_RELEASE_TAG, "--json", "tagName"], false);
  } catch {
    gh(["release", "create", INDEX_RELEASE_TAG, "--title", "Offline packs", "--notes", "Offline pack index and pack store. See packages/data-pipeline/src/pipeline/packStore.ts.", "--prerelease", "--latest=false"]);
  }
  const used = new Set(index.packs.map(shardNameOf).filter((n): n is string => n != null));
  const onRelease = new Set(assetNames());
  for (const name of [...used].filter((n) => !onRelease.has(n))) {
    const file = path.join(outDir, name);
    if (!existsSync(file)) throw new Error(`Pack shard ${name} isn't on the release or on disk`);
    log(`[pack-store] uploading ${name} (${(statSync(file).size / 1e6).toFixed(0)} MB)`);
    gh(["release", "upload", INDEX_RELEASE_TAG, file, "--clobber"]);
  }
  gh(["release", "upload", INDEX_RELEASE_TAG, path.join(outDir, "pack-index.json"), "--clobber"]);
  for (const name of assetNames().filter((n) => n.startsWith(PACK_SHARD_PREFIX) && !used.has(n))) {
    log(`[pack-store] deleting ${name}, no longer used`);
    gh(["release", "delete-asset", INDEX_RELEASE_TAG, name, "--yes"]);
  }
  // Removes the old per-continent pack releases (packs-europe, packs-seazones, ...). Deleting a
  // whole release is one call, however many assets it has.
  const releases = (JSON.parse(gh(["release", "list", "--limit", "200", "--json", "tagName"], false)) as Array<{ tagName: string }>)
    .map((r) => r.tagName)
    .filter((t) => t.startsWith("packs-") && t !== INDEX_RELEASE_TAG);
  for (const tag of releases) {
    log(`[pack-store] deleting the old ${tag} release`);
    gh(["release", "delete", tag, "--yes", "--cleanup-tag"]);
  }
}
