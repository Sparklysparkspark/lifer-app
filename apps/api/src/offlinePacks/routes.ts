// Downloads and applies packs built by data-pipeline's
// build-region-pack.ts. Two kinds of duplication are guarded against, at two different
// layers: a sea-zone pack shared by several countries is only ever fetched once (tracked by
// pack id in downloaded_packs — see applyPack's dependency queue below), and a species whose
// range spans two packs (e.g. present in both a "North America" and "Central America" pack)
// only ever gets its photo/description written once (a species already enriched, by ANY
// earlier pack or the app's own lazy path, is left alone — see applyPack's dedup check).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
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

export interface PackIndexEntry {
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

export interface PackIndex {
  generatedAt: string;
  packs: PackIndexEntry[];
}

export async function fetchPackIndex(): Promise<PackIndex> {
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
  isOverseasTerritory: boolean;
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
): Promise<{ applied: number; skipped: number; touched: Array<{ speciesId: string; providedEnrichment: boolean }> }> {
  let applied = 0;
  let skipped = 0;
  const touched: Array<{ speciesId: string; providedEnrichment: boolean }> = [];
  for (const sp of species) {
    const existing = await pool.query<{
      id: string;
      enriched_at: string | null;
      reference_display_path: string | null;
      reference_thumb_path: string | null;
    }>(
      `SELECT id, enriched_at, reference_display_path, reference_thumb_path FROM species WHERE scientific_name = $1`,
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
    //
    // enriched_at alone isn't enough, though: species/region data restored from a portable
    // catalog seed (see desktop's embedded_db.rs) arrives with enriched_at already set but
    // NONE of the cached image files, deliberately — that's the whole reason a pack bundles
    // its own copies. Treating "enriched_at is set" as "nothing to do" would skip extracting
    // those images forever, even though this pack has exactly what's missing. Re-running the
    // copy whenever the currently-recorded path doesn't actually resolve on disk covers both:
    // a genuinely fresh species (never enriched at all) and one whose data moved here without
    // its files. Checked independently for display AND thumb — a species can have one file
    // present and the other missing (e.g. a partial extraction), and treating "display exists"
    // as "nothing to do" left the thumb 404ing forever even after re-downloading the pack.
    const referenceFileMissing =
      (row.reference_display_path != null && !existsSync(row.reference_display_path)) ||
      (row.reference_thumb_path != null && !existsSync(row.reference_thumb_path));
    const providedEnrichment = !row.enriched_at || referenceFileMissing;
    if (providedEnrichment) {
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
           reference_display_path = COALESCE($4, reference_display_path),
           reference_thumb_path = COALESCE($5, reference_thumb_path),
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
    touched.push({ speciesId: row.id, providedEnrichment });
    applied++;
  }
  return { applied, skipped, touched };
}

async function applyPack(archivePath: string): Promise<{
  speciesCount: number;
  skipped: number;
  manifest: PackManifest;
  touched: Array<{ speciesId: string; providedEnrichment: boolean }>;
  allChildRegionIds: string[];
  territoryChildRegionIds: string[];
}> {
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
    const touched: Array<{ speciesId: string; providedEnrichment: boolean }> = [];
    if (regionId) {
      const result = await applyChecklist(manifest.species, { regionId }, extractDir, displayDir, thumbDir);
      applied += result.applied;
      skipped += result.skipped;
      touched.push(...result.touched);
    } else if (seaZoneId) {
      const result = await applyChecklist(manifest.species, { seaZoneId }, extractDir, displayDir, thumbDir);
      applied += result.applied;
      skipped += result.skipped;
      touched.push(...result.touched);
    }

    // Provinces/states bundled into a country pack — create the local region row if this
    // install doesn't have it yet (matched by name; same cross-install identity approach as
    // everything else here), then apply its checklist exactly like the country's own.
    const territoryChildRegionIds: string[] = [];
    const allChildRegionIds: string[] = [];
    if (regionId && manifest.children) {
      for (const child of manifest.children) {
        await pool.query(
          `INSERT INTO regions (name, parent_id, ebird_region_code, boundary_geojson, external_codes, occurrence_computed_at, is_overseas_territory)
           VALUES ($1, $2, $3, $4, $5, now(), $6)
           ON CONFLICT (name, parent_id) DO UPDATE SET is_overseas_territory = EXCLUDED.is_overseas_territory`,
          [
            child.name,
            regionId,
            child.ebirdRegionCode,
            JSON.stringify(child.boundaryGeoJson),
            child.externalCodes,
            child.isOverseasTerritory ?? false,
          ],
        );
        const childRegionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1 AND parent_id = $2`, [
          child.name,
          regionId,
        ]);
        const childRegionId = childRegionRes.rows[0]?.id;
        if (!childRegionId) continue;
        allChildRegionIds.push(childRegionId);
        if (child.isOverseasTerritory) territoryChildRegionIds.push(childRegionId);
        const result = await applyChecklist(child.species, { regionId: childRegionId }, extractDir, displayDir, thumbDir);
        applied += result.applied;
        skipped += result.skipped;
        touched.push(...result.touched);
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

    return { speciesCount: applied, skipped, manifest, touched, allChildRegionIds, territoryChildRegionIds };
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

async function runDownloadJob(requestedPackIds: string[], force = false): Promise<void> {
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
      // are ON CONFLICT DO UPDATE — see applyPack's own comments). `force` bypasses this check
      // entirely — needed by Fix 8's "re-add a province" flow, which redownloads an
      // ALREADY-current-version pack specifically to restore a province whose region_species
      // rows were individually offloaded (content_version never changed, so the normal skip
      // would otherwise make this whole flow a no-op — confirmed live).
      if (!force) {
        const already = await pool.query<{ content_version: string | null }>(
          `SELECT content_version FROM downloaded_packs WHERE pack_id = $1`,
          [id],
        );
        if (already.rows.length > 0 && already.rows[0].content_version === entry.contentVersion) {
          downloadJob.processed++;
          continue;
        }
      }

      assertTrustedPackUrl(entry.url);
      const tmpFile = path.join(os.tmpdir(), `${id}.pack.tar.gz`);
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`Couldn't download "${id}": ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(tmpFile, buf);

      const { speciesCount, manifest, touched, allChildRegionIds, territoryChildRegionIds } = await applyPack(tmpFile);
      rmSync(tmpFile, { force: true });

      // applied_province_region_ids resets on every (re)download — applyPack's children loop
      // unconditionally restores every province each time, so any prior per-province exclusion
      // (Fix 8) no longer reflects reality once this runs. Defaults to excluding overseas
      // territories specifically (NULL/"all applied" only when there are none) rather than
      // requiring the user to manually offload each one after every fresh download — they can
      // still opt one back in via the same province checklist Fix 8 already built.
      const defaultAppliedProvinceIds =
        territoryChildRegionIds.length > 0 ? JSON.stringify(allChildRegionIds.filter((rid) => !territoryChildRegionIds.includes(rid))) : null;
      await pool.query(
        `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count, bytes, content_version, applied_province_region_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pack_id) DO UPDATE SET
           species_count = EXCLUDED.species_count, bytes = EXCLUDED.bytes, content_version = EXCLUDED.content_version,
           downloaded_at = now(), applied_province_region_ids = EXCLUDED.applied_province_region_ids`,
        [id, entry.region ?? entry.seaZone ?? null, entry.taxon ?? null, speciesCount, buf.length, entry.contentVersion, defaultAppliedProvinceIds],
      );

      // A species can appear more than once within one pack (e.g. a country's own checklist
      // AND one of its bundled provinces' checklists) — deduped here by species id before the
      // bulk upsert below, since a single INSERT's VALUES list can't ON CONFLICT-update the
      // same row twice. providedEnrichment=true wins the dedup (a species is "provided by this
      // pack" if ANY of its checklist entries within the pack triggered the actual file copy).
      const touchedBySpeciesId = new Map<string, boolean>();
      for (const t of touched) {
        touchedBySpeciesId.set(t.speciesId, touchedBySpeciesId.get(t.speciesId) || t.providedEnrichment);
      }
      if (touchedBySpeciesId.size > 0) {
        const speciesIds = [...touchedBySpeciesId.keys()];
        const providedFlags = speciesIds.map((sid) => touchedBySpeciesId.get(sid)!);
        await pool.query(
          `INSERT INTO pack_species (pack_id, species_id, provided_enrichment)
           SELECT $1, unnest($2::uuid[]), unnest($3::boolean[])
           ON CONFLICT (pack_id, species_id) DO UPDATE SET provided_enrichment = EXCLUDED.provided_enrichment`,
          [id, speciesIds, providedFlags],
        );
      }

      // Territories excluded by default (seeded above, before pack_species existed for this
      // pack) must actually have their region_species rows removed too — applyChecklist's
      // children loop just wrote them unconditionally like any other province, so without this
      // they'd show `applied: false` yet still count toward checklists/downloads until the user
      // happens to toggle them off manually. Uses this pack's own species (just upserted above),
      // not a stale/empty read from before this pack existed in pack_species at all.
      if (territoryChildRegionIds.length > 0 && touchedBySpeciesId.size > 0) {
        const speciesIds = [...touchedBySpeciesId.keys()];
        for (const territoryRegionId of territoryChildRegionIds) {
          await pool.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2)`, [territoryRegionId, speciesIds]);
        }
      }

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

interface DeleteImpact {
  regionIds: string[];
  seaZoneId: string | null;
  checklistRegionsAffected: string[];
  speciesToRemove: string[];
  speciesKeptCount: number;
  bytesToFree: number;
  // True when bytesToFree/speciesToRemove came from the pack_species-empty fallback below
  // (downloaded_packs.bytes, the whole archive's own size) rather than a real per-species
  // reference-photo tally — lets the UI say "about" instead of implying exact precision.
  isEstimate: boolean;
}

// Shared by both the dry-run preview and the real delete — same computation, the preview just
// never reaches the write step. Deleting a country pack also removes its bundled provinces'
// checklist rows (they only exist because this same pack created them via applyPack's
// manifest.children loop) — every direct child of the pack's own region is treated as owned by
// it, a deliberate simplification (see this plan's own note on the tradeoff).
// A pack with no pack_species rows at all (never backfilled, or backfilled but no longer
// present in the pack index — confirmed live: both "canada" and "st-martin" fell into this
// exact case on a real dev install) degrades to the safest possible outcome, not a partial
// one: region_species deletion below is scoped to `species_id = ANY(pack_species-derived
// list)`, so an empty list means NOTHING is deleted — checklist rows, reference photos, and
// enrichment all stay exactly as they were. Deleting such a pack only forgets the
// downloaded_packs bookkeeping row itself (so it no longer shows as "downloaded" and can be
// re-applied fresh later), never touches data it can't prove is safe to remove.
async function computeDeleteImpact(packId: string): Promise<DeleteImpact | null> {
  const packRes = await pool.query<{ region: string | null; bytes: number; applied_province_region_ids: string[] | null }>(
    `SELECT region, bytes, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
    [packId],
  );
  const packRegionName = packRes.rows[0]?.region;
  if (packRes.rows.length === 0) return null;
  const packBytes = Number(packRes.rows[0].bytes ?? 0);
  const appliedProvinceIds = packRes.rows[0].applied_province_region_ids;

  let regionIds: string[] = [];
  let seaZoneId: string | null = null;
  const checklistRegionsAffected: string[] = [];
  if (packRegionName) {
    const regionRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE name = $1`, [packRegionName]);
    if (regionRes.rows.length > 0) {
      const { id, name } = regionRes.rows[0];
      regionIds.push(id);
      checklistRegionsAffected.push(name);
      const childrenRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE parent_id = $1`, [id]);
      for (const child of childrenRes.rows) {
        // A province already offloaded on its own (Fix 8) has no region_species rows left to
        // delete here — skipping it keeps this count from double-counting a province the user
        // already removed individually before deleting the whole country pack.
        if (appliedProvinceIds && !appliedProvinceIds.includes(child.id)) continue;
        regionIds.push(child.id);
        checklistRegionsAffected.push(child.name);
      }
    } else {
      const zoneRes = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [packRegionName]);
      if (zoneRes.rows.length > 0) {
        seaZoneId = zoneRes.rows[0].id;
        checklistRegionsAffected.push(packRegionName);
      }
    }
  }

  const speciesRes = await pool.query<{ species_id: string; provided_enrichment: boolean }>(
    `SELECT species_id, provided_enrichment FROM pack_species WHERE pack_id = $1`,
    [packId],
  );

  const speciesToRemove: string[] = [];
  let speciesKeptCount = 0;
  let bytesToFree = 0;
  for (const row of speciesRes.rows) {
    if (!row.provided_enrichment) continue;
    const otherPackRes = await pool.query(`SELECT 1 FROM pack_species WHERE species_id = $1 AND pack_id != $2 LIMIT 1`, [
      row.species_id,
      packId,
    ]);
    const userHasItRes = await pool.query(`SELECT 1 FROM user_species WHERE species_id = $1 LIMIT 1`, [row.species_id]);
    if ((otherPackRes.rowCount ?? 0) > 0 || (userHasItRes.rowCount ?? 0) > 0) {
      speciesKeptCount++;
      continue;
    }
    const fileRes = await pool.query<{ reference_display_path: string | null; reference_thumb_path: string | null }>(
      `SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`,
      [row.species_id],
    );
    const paths = fileRes.rows[0];
    for (const p of [paths?.reference_display_path, paths?.reference_thumb_path]) {
      if (p && existsSync(p)) bytesToFree += statSync(p).size;
    }
    speciesToRemove.push(row.species_id);
  }

  // No pack_species rows at all (never backfilled — see this function's own comment above) —
  // fall back to the archive's own stored size rather than reporting a misleading "0 species,
  // freeing 0KB" for a pack that very much occupies real disk space.
  if (speciesRes.rows.length === 0 && packBytes > 0) {
    return {
      regionIds,
      seaZoneId,
      checklistRegionsAffected,
      speciesToRemove,
      speciesKeptCount,
      bytesToFree: packBytes,
      isEstimate: true,
    };
  }

  return { regionIds, seaZoneId, checklistRegionsAffected, speciesToRemove, speciesKeptCount, bytesToFree, isEstimate: false };
}

async function deletePack(packId: string): Promise<{ deletedSpeciesFiles: number; keptSpeciesCount: number; regions: string[] }> {
  const impact = await computeDeleteImpact(packId);
  if (!impact) throw new Error(`No downloaded pack found with id "${packId}"`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (impact.regionIds.length > 0) {
      const speciesRes = await client.query<{ species_id: string }>(`SELECT species_id FROM pack_species WHERE pack_id = $1`, [packId]);
      const allSpeciesIds = speciesRes.rows.map((r) => r.species_id);
      if (allSpeciesIds.length > 0) {
        await client.query(`DELETE FROM region_species WHERE region_id = ANY($1) AND species_id = ANY($2)`, [
          impact.regionIds,
          allSpeciesIds,
        ]);
      }
    } else if (impact.seaZoneId) {
      const speciesRes = await client.query<{ species_id: string }>(`SELECT species_id FROM pack_species WHERE pack_id = $1`, [packId]);
      const allSpeciesIds = speciesRes.rows.map((r) => r.species_id);
      if (allSpeciesIds.length > 0) {
        await client.query(`DELETE FROM sea_zone_species WHERE sea_zone_id = $1 AND species_id = ANY($2)`, [
          impact.seaZoneId,
          allSpeciesIds,
        ]);
      }
    }

    for (const speciesId of impact.speciesToRemove) {
      const fileRes = await client.query<{ reference_display_path: string | null; reference_thumb_path: string | null }>(
        `SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`,
        [speciesId],
      );
      const paths = fileRes.rows[0];
      for (const p of [paths?.reference_display_path, paths?.reference_thumb_path]) {
        if (p && existsSync(p)) rmSync(p, { force: true });
      }
      // reference_photo (the enrichment-discovered source URL, separate from the locally-cached
      // reference_display_path/reference_thumb_path files above) must be cleared alongside
      // credit/license too, or this violates reference_photo_requires_credit — confirmed live:
      // a real pack with actual enriched species (canada-mammalia, downloaded fresh for this
      // fix's own end-to-end test) hit exactly this constraint violation, since every prior
      // exercise of this code path only ever had packs with empty pack_species to delete.
      await client.query(
        `UPDATE species SET
           reference_display_path = NULL, reference_thumb_path = NULL, habitat_description = NULL,
           reference_credit = NULL, reference_license = NULL, reference_photo = NULL, enriched_at = NULL
         WHERE id = $1`,
        [speciesId],
      );
    }

    // pack_species cascades from this delete (ON DELETE CASCADE, migration 054).
    await client.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [packId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    deletedSpeciesFiles: impact.speciesToRemove.length,
    keptSpeciesCount: impact.speciesKeptCount,
    regions: impact.checklistRegionsAffected,
  };
}

// Shared by /offline-packs/index (per-pack cards) and /offline-packs/updates-summary (the
// global banner) — same downloaded/updateAvailable computation, extracted so the two never
// drift out of sync with each other.
async function computePackStatuses(): Promise<{
  generatedAt: string;
  packs: Array<PackIndexEntry & { downloaded: boolean; updateAvailable: boolean }>;
}> {
  const index = await fetchPackIndex();
  const downloadedRes = await pool.query<{ pack_id: string; content_version: string | null }>(
    `SELECT pack_id, content_version FROM downloaded_packs`,
  );
  const downloadedVersions = new Map(downloadedRes.rows.map((r) => [r.pack_id, r.content_version]));
  return {
    generatedAt: index.generatedAt,
    packs: index.packs.map((p) => {
      const downloadedVersion = downloadedVersions.get(p.id);
      return {
        ...p,
        downloaded: downloadedVersion !== undefined,
        // A pack downloaded before content_version existed (downloadedVersion === null) reads
        // as "no update available" rather than a false positive — there's no real signal to
        // compare against yet, and it'll self-correct the next time it's actually re-applied.
        updateAvailable: downloadedVersion != null && downloadedVersion !== p.contentVersion,
      };
    }),
  };
}

export async function offlinePacksRoutes(app: FastifyInstance): Promise<void> {
  app.get("/offline-packs/index", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      const statuses = await computePackStatuses();
      return {
        generatedAt: statuses.generatedAt,
        // scientificNames is left out here — this listing only ever renders pack cards, never
        // needs the per-species names, and it can be a meaningful chunk of payload for the
        // largest all-taxa country packs. /offline-packs/recommend fetches the full index
        // itself when it actually needs that field.
        packs: statuses.packs.map(({ scientificNames: _scientificNames, ...p }) => p),
      };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  // Small, cheap payload (no scientificNames, no per-pack detail beyond what a global banner
  // needs) so it's reasonable to check at app launch without waiting on the full index.
  app.get("/offline-packs/updates-summary", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      const statuses = await computePackStatuses();
      const stale = statuses.packs.filter((p) => p.updateAvailable);
      return {
        updateCount: stale.length,
        totalBytes: stale.reduce((sum, p) => sum + p.sizeBytes, 0),
        packIds: stale.map((p) => p.id),
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

  app.post<{ Body: { packIds?: string[]; force?: boolean } }>(
    "/offline-packs/download",
    { preHandler: requireAuth },
    async (request, reply) => {
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
      void runDownloadJob(packIds, request.body?.force ?? false);

      return { started: true };
    },
  );

  // Resolves a (countries × taxa) selection to a set of pack ids and starts the same download
  // job as /offline-packs/download — a convenience layer for the map-based picker (multi-select
  // countries, pick taxa once, one download action) rather than pack-id-by-pack-id. "All of
  // Europe" is handled entirely client-side (the UI expands a continent pill to every country
  // under it and sends the full regionNames list here) — no continent-level pack exists.
  app.post<{ Body: { regionNames?: string[]; taxa?: string[] | "all" } }>(
    "/offline-packs/download-batch",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (downloadJob.running) {
        return reply.code(409).send({ error: "A pack download is already in progress" });
      }
      const regionNames = request.body?.regionNames;
      const taxa = request.body?.taxa;
      if (!regionNames || regionNames.length === 0) {
        return reply.code(400).send({ error: "regionNames is required" });
      }
      try {
        const statuses = await computePackStatuses();
        const regionSet = new Set(regionNames);
        const taxaSet = taxa === "all" ? null : new Set(taxa ?? []);
        const packIds = statuses.packs
          .filter((p) => {
            const region = p.region ?? p.seaZone;
            if (!region || !regionSet.has(region)) return false;
            // A pack with no taxon (covers every taxon for its region) always matches; otherwise
            // the pack's own taxon must be one of the requested ones.
            if (taxaSet && p.taxon && !taxaSet.has(p.taxon)) return false;
            return !p.downloaded || p.updateAvailable;
          })
          .map((p) => p.id);

        if (packIds.length === 0) return { started: false, packIds: [] };

        downloadJob.running = true;
        downloadJob.processed = 0;
        downloadJob.total = packIds.length;
        downloadJob.currentPack = null;
        downloadJob.error = null;
        downloadJob.finishedAt = null;
        void runDownloadJob(packIds);

        return { started: true, packIds };
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
    },
  );

  // Read-only dry run of DELETE's own impact computation — lets the UI show a real warning
  // ("N species' photos removed, M kept because you photographed them or another pack needs
  // them") before the user commits, per the explicit ask that this be surfaced up front, not
  // just described in the abstract.
  app.get<{ Params: { packId: string } }>("/offline-packs/:packId/delete-preview", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const impact = await computeDeleteImpact(request.params.packId);
      if (!impact) return reply.code(404).send({ error: "No downloaded pack found with that id" });
      return {
        checklistRegionsAffectedCount: impact.checklistRegionsAffected.length,
        speciesToRemoveCount: impact.speciesToRemove.length,
        speciesKeptCount: impact.speciesKeptCount,
        bytesToFree: impact.bytesToFree,
        isEstimate: impact.isEstimate,
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { packId: string } }>("/offline-packs/:packId", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = await deletePack(request.params.packId);
      return result;
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // Fix 8: province-level selection within a country pack. Always downloads/applies the full
  // country archive (unchanged network behavior — no per-province artifacts exist), but lets a
  // user pick which provinces stay applied locally, offloading the rest to avoid cluttering the
  // checklist/browsing UI with dozens of unwanted provinces. `applied_province_region_ids` NULL
  // means "every province applied" (today's behavior for every existing pack).
  app.get<{ Params: { packId: string } }>("/offline-packs/:packId/provinces", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const packRes = await pool.query<{ region: string | null; applied_province_region_ids: string[] | null }>(
        `SELECT region, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
        [request.params.packId],
      );
      if (packRes.rows.length === 0) return reply.code(404).send({ error: "No downloaded pack found with that id" });
      const { region, applied_province_region_ids: appliedIds } = packRes.rows[0];
      if (!region) return { provinces: [] };
      const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [region]);
      const regionId = regionRes.rows[0]?.id;
      if (!regionId) return { provinces: [] };
      const childrenRes = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM regions WHERE parent_id = $1 ORDER BY name`,
        [regionId],
      );
      return {
        provinces: childrenRes.rows.map((c) => ({ id: c.id, name: c.name, applied: !appliedIds || appliedIds.includes(c.id) })),
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // Immediately offloads exactly these provinces (removing their region_species rows for this
  // pack's own species — never touching reference photos/pack_species, which stay owned at the
  // country level since other provinces or the country pack itself may still need them) and
  // narrows applied_province_region_ids down to whatever's left. To bring a removed province
  // back later, re-download the pack (POST /offline-packs/download restores every child
  // unconditionally, see applyPack's own children loop) then offload whichever ones should stay
  // excluded again — no separate "reapply just this one" pathway exists, matching the tradeoff
  // this feature explicitly accepted (redownloading the whole archive again is fine).
  app.post<{ Params: { packId: string }; Body: { regionIds?: string[] } }>(
    "/offline-packs/:packId/provinces/offload",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { packId } = request.params;
      const toOffload = request.body?.regionIds;
      if (!toOffload || toOffload.length === 0) return reply.code(400).send({ error: "regionIds is required" });
      try {
        const packRes = await pool.query<{ region: string | null; applied_province_region_ids: string[] | null }>(
          `SELECT region, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
          [packId],
        );
        if (packRes.rows.length === 0) return reply.code(404).send({ error: "No downloaded pack found with that id" });
        const { region, applied_province_region_ids: appliedIds } = packRes.rows[0];
        if (!region) return reply.code(400).send({ error: "This pack has no provinces" });
        const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [region]);
        const regionId = regionRes.rows[0]?.id;
        if (!regionId) return reply.code(400).send({ error: "This pack's region no longer exists" });

        const allChildrenRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE parent_id = $1`, [regionId]);
        const allChildIds = allChildrenRes.rows.map((r) => r.id);
        const currentlyApplied = appliedIds ?? allChildIds;

        const speciesRes = await pool.query<{ species_id: string }>(`SELECT species_id FROM pack_species WHERE pack_id = $1`, [packId]);
        const speciesIds = speciesRes.rows.map((r) => r.species_id);
        if (speciesIds.length > 0) {
          for (const regionIdToOffload of toOffload) {
            await pool.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2)`, [
              regionIdToOffload,
              speciesIds,
            ]);
          }
        }

        const remaining = currentlyApplied.filter((id) => !toOffload.includes(id));
        await pool.query(`UPDATE downloaded_packs SET applied_province_region_ids = $1 WHERE pack_id = $2`, [
          JSON.stringify(remaining),
          packId,
        ]);

        return { ok: true, remainingApplied: remaining.length };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  // Combined dry-run impact across several packs at once, for the offload screen's multi-select
  // — sums each pack's own computeDeleteImpact rather than trying to dedupe overlapping species
  // across packs (a species kept-or-removed determination already accounts for every OTHER
  // downloaded pack, including ones also in this same batch, since computeDeleteImpact checks
  // pack_species directly rather than assuming a single-pack context).
  app.post<{ Body: { packIds?: string[] } }>("/offline-packs/offload-preview", { preHandler: requireAuth }, async (request, reply) => {
    const packIds = request.body?.packIds;
    if (!packIds || packIds.length === 0) return reply.code(400).send({ error: "packIds is required" });
    try {
      let checklistRegionsAffectedCount = 0;
      let speciesToRemoveCount = 0;
      let speciesKeptCount = 0;
      let bytesToFree = 0;
      let isEstimate = false;
      for (const packId of packIds) {
        const impact = await computeDeleteImpact(packId);
        if (!impact) continue;
        checklistRegionsAffectedCount += impact.checklistRegionsAffected.length;
        speciesToRemoveCount += impact.speciesToRemove.length;
        speciesKeptCount += impact.speciesKeptCount;
        bytesToFree += impact.bytesToFree;
        isEstimate = isEstimate || impact.isEstimate;
      }
      return { checklistRegionsAffectedCount, speciesToRemoveCount, speciesKeptCount, bytesToFree, isEstimate };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { packIds?: string[] } }>("/offline-packs/offload-batch", { preHandler: requireAuth }, async (request, reply) => {
    const packIds = request.body?.packIds;
    if (!packIds || packIds.length === 0) return reply.code(400).send({ error: "packIds is required" });
    try {
      let deletedSpeciesFiles = 0;
      let keptSpeciesCount = 0;
      const regions: string[] = [];
      for (const packId of packIds) {
        const result = await deletePack(packId);
        deletedSpeciesFiles += result.deletedSpeciesFiles;
        keptSpeciesCount += result.keptSpeciesCount;
        regions.push(...result.regions);
      }
      return { deletedSpeciesFiles, keptSpeciesCount, regions };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
