import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { RegionSummary } from "@lifer/shared";
import { api } from "../api/client";
import RegionPicker from "./RegionPicker";

// Same breadcrumb + "drill in" pill interaction as CollectionPage's own region picker, filtered
// to the same availableRegionIds set (only regions reachable from an actually-downloaded
// country pack) — extracted here so a second, lighter-weight caller (species auto-suggest's
// region step, see PhotoImportRows) can reuse the exact picking behavior a user already knows
// from Collection, rather than a second bespoke region UI that behaves differently. Deliberately
// leaves out CollectionPage-specific pieces (checklist stats bar, sea zones, eBird link,
// drill-down-into-provinces action) that have nothing to do with just picking a region.
//
// allowAnyRegion skips the downloaded-pack restriction entirely — used by AddOtherTaxaModal,
// where the whole point is adding a species to a region without needing a species pack for it
// (there's no "checklist" concept being downloaded, just one iNat species dropped onto one
// region), so gating region choice on pack downloads would defeat the feature.
export default function RegionBrowser({
  regionId,
  onChange,
  allowAnyRegion,
  restrictToIds,
}: {
  regionId: string | null;
  onChange: (id: string | null) => void;
  allowAnyRegion?: boolean;
  /** A caller-supplied override for which regions are pickable, independent of the downloaded-
   *  pack restriction — e.g. Gallery's own region filter, which should only ever offer regions
   *  the user's library actually has photos tagged in, not "has a pack downloaded for." Only
   *  meaningful together with allowAnyRegion (skips the pack-based restriction so this one wins
   *  outright instead of being intersected with it). */
  restrictToIds?: Set<string> | null;
}) {
  const [allRegions, setAllRegions] = useState<RegionSummary[]>([]);
  const [downloadedCountryNames, setDownloadedCountryNames] = useState<Set<string> | null>(null);

  useEffect(() => {
    api.get<{ regions: RegionSummary[] }>("/regions").then((res) => setAllRegions(res.regions));
  }, []);

  useEffect(() => {
    if (allowAnyRegion) return;
    api
      .get<{ packs: Array<{ type: string; region: string | null; downloaded: boolean }> }>("/offline-packs/index")
      .then((res) => {
        setDownloadedCountryNames(new Set(res.packs.filter((p) => p.type === "region" && p.region && p.downloaded).map((p) => p.region!)));
      })
      .catch(() => setDownloadedCountryNames(new Set()));
  }, [allowAnyRegion]);

  // Identical algorithm to CollectionPage's own availableRegionIds: a downloaded country, every
  // ancestor up to World (so the path TO it stays clickable), and every descendant province/state
  // bundled in the same pack.
  const availableRegionIds = useMemo(() => {
    if (restrictToIds) return restrictToIds;
    if (allowAnyRegion || !downloadedCountryNames) return null;
    const byId = new Map(allRegions.map((r) => [r.id, r]));
    const childrenOf = new Map<string, RegionSummary[]>();
    for (const r of allRegions) {
      if (r.parentId == null) continue;
      if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
      childrenOf.get(r.parentId)!.push(r);
    }
    const available = new Set<string>();
    for (const region of allRegions) {
      if (!downloadedCountryNames.has(region.name)) continue;
      available.add(region.id);
      let cursor: RegionSummary | undefined = region;
      while (cursor?.parentId) {
        available.add(cursor.parentId);
        cursor = byId.get(cursor.parentId);
      }
      const stack = [...(childrenOf.get(region.id) ?? [])];
      while (stack.length) {
        const child = stack.pop()!;
        available.add(child.id);
        stack.push(...(childrenOf.get(child.id) ?? []));
      }
    }
    return available;
  }, [allRegions, downloadedCountryNames, restrictToIds]);

  const worldRegion = useMemo(() => allRegions.find((r) => r.parentId === null && r.name === "World"), [allRegions]);
  const allChildren = useMemo(() => allRegions.filter((r) => r.parentId === regionId), [allRegions, regionId]);
  const children = useMemo(
    () => (availableRegionIds ? allChildren.filter((r) => availableRegionIds.has(r.id)) : allChildren),
    [allChildren, availableRegionIds],
  );
  const breadcrumb = useMemo(() => {
    const byId = new Map(allRegions.map((r) => [r.id, r]));
    const trail: RegionSummary[] = [];
    let node = regionId ? byId.get(regionId) : undefined;
    while (node) {
      trail.unshift(node);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return trail;
  }, [allRegions, regionId]);

  // A stored regionId (e.g. restored from localStorage) that no longer resolves to a real,
  // still-downloaded region — an offloaded pack, or corrupted-territory cleanup removing a row
  // — must fall back to World rather than silently rendering an empty/broken breadcrumb.
  //
  // With exactly one country pack, that country is picked instead of nothing, the same as the
  // collection page: region ids differ per install, so after a fresh database the remembered
  // one never resolves, and the import screen came back with no region and no explanation.
  const onlyCountryId = useMemo(() => {
    if (restrictToIds || allowAnyRegion || !downloadedCountryNames || downloadedCountryNames.size !== 1) return null;
    const onlyName = [...downloadedCountryNames][0];
    return allRegions.find((r) => r.name === onlyName && availableRegionIds?.has(r.id))?.id ?? null;
  }, [restrictToIds, allowAnyRegion, downloadedCountryNames, allRegions, availableRegionIds]);
  useEffect(() => {
    if (!allRegions.length || !availableRegionIds) return;
    if (regionId && availableRegionIds.has(regionId)) return;
    const next = onlyCountryId;
    if (next !== regionId) onChange(next);
  }, [regionId, allRegions, availableRegionIds, onlyCountryId, onChange]);
  const noPacks = !restrictToIds && !allowAnyRegion && downloadedCountryNames?.size === 0;

  return (
    <div className="space-y-2">
      {noPacks ? (
        <p className="text-sm text-muted">
          No region pack is downloaded yet.{" "}
          <Link to="/offline-packs" className="text-ink underline">
            Download one in Offline Packs
          </Link>{" "}
          to pick a region.
        </p>
      ) : !regionId ? (
        worldRegion && (
          <button type="button" onClick={() => onChange(worldRegion.id)} className="text-sm text-muted hover:underline">
            Browse by region →
          </button>
        )
      ) : (
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <button type="button" onClick={() => onChange(null)} className="hover:underline">
            All regions
          </button>
          {breadcrumb.map((r, i) => (
            <span key={r.id} className="flex items-center gap-1">
              <span className="text-muted">/</span>
              {i === breadcrumb.length - 1 ? (
                <span className="font-medium text-ink">{r.name}</span>
              ) : (
                <button type="button" onClick={() => onChange(r.id)} className="hover:underline">
                  {r.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}
      {regionId && children.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted">Drill in:</span>
          <RegionPicker mode="single" items={children} selectedId={null} onSelectItem={onChange} />
        </div>
      )}
      {regionId && availableRegionIds && allChildren.length > 0 && children.length === 0 && (
        <p className="text-xs text-muted">None of this region's countries have a downloaded pack yet.</p>
      )}
    </div>
  );
}
