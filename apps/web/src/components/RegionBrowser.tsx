import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { RegionSummary } from "@lifer/shared";
import { api } from "../api/client";
import { useRegions } from "../hooks/useRegions";
import RegionPicker from "./RegionPicker";

const NO_REGIONS: RegionSummary[] = [];

// The collection's breadcrumb and drill-in picking, limited to regions reachable from a downloaded
// country pack. allowAnyRegion lifts that restriction.
export default function RegionBrowser({
  regionId,
  onChange,
  allowAnyRegion,
  restrictToIds,
}: {
  regionId: string | null;
  onChange: (id: string | null) => void;
  allowAnyRegion?: boolean;
  /** Overrides which regions are pickable (e.g. Gallery: only regions with photos). Use with
   *  allowAnyRegion so it replaces the pack restriction instead of intersecting it. */
  restrictToIds?: Set<string> | null;
}) {
  const { regions, error: regionsError, refresh: refreshRegions } = useRegions();
  const allRegions = regions ?? NO_REGIONS;
  const [downloadedCountryNames, setDownloadedCountryNames] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (allowAnyRegion) return;
    api
      .get<{ packs: Array<{ type: string; region: string | null; downloaded: boolean }> }>("/offline-packs/index")
      .then((res) => {
        setDownloadedCountryNames(
          new Set(res.packs.filter((p) => p.type === "region" && p.region && p.downloaded).map((p) => p.region!)),
        );
      })
      .catch(() => setDownloadedCountryNames(new Set()));
  }, [allowAnyRegion]);

  // Same as the collection's: a downloaded country, its ancestors up to World, and every
  // descendant bundled in its pack.
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
  }, [allRegions, downloadedCountryNames, restrictToIds, allowAnyRegion]);

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

  // A stored regionId that no longer resolves (an offloaded pack, a fresh database with new ids)
  // falls back to nothing, or to the only downloaded country when there's exactly one.
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

  if (!regions && regionsError) {
    return (
      <p className="text-sm text-muted">
        Couldn't load the region list.{" "}
        <button type="button" onClick={() => void refreshRegions().catch(() => {})} className="text-ink underline">
          Try again
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {noPacks ? (
        <p className="text-sm text-muted">
          No region pack is downloaded yet.{" "}
          <Link to="/offline-packs" className="text-ink underline">
            Download one in Offline packs
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
