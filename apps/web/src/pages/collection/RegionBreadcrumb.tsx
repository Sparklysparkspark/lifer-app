import { useState } from "react";
import { Link } from "react-router-dom";
import type { RegionSpeciesResult, RegionStats, RegionSummary } from "@lifer/shared";
import { api } from "../../api/client";
import ProgressBar from "../../components/ProgressBar";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";

// The main-screen drill-down: no region means everything collected worldwide; picking one
// narrows the same grid to that region's checklist.
export default function RegionBreadcrumb({
  regionId,
  worldRegion,
  downloadedCountries,
  breadcrumb,
  navigateToRegion,
  regionMeta,
  regionStats,
  regionKnownHub,
  hubStats,
  showEbirdLink,
  mapToggle,
  childRegions: children,
  allChildren,
  availableRegionIds,
  onDrilledDown,
}: {
  regionId: string | null;
  worldRegion: RegionSummary | undefined;
  downloadedCountries: RegionSummary[];
  breadcrumb: RegionSummary[];
  navigateToRegion: (id: string | null) => void;
  regionMeta: RegionSpeciesResult["region"] | null;
  regionStats: RegionStats | null;
  regionKnownHub: boolean;
  hubStats: RegionStats | null;
  showEbirdLink: boolean;
  mapToggle: { collapsed: boolean; onToggle: () => void } | null;
  childRegions: RegionSummary[];
  allChildren: RegionSummary[];
  availableRegionIds: Set<string> | null;
  onDrilledDown: () => void;
}) {
  const [drillingDown, setDrillingDown] = useState(false);
  const toast = useToast();

  async function drillDown() {
    if (!regionId) return;
    setDrillingDown(true);
    try {
      await api.post(`/regions/${regionId}/drill-down`, {});
      onDrilledDown();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't load provinces and states. Try again."));
    } finally {
      setDrillingDown(false);
    }
  }

  if (!regionId) {
    if (!worldRegion) return <div className="border-b border-line bg-surface px-6 py-2" />;
    return (
      <div className="border-b border-line bg-surface px-6 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <button onClick={() => navigateToRegion(worldRegion.id)} className="hover:underline">
            Browse by region →
          </button>
          {/* Downloaded countries one click away, instead of World, continent, country. */}
          {downloadedCountries.map((c) => (
            <button key={c.id} onClick={() => navigateToRegion(c.id)} className="text-ink hover:underline">
              {c.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const canDrillDown = !!regionMeta?.canDrillDown && !regionMeta.hasChildren;

  return (
    <div className="border-b border-line bg-surface px-6 py-2">
      <div className="space-y-2">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <button onClick={() => navigateToRegion(null)} className="hover:underline">
            All species
          </button>
          {breadcrumb.map((r, i) => (
            <span key={r.id} className="flex items-center gap-1">
              <span className="text-muted">/</span>
              {i === breadcrumb.length - 1 ? (
                <span className="font-medium text-ink">{r.name}</span>
              ) : (
                <button onClick={() => navigateToRegion(r.id)} className="hover:underline">
                  {r.name}
                </button>
              )}
            </span>
          ))}
          {mapToggle && (
            <button onClick={mapToggle.onToggle} className="ml-2 text-xs hover:underline">
              {mapToggle.collapsed ? "▸ Show map" : "▾ Hide map"}
            </button>
          )}
        </nav>
        {regionMeta && regionStats && !regionKnownHub && (
          <div className="flex items-center gap-3">
            <ProgressBar
              size="sm"
              determinate
              value={regionStats.total ? regionStats.collected / regionStats.total : 0}
              label="Collected in this region"
              className="w-40"
            />
            <p className="text-xs text-muted">
              {regionStats.collected} collected · {regionStats.seen} seen · {regionStats.total} total
            </p>
            {regionMeta.ebirdRegionCode && showEbirdLink && (
              <a
                href={`https://ebird.org/region/${regionMeta.ebirdRegionCode}/illustrated-checklist`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted hover:underline"
              >
                eBird Illustrated Checklist ↗
              </a>
            )}
          </div>
        )}
        {regionKnownHub && hubStats && (
          <div className="flex items-center gap-3">
            <ProgressBar
              size="sm"
              determinate
              value={hubStats.total ? hubStats.collected / hubStats.total : 0}
              label="Collected in downloaded countries"
              className="w-40"
            />
            <p className="text-xs text-muted">
              {hubStats.collected} collected · {hubStats.seen} seen · {hubStats.total} total{" "}
              <span title="Only counts checklists for countries you've downloaded, not every species in this region.">
                (downloaded countries only)
              </span>
            </p>
          </div>
        )}
        {(children.length > 0 || canDrillDown) && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-muted">Drill in:</span>
            {children.map((child) => (
              <button
                key={child.id}
                onClick={() => navigateToRegion(child.id)}
                className="rounded-md border border-line px-3 py-1 text-sm text-ink hover:bg-surface-muted"
              >
                {child.name}
              </button>
            ))}
            {canDrillDown && (
              <button
                onClick={drillDown}
                disabled={drillingDown}
                className="rounded-md border border-line px-3 py-1 text-sm text-muted hover:bg-surface-muted disabled:opacity-50"
              >
                {drillingDown ? "Loading provinces/states…" : "Show provinces/states"}
              </button>
            )}
          </div>
        )}
        {availableRegionIds && allChildren.length > 0 && children.length === 0 && (
          <p className="text-xs text-muted">
            None of this region's countries have a downloaded pack yet.{" "}
            <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
              Download one in Offline packs
            </Link>{" "}
            to see it here.
          </p>
        )}
      </div>
    </div>
  );
}
