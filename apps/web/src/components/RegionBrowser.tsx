import { useEffect, useMemo, useState } from "react";
import type { RegionSummary } from "@lifer/shared";
import { api } from "../api/client";

// Same breadcrumb + "drill in" pill interaction as CollectionPage's own region picker, filtered
// to the same availableRegionIds set (only regions reachable from an actually-downloaded
// country pack) — extracted here so a second, lighter-weight caller (species auto-suggest's
// region step, see PhotoImportRows) can reuse the exact picking behavior a user already knows
// from Collection, rather than a second bespoke region UI that behaves differently. Deliberately
// leaves out CollectionPage-specific pieces (checklist stats bar, sea zones, eBird link,
// drill-down-into-provinces action) that have nothing to do with just picking a region.
export default function RegionBrowser({ regionId, onChange }: { regionId: string | null; onChange: (id: string | null) => void }) {
  const [allRegions, setAllRegions] = useState<RegionSummary[]>([]);
  const [downloadedCountryNames, setDownloadedCountryNames] = useState<Set<string> | null>(null);

  useEffect(() => {
    api.get<{ regions: RegionSummary[] }>("/regions").then((res) => setAllRegions(res.regions));
  }, []);

  useEffect(() => {
    api
      .get<{ packs: Array<{ type: string; region: string | null; downloaded: boolean }> }>("/offline-packs/index")
      .then((res) => {
        setDownloadedCountryNames(new Set(res.packs.filter((p) => p.type === "region" && p.region && p.downloaded).map((p) => p.region!)));
      })
      .catch(() => setDownloadedCountryNames(new Set()));
  }, []);

  // Identical algorithm to CollectionPage's own availableRegionIds: a downloaded country, every
  // ancestor up to World (so the path TO it stays clickable), and every descendant province/state
  // bundled in the same pack.
  const availableRegionIds = useMemo(() => {
    if (!downloadedCountryNames) return null;
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
  }, [allRegions, downloadedCountryNames]);

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
  useEffect(() => {
    if (!regionId || !allRegions.length || !availableRegionIds) return;
    if (!availableRegionIds.has(regionId)) onChange(null);
  }, [regionId, allRegions, availableRegionIds, onChange]);

  return (
    <div className="space-y-2">
      {!regionId ? (
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
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => onChange(child.id)}
              className="rounded-full border border-line px-3 py-1 text-sm text-ink hover:bg-surface-muted"
            >
              {child.name}
            </button>
          ))}
        </div>
      )}
      {regionId && availableRegionIds && allChildren.length > 0 && children.length === 0 && (
        <p className="text-xs text-muted">None of this region's countries have a downloaded pack yet.</p>
      )}
    </div>
  );
}
