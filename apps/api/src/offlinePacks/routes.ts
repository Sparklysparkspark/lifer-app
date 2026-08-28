// Downloads and applies packs built by data-pipeline's
// build-region-pack.ts. Two kinds of duplication are guarded against, at two different
// layers: a sea-zone pack shared by several countries is only ever fetched once (tracked by
// pack id in downloaded_packs — see applyPack's dependency queue below), and a species whose
// range spans two packs (e.g. present in both a "North America" and "Central America" pack)
// only ever gets its photo/description written once (a species already enriched, by ANY
// earlier pack or the app's own lazy path, is left alone — see applyPack's dedup check).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { APP_DATA_DIR, PACK_INDEX_URL } from "../config.js";
// Cross-package import, same convention as regions/routes.ts's own build-region-species.js
// import — pure id-derivation logic with no heavy runtime deps.
import { packIdFromFileName } from "data-pipeline/src/build/pack-id.js";

interface PackIndexEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  sizeBytes: number;
  speciesCount: number;
  // Content hash of the pack's manifest (see build-region-pack.ts's contentHash) — lets an
  // already-downloaded pack be recognized as stale when its upstream content changes, instead
  // of dedup being purely "have I ever downloaded this id" forever.
  contentVersion: string;
  // Deduplicated across the pack's own top-level species and every bundled child region's
  // species (build-pack-index.ts does the dedup — a country pack's manifest doesn't
  // deduplicate those against each other) — the only thing /offline-packs/recommend needs to
  // score a pack's coverage against a list of missing species.
  scientificNames: string[];
  url: string;
}

interface PackIndex {
  generatedAt: string;
  packs: PackIndexEntry[];
}

async function fetchPackIndex(): Promise<PackIndex> {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  const res = await fetch(PACK_INDEX_URL);
  if (!res.ok) throw new Error(`Couldn't fetch the pack index (${res.status})`);
  return (await res.json()) as PackIndex;
}

// The index itself comes from a trusted, operator-configured URL (PACK_INDEX_URL), but each
// individual pack's `url` is just a field inside that fetched JSON — if the index host were
// ever compromised or MITM'd, an entry could point this server's outbound fetch() at an
// internal service (a LAN admin panel, a cloud metadata endpoint) instead of a real pack.
// Requiring every pack to be hosted on the same origin as the index it came from keeps the
// server's outbound requests confined to wherever the operator actually pointed it.
function assertTrustedPackUrl(url: string): void {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  const packOrigin = new URL(url).origin;
  const indexOrigin = new URL(PACK_INDEX_URL).origin;
  if (packOrigin !== indexOrigin) {
    throw new Error(`Refusing to fetch a pack from an untrusted origin: ${packOrigin}`);
  }
}

interface ManifestSpecies {
  scientificName: string;
  habitatDescription: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  displayFile: string | null;
  thumbFile: string | null;
  // Checklist membership — see build-region-pack.ts's ManifestSpecies for why this rides
  // along in the same entry rather than a separate list. Omitted entirely for a sea-zone
  // pack except recordCount.
  localFrequency?: number | null;
  seasonality?: number[] | null;
  localTier?: string | null;
  isVagrant?: boolean;
  recordCount?: number;
}

interface ManifestChildRegion {
  name: string;
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown;
  externalCodes: string[];
  species: ManifestSpecies[];
}

interface PackManifest {
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  species: ManifestSpecies[];
  // Provinces/states bundled into a country pack (see build-region-pack.ts's
  // fetchChildRegionsWithSpecies) — applied the same way as the top-level region, just
  // against a local province row this install may not have yet (created here if missing).
  children?: ManifestChildRegion[];
  seaZoneDependencies?: Array<{ name: string; packFile: string }>;
}

// A manifest's displayFile/thumbFile come from inside a downloaded archive, not from this
// server's own code — an entry like "../../../etc/passwd" (or an absolute path) would
// otherwise let a malicious or corrupted pack read/copy a file from anywhere on disk. Resolves
// the joined path and requires it to still land inside extractDir before anything touches it.
function resolveWithinDir(dir: string, relativePath: string): string | null {
  const resolved = path.resolve(dir, relativePath);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// Applies one region/sea-zone's species list — enrichment fields (photo/habitat text) plus
// checklist membership (region_species/sea_zone_species). Shared between the top-level
// region a pack is named after and any provinces/states bundled into it (see
// build-region-pack.ts's fetchChildRegionsWithSpecies) — a province is applied exactly the
// same way, just against its own local region row instead of the country's.
async function applyChecklist(
  species: ManifestSpecies[],
  target: { regionId: string } | { seaZoneId: string },
  extractDir: string,
  displayDir: string,
  thumbDir: string,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  for (const sp of species) {
    const existing = await pool.query<{ id: string; enriched_at: string | null }>(
      `SELECT id, enriched_at FROM species WHERE scientific_name = $1`,
      [sp.scientificName],
    );
    const row = existing.rows[0];
    // No local match — a pack can reference species this install's own seed doesn't have
    // (different taxonomy version, etc.) — nothing at all to apply for this entry.
    if (!row) {
      skipped++;
      continue;
    }

    // Enrichment fields (photo/habitat text) only fill in if this species hasn't already
    // been enriched by something else (its own lazy fetch, or an earlier pack) — see this
    // file's top comment on the cross-pack dedup. Checklist membership below is applied
    // regardless of enrichment status: a species can already be enriched yet still need
    // its region_species row for THIS newly-downloaded region.
    if (!row.enriched_at) {
      const displaySource = sp.displayFile ? resolveWithinDir(extractDir, sp.displayFile) : null;
      const thumbSource = sp.thumbFile ? resolveWithinDir(extractDir, sp.thumbFile) : null;

      let displayPath: string | null = null;
      let thumbPath: string | null = null;
      if (displaySource && existsSync(displaySource)) {
        displayPath = path.join(displayDir, `${row.id}.webp`);
        copyFileSync(displaySource, displayPath);
      }
      if (thumbSource && existsSync(thumbSource)) {
        thumbPath = path.join(thumbDir, `${row.id}.webp`);
        copyFileSync(thumbSource, thumbPath);
      }

      await pool.query(
        `UPDATE species SET
           habitat_description = COALESCE(habitat_description, $1),
           reference_credit = COALESCE(reference_credit, $2),
           reference_license = COALESCE(reference_license, $3),
           reference_display_path = COALESCE(reference_display_path, $4),
           reference_thumb_path = COALESCE(reference_thumb_path, $5),
           enriched_at = now()
         WHERE id = $6`,
        [sp.habitatDescription, sp.referenceCredit, sp.referenceLicense, displayPath, thumbPath, row.id],
      );
    }

    if ("regionId" in target) {
      await pool.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (region_id, species_id) DO UPDATE SET
           local_frequency = EXCLUDED.local_frequency,
           seasonality = EXCLUDED.seasonality,
           local_tier = EXCLUDED.local_tier,
           is_vagrant = EXCLUDED.is_vagrant`,
        [target.regionId, row.id, sp.localFrequency ?? null, sp.seasonality ?? null, sp.localTier ?? null, sp.isVagrant ?? false],
      );
    } else {
      await pool.query(
        `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (sea_zone_id, species_id) DO UPDATE SET record_count = EXCLUDED.record_count`,
        [target.seaZoneId, row.id, sp.recordCount ?? 0],
      );
    }
    applied++;
  }
  return { applied, skipped };
}

async function applyPack(archivePath: string): Promise<{ speciesCount: number; skipped: number; manifest: PackManifest }> {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-"));
  try {
    await tar.extract({ file: archivePath, cwd: extractDir });
    const manifest = JSON.parse(readFileSync(path.join(extractDir, "manifest.json"), "utf-8")) as PackManifest;

    const displayDir = path.join(APP_DATA_DIR, "reference-display");
    const thumbDir = path.join(APP_DATA_DIR, "reference-thumb");
    mkdirSync(displayDir, { recursive: true });
    mkdirSync(thumbDir, { recursive: true });

    // Resolved once, not per species — the checklist membership a pack carries is applied
    // against this install's own local region/sea-zone row, matched by name (the same
    // cross-install identity approach as species-by-scientific-name; every install seeds an
    // identical regions/sea_zones table, just with its own UUIDs).
    let regionId: string | null = null;
    let seaZoneId: string | null = null;
    if (manifest.type === "region" && manifest.region) {
      const res = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [manifest.region]);
      regionId = res.rows[0]?.id ?? null;
    } else if (manifest.type === "seaZone" && manifest.seaZone) {
      const res = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [manifest.seaZone]);
      seaZoneId = res.rows[0]?.id ?? null;
    }

    let applied = 0;
    let skipped = 0;
    if (regionId) {
      const result = await applyChecklist(manifest.species, { regionId }, extractDir, displayDir, thumbDir);
      applied += result.applied;
      skipped += result.skipped;
    } else if (seaZoneId) {
      const result = await applyChecklist(manifest.species, { seaZoneId }, extractDir, displayDir, thumbDir);
      applied += result.applied;
      skipped += result.skipped;
    }

    // Provinces/states bundled into a country pack — create the local region row if this
    // install doesn't have it yet (matched by name; same cross-install identity approach as
    // everything else here), then apply its checklist exactly like the country's own.
    if (regionId && manifest.children) {
      for (const child of manifest.children) {
        await pool.query(
          `INSERT INTO regions (name, parent_id, ebird_region_code, boundary_geojson, external_codes, occurrence_computed_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (name, parent_id) DO NOTHING`,
          [child.name, regionId, child.ebirdRegionCode, JSON.stringify(child.boundaryGeoJson), child.externalCodes],
        );
        const childRegionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1 AND parent_id = $2`, [
          child.name,
          regionId,
        ]);
        const childRegionId = childRegionRes.rows[0]?.id;
        if (!childRegionId) continue;
        const result = await applyChecklist(child.species, { regionId: childRegionId }, extractDir, displayDir, thumbDir);
        applied += result.applied;
        skipped += result.skipped;
        await pool.query(`UPDATE regions SET occurrence_computed_at = now(), has_children = false WHERE id = $1`, [childRegionId]);
      }
      await pool.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);
    }

    // Checklist membership is now real, downloaded data — the region no longer needs (and,
    // going forward, should never trigger) a live GBIF computation of its own.
    if (regionId) {
      await pool.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
    } else if (seaZoneId) {
      await pool.query(`UPDATE sea_zones SET occurrence_computed_at = now() WHERE id = $1`, [seaZoneId]);
    }

    return { speciesCount: applied, skipped, manifest };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

interface DownloadJobState {
  running: boolean;
  processed: number;
  total: number;
  currentPack: string | null;
  error: string | null;
  finishedAt: number | null;
}
const downloadJob: DownloadJobState = {
  running: false,
  processed: 0,
  total: 0,
  currentPack: null,
  error: null,
  finishedAt: null,
};

async function runDownloadJob(requestedPackIds: string[]): Promise<void> {
  try {
    const index = await fetchPackIndex();
    const byId = new Map(index.packs.map((p) => [p.id, p]));

    const queue = [...requestedPackIds];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      downloadJob.currentPack = id;
      downloadJob.total = seen.size + queue.length;

      const entry = byId.get(id);
      if (!entry) {
        // Unknown pack id (index changed since the client's copy, a stale dependency
        // reference) — skip it rather than fail the whole job over one bad entry.
        downloadJob.processed++;
        continue;
      }

      // Only skip when the CONTENT hasn't changed — a pack already downloaded at an older
      // content_version proceeds through the same download+apply flow below to pick up the
      // update (safe to re-apply: enrichment writes are COALESCE-guarded, checklist upserts
      // are ON CONFLICT DO UPDATE — see applyPack's own comments).
      const already = await pool.query<{ content_version: string | null }>(
        `SELECT content_version FROM downloaded_packs WHERE pack_id = $1`,
        [id],
      );
      if (already.rows.length > 0 && already.rows[0].content_version === entry.contentVersion) {
        downloadJob.processed++;
        continue;
      }

      assertTrustedPackUrl(entry.url);
      const tmpFile = path.join(os.tmpdir(), `${id}.pack.tar.gz`);
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`Couldn't download "${id}": ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(tmpFile, buf);

      const { speciesCount, manifest } = await applyPack(tmpFile);
      rmSync(tmpFile, { force: true });

      await pool.query(
        `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count, bytes, content_version) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pack_id) DO UPDATE SET
           species_count = EXCLUDED.species_count, bytes = EXCLUDED.bytes, content_version = EXCLUDED.content_version, downloaded_at = now()`,
        [id, entry.region ?? entry.seaZone ?? null, entry.taxon ?? null, speciesCount, buf.length, entry.contentVersion],
      );

      downloadJob.processed++;
      for (const dep of manifest.seaZoneDependencies ?? []) {
        const depId = packIdFromFileName(dep.packFile);
        if (!seen.has(depId)) queue.push(depId);
      }
    }
  } catch (err) {
    downloadJob.error = (err as Error).message;
  } finally {
    downloadJob.running = false;
    downloadJob.currentPack = null;
    downloadJob.finishedAt = Date.now();
  }
}

export async function offlinePacksRoutes(app: FastifyInstance): Promise<void> {
  app.get("/offline-packs/index", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      const index = await fetchPackIndex();
      const downloadedRes = await pool.query<{ pack_id: string; content_version: string | null }>(
        `SELECT pack_id, content_version FROM downloaded_packs`,
      );
      const downloadedVersions = new Map(downloadedRes.rows.map((r) => [r.pack_id, r.content_version]));
      return {
        generatedAt: index.generatedAt,
        // scientificNames is left out here — this listing only ever renders pack cards, never
        // needs the per-species names, and it can be a meaningful chunk of payload for the
        // largest all-taxa country packs. /offline-packs/recommend fetches the full index
        // itself when it actually needs that field.
        packs: index.packs.map(({ scientificNames: _scientificNames, ...p }) => {
          const downloadedVersion = downloadedVersions.get(p.id);
          return {
            ...p,
            downloaded: downloadedVersion !== undefined,
            // A pack downloaded before content_version existed (downloadedVersion === null)
            // reads as "no update available" rather than a false positive — there's no real
            // signal to compare against yet, and it'll self-correct the next time it's
            // actually re-applied.
            updateAvailable: downloadedVersion != null && downloadedVersion !== p.contentVersion,
          };
        }),
      };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  // Given a list of scientific names (e.g. the gap the library reimport tool surfaced —
  // recovered species with no reference photo/description), greedily picks the smallest set
  // of not-yet-downloaded packs that covers them, rather than every pack with SOME overlap.
  // Standard greedy set-cover: repeatedly take whichever remaining pack covers the most still-
  // uncovered names, until either nothing's left to cover or no remaining pack covers anything.
  app.post<{ Body: { scientificNames?: string[] } }>("/offline-packs/recommend", { preHandler: requireAuth }, async (request, reply) => {
    const scientificNames = request.body?.scientificNames;
    if (!scientificNames || scientificNames.length === 0) {
      return reply.code(400).send({ error: "scientificNames is required" });
    }
    try {
      const index = await fetchPackIndex();
      const downloadedRes = await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs`);
      const downloadedIds = new Set(downloadedRes.rows.map((r) => r.pack_id));

      let remaining = new Set(scientificNames);
      const candidates = index.packs.filter((p) => !downloadedIds.has(p.id));
      const picked: Array<{ id: string; region?: string; seaZone?: string; taxon: string | null; sizeBytes: number; covers: number }> = [];

      while (remaining.size > 0) {
        let best: PackIndexEntry | null = null;
        let bestCoverage = 0;
        for (const pack of candidates) {
          if (picked.some((p) => p.id === pack.id)) continue;
          const coverage = pack.scientificNames.filter((n) => remaining.has(n)).length;
          if (coverage > bestCoverage) {
            best = pack;
            bestCoverage = coverage;
          }
        }
        if (!best || bestCoverage === 0) break;
        picked.push({ id: best.id, region: best.region, seaZone: best.seaZone, taxon: best.taxon ?? null, sizeBytes: best.sizeBytes, covers: bestCoverage });
        for (const name of best.scientificNames) remaining.delete(name);
      }

      return { recommended: picked, uncovered: [...remaining] };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.get("/offline-packs/download/status", { preHandler: requireAuth }, async () => downloadJob);

  app.post<{ Body: { packIds?: string[] } }>("/offline-packs/download", { preHandler: requireAuth }, async (request, reply) => {
    if (downloadJob.running) {
      return reply.code(409).send({ error: "A pack download is already in progress" });
    }
    const packIds = request.body?.packIds;
    if (!packIds || packIds.length === 0) {
      return reply.code(400).send({ error: "packIds is required" });
    }

    downloadJob.running = true;
    downloadJob.processed = 0;
    downloadJob.total = packIds.length;
    downloadJob.currentPack = null;
    downloadJob.error = null;
    downloadJob.finishedAt = null;

    // Deliberately not awaited — see settings/routes.ts's migrate-to-server job for the same
    // pattern and the same reasoning (a large download shouldn't hold one HTTP request open).
    void runDownloadJob(packIds);

    return { started: true };
  });
}
