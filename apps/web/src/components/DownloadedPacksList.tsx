import { useEffect, useRef, useState } from "react";
import type { TaxonClass } from "@lifer/shared";
import { TAXON_CLASS_LABEL } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { usePackDownloadStatus } from "../hooks/usePackDownloadStatus";
import Pill from "./Pill";

export interface PackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: TaxonClass | null;
  // "small" ships the same checklist/embeddings but skips the reference-photo gallery. Absent
  // means "full" (every pack built before this variant existed).
  variant?: "full" | "small";
  sizeBytes: number;
  speciesCount: number;
  downloaded: boolean;
  updateAvailable: boolean;
  seaZoneDependencies?: string[];
  photoBytes?: number;
  checklistBytes?: number;
}

export interface DeletePreview {
  checklistRegionsAffectedCount: number;
  speciesToRemoveCount: number;
  speciesKeptCount: number;
  bytesToFree: number;
  isEstimate: boolean;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Same "a country's own pack, plus whichever sea-zone packs it depends on, grouped together"
// logic OfflinePacksPage's own downloadedGroups used to build inline — a sea zone's "owner" is
// whichever downloaded country pack listed it as a dependency (falling back to its own name
// when nothing claims it, e.g. a sea zone downloaded on its own). Keyed by pack ID, not zone
// name — a zone can have several packs now (one per taxon), so a country's dependency has to
// point at the SPECIFIC one it needs, not just "this zone" generically.
function groupPacks(packs: PackEntry[]): [string, { main: PackEntry[]; seaZones: PackEntry[] }][] {
  const seaZoneOwner = new Map<string, string>();
  for (const p of packs) {
    if (p.type === "region" && p.seaZoneDependencies) {
      for (const depId of p.seaZoneDependencies) seaZoneOwner.set(depId, p.region ?? "");
    }
  }
  const groups = new Map<string, { main: PackEntry[]; seaZones: PackEntry[] }>();
  for (const p of packs) {
    const groupName = p.type === "seaZone" ? (seaZoneOwner.get(p.id) ?? p.seaZone ?? "") : (p.region ?? "");
    if (!groups.has(groupName)) groups.set(groupName, { main: [], seaZones: [] });
    if (p.type === "seaZone") groups.get(groupName)!.seaZones.push(p);
    else groups.get(groupName)!.main.push(p);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// A sea-zone dependent pack that's no longer needed once its owning country pack(s) are
// offloaded — i.e. no OTHER currently-downloaded region pack still lists it as a dependency
// after `targets` are removed. Only these get silently folded into an offload; a dependent
// still needed by some other downloaded country pack is left completely alone.
// The full/small counterpart of the same region (or sea zone) + taxon, if the catalog has one -
// used to offer "get the full version" on a small pack's row and vice versa. Matched on identity
// (region/seaZone/taxon), not on id, since full and small ids differ only by the ".small" suffix.
function siblingVariantPack(p: PackEntry, allPacks: PackEntry[]): PackEntry | undefined {
  const wantVariant = (p.variant ?? "full") === "small" ? "full" : "small";
  return allPacks.find(
    (o) => o.type === p.type && o.region === p.region && o.seaZone === p.seaZone && o.taxon === p.taxon && (o.variant ?? "full") === wantVariant,
  );
}

function orphanedSeaZoneDependents(allPacks: PackEntry[], targets: PackEntry[]): PackEntry[] {
  const targetIds = new Set(targets.map((t) => t.id));
  const survivingDependencyIds = new Set(
    allPacks.filter((p) => p.type === "region" && !targetIds.has(p.id)).flatMap((p) => p.seaZoneDependencies ?? []),
  );
  const orphaned: PackEntry[] = [];
  for (const t of targets) {
    if (t.type !== "region" || !t.seaZoneDependencies) continue;
    for (const depId of t.seaZoneDependencies) {
      if (targetIds.has(depId) || survivingDependencyIds.has(depId) || orphaned.some((o) => o.id === depId)) continue;
      const dep = allPacks.find((p) => p.id === depId);
      if (dep) orphaned.push(dep);
    }
  }
  return orphaned;
}

// Shared "what's downloaded, and can I fix it from here" list — used by both the full Offline
// Packs page and Settings > Offline Data's summary, so a future style/behavior tweak (grouping,
// the offload preview copy, etc.) happens once instead of drifting between two hand-rolled
// copies. `packs` and `onRefresh` are owned by the caller (each page already fetches/polls its
// own pack index for other reasons, e.g. map coloring), everything else — selection,
// expand/collapse, the update/offload actions themselves — lives here.
export default function DownloadedPacksList({
  packs,
  onRefresh,
  renderPackExtra,
  renderPackPanel,
}: {
  packs: PackEntry[];
  onRefresh: () => void;
  /** Lets a caller bolt on a per-pack action the shared list itself doesn't know about (e.g.
   *  OfflinePacksPage's province drill-down) without threading that whole feature through here. */
  renderPackExtra?: (pack: PackEntry) => React.ReactNode;
  /** A block rendered below a pack's own row (e.g. that same province drill-down's actual
   *  expanded list) — separate from renderPackExtra since it needs to sit outside the row's own
   *  flex layout, not inline within it. */
  renderPackPanel?: (pack: PackEntry) => React.ReactNode;
}) {
  const downloadedPacks = packs.filter((p) => p.downloaded);
  const groups = groupPacks(downloadedPacks);
  const [upgradingIds, setUpgradingIds] = useState<Set<string>>(new Set());

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupTab, setGroupTab] = useState<Map<string, "main" | "seaZones">>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [offloadTargets, setOffloadTargets] = useState<PackEntry[] | null>(null);
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server-truth job status, not local state — so a bulk/per-pack update started before this
  // component mounted (or before the user left and came back to Settings/Offline Packs) still
  // shows its real spinner/progress here instead of resetting to "not updating" on every mount.
  const downloadStatus = usePackDownloadStatus();
  const jobPackIds = new Set(downloadStatus?.running ? downloadStatus.packIds : []);
  const updatingIds = jobPackIds;
  const bulkUpdating = downloadStatus?.running === true && downloadStatus.packIds.length > 1;
  const bulkProgress = downloadStatus?.running ? { processed: downloadStatus.processed, total: downloadStatus.total } : null;

  // Refresh the pack list the moment a job we can see finishes (running -> not running),
  // rather than only right after the specific click that started it — this is what makes an
  // update started from elsewhere (or from before this component even mounted) resolve into an
  // updated list here instead of leaving a stale "update available" row.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (downloadStatus === null) return;
    if (wasRunning.current && !downloadStatus.running) {
      if (downloadStatus.error) setError(downloadStatus.error);
      onRefresh();
    }
    wasRunning.current = downloadStatus.running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadStatus?.running]);

  function toggleGroupCollapsed(name: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function updatePacks(packIds: string[]) {
    setError(null);
    try {
      // Only starts the background job — usePackDownloadStatus's poll (above) picks up its
      // progress and triggers onRefresh once it finishes, so there's nothing further to await
      // here. That's also what keeps this reflecting reality if the user navigates away and
      // back while it's still running, instead of a local "done" state that unmounts with them.
      await api.post("/offline-packs/download", { packIds });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't start the update");
    }
  }

  // Downloads the full-variant counterpart of an already-downloaded small pack, then offloads
  // the small one - the full pack's own applyChecklist already covers every species the small
  // one did (plus the reference gallery it was missing), so keeping both downloaded_packs rows
  // around afterward would just be confusing dead bookkeeping, not extra real coverage.
  async function upgradeToFull(smallPack: PackEntry, fullPack: PackEntry) {
    setError(null);
    setUpgradingIds((prev) => new Set([...prev, smallPack.id]));
    try {
      await api.post("/offline-packs/download", { packIds: [fullPack.id] });
      for (;;) {
        const status = await api.get<{ running: boolean; error: string | null }>("/offline-packs/download/status");
        if (!status.running) {
          if (status.error) throw new Error(status.error);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      await api.post("/offline-packs/offload-batch", { packIds: [smallPack.id] });
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't get the full version");
    } finally {
      setUpgradingIds((prev) => {
        const next = new Set(prev);
        next.delete(smallPack.id);
        return next;
      });
    }
  }

  async function openOffloadConfirm(targets: PackEntry[]) {
    setOffloadTargets(targets);
    setDeletePreview(null);
    setDeleteError(null);
    try {
      const preview = await api.post<DeletePreview>("/offline-packs/offload-preview", { packIds: targets.map((p) => p.id) });
      setDeletePreview(preview);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't check what offloading this would affect");
    }
  }

  async function confirmOffload() {
    if (!offloadTargets) return;
    setDeleting(true);
    try {
      await api.post("/offline-packs/offload-batch", { packIds: offloadTargets.map((p) => p.id) });
      setOffloadTargets(null);
      setDeletePreview(null);
      setSelectedIds(new Set());
      onRefresh();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't remove these packs");
    } finally {
      setDeleting(false);
    }
  }

  if (downloadedPacks.length === 0) return null;

  function renderPackRow(p: PackEntry) {
    const fullSibling = p.variant === "small" ? siblingVariantPack(p, packs) : undefined;
    const upgrading = upgradingIds.has(p.id);
    return (
      <div className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelection(p.id)} className="h-4 w-4" />
        <span className="flex-1 text-ink">
          {p.type === "seaZone"
            ? `${p.seaZone}${p.taxon ? ` (${TAXON_CLASS_LABEL[p.taxon]})` : ""}`
            : p.taxon
              ? TAXON_CLASS_LABEL[p.taxon]
              : "All taxa"}
          {p.variant === "small" && (
            <span
              className="ml-2 text-xs text-muted"
              title="Small pack: only the single featured photo per species. Extra reference photos load on demand when you're online."
            >
              small
            </span>
          )}
          {p.updateAvailable && <span className="ml-2 text-xs text-accent">update available</span>}
        </span>
        <span
          className="text-xs text-muted"
          title={
            p.photoBytes != null && p.checklistBytes != null
              ? `~${formatBytes(p.photoBytes)} photos, ~${formatBytes(p.checklistBytes)} checklist (uncompressed estimate)`
              : undefined
          }
        >
          {formatBytes(p.sizeBytes)}
        </span>
        {fullSibling && !fullSibling.downloaded && (
          <button
            type="button"
            disabled={upgrading}
            onClick={() => upgradeToFull(p, fullSibling)}
            title="Downloads the full reference gallery for every species in this pack, then removes the small version."
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
          >
            {upgrading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink/30 border-t-ink" />}
            {upgrading ? "Getting full version…" : `Get full version (${formatBytes(fullSibling.sizeBytes)})`}
          </button>
        )}
        {p.updateAvailable && (
          <button
            type="button"
            disabled={updatingIds.has(p.id)}
            onClick={() => updatePacks([p.id])}
            className="flex items-center gap-1.5 rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent hover:bg-surface-muted disabled:opacity-50"
          >
            {updatingIds.has(p.id) && <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />}
            {updatingIds.has(p.id) ? "Updating…" : "Update"}
          </button>
        )}
        {renderPackExtra?.(p)}
        <button
          type="button"
          onClick={() => openOffloadConfirm([p, ...orphanedSeaZoneDependents(downloadedPacks, [p])])}
          className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
        >
          Offload
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Downloaded</p>
        <div className="flex gap-2">
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() => setExpandedGroups(expandedGroups.size === groups.length ? new Set() : new Set(groups.map(([name]) => name)))}
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              {expandedGroups.size === groups.length ? "Collapse all" : "Expand all"}
            </button>
          )}
          {downloadedPacks.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setSelectedIds(downloadedPacks.every((p) => selectedIds.has(p.id)) ? new Set() : new Set(downloadedPacks.map((p) => p.id)))
              }
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              {downloadedPacks.every((p) => selectedIds.has(p.id)) ? "Deselect all" : "Select all"}
            </button>
          )}
          {downloadedPacks.some((p) => p.updateAvailable) && (
            <button
              type="button"
              disabled={bulkUpdating}
              onClick={() => updatePacks(downloadedPacks.filter((p) => p.updateAvailable).map((p) => p.id))}
              className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
            >
              {bulkUpdating && <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />}
              {bulkUpdating
                ? bulkProgress && bulkProgress.total > 0
                  ? `Updating ${bulkProgress.processed}/${bulkProgress.total}…`
                  : "Updating…"
                : "Update all"}
            </button>
          )}
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => {
                const targets = downloadedPacks.filter((p) => selectedIds.has(p.id));
                openOffloadConfirm([...targets, ...orphanedSeaZoneDependents(downloadedPacks, targets)]);
              }}
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              Offload selected ({selectedIds.size})
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-2 divide-y divide-line">
        {groups.map(([groupName, { main, seaZones }]) => {
          const allPacks = [...main, ...seaZones];
          const groupIds = allPacks.map((p) => p.id);
          const groupSelected = groupIds.every((id) => selectedIds.has(id));
          const groupBytes = allPacks.reduce((sum, p) => sum + p.sizeBytes, 0);
          const collapsed = !expandedGroups.has(groupName);
          const hasBothTabs = main.length > 0 && seaZones.length > 0;
          const activeTab = groupTab.get(groupName) ?? (main.length > 0 ? "main" : "seaZones");
          const activePacks = activeTab === "seaZones" ? seaZones : main;
          // A standalone sea zone pack downloaded on its own (no country claims it as a
          // dependency) groups under its own name — expanding it just reveals one item named
          // the exact same thing, a pointless extra click to see nothing new. Render it as a
          // single flat row instead of a group with a redundant one-item sub-list.
          const isTrivialSelfGroup = allPacks.length === 1 && allPacks[0].type === "seaZone" && allPacks[0].seaZone === groupName;
          if (isTrivialSelfGroup) {
            const p = allPacks[0];
            return (
              <div key={groupName} className="py-1.5">
                {renderPackRow(p)}
                {renderPackPanel?.(p)}
              </div>
            );
          }
          return (
            <div key={groupName} className="py-2">
              <div className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={groupSelected}
                  onChange={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      for (const id of groupIds) {
                        if (groupSelected) next.delete(id);
                        else next.add(id);
                      }
                      return next;
                    })
                  }
                  className="h-4 w-4"
                />
                <button type="button" onClick={() => toggleGroupCollapsed(groupName)} className="flex flex-1 items-center justify-between text-left text-ink">
                  <span>
                    {groupName} <span className="text-xs text-muted">({allPacks.length} pack{allPacks.length === 1 ? "" : "s"})</span>
                  </span>
                  <span className="text-xs text-muted">
                    {formatBytes(groupBytes)} {collapsed ? "▸" : "▾"}
                  </span>
                </button>
              </div>
              {!collapsed && hasBothTabs && (
                <div className="mt-1.5 ml-6 flex gap-1">
                  <Pill size="sm" active={activeTab === "main"} onClick={() => setGroupTab(new Map(groupTab).set(groupName, "main"))}>
                    Packs ({main.length})
                  </Pill>
                  <Pill size="sm" active={activeTab === "seaZones"} onClick={() => setGroupTab(new Map(groupTab).set(groupName, "seaZones"))}>
                    Sea zones ({seaZones.length})
                  </Pill>
                </div>
              )}
              {!collapsed && activePacks.length > 1 && (
                <div className="mt-1.5 ml-6">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        const activeIds = activePacks.map((p) => p.id);
                        const allActiveSelected = activeIds.every((id) => next.has(id));
                        for (const id of activeIds) {
                          if (allActiveSelected) next.delete(id);
                          else next.add(id);
                        }
                        return next;
                      })
                    }
                    className="text-xs text-muted hover:underline"
                  >
                    {activePacks.every((p) => selectedIds.has(p.id)) ? "Deselect all" : "Select all"}
                  </button>
                </div>
              )}
              {!collapsed && (
                <ul className="mt-1 ml-6 divide-y divide-line">
                  {activePacks.map((p) => (
                    <li key={p.id} className="py-1.5">
                      {renderPackRow(p)}
                      {renderPackPanel?.(p)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {offloadTargets && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOffloadTargets(null)}>
          <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-ink">
              {offloadTargets.length === 1 ? (
                <>
                  Offload {offloadTargets[0].region ?? offloadTargets[0].seaZone}
                  {offloadTargets[0].taxon ? ` (${TAXON_CLASS_LABEL[offloadTargets[0].taxon]})` : ""}?
                </>
              ) : (
                <>Offload {offloadTargets.length} selected packs?</>
              )}
            </p>
            {!deletePreview && !deleteError && <p className="mt-3 text-sm text-muted">Checking what this would affect…</p>}
            {deletePreview && (
              <div className="mt-3 space-y-2 text-sm text-muted">
                <p>
                  {deletePreview.isEstimate ? (
                    <>This pack takes up about {formatBytes(deletePreview.bytesToFree)}. Offloading it will free that space.</>
                  ) : (
                    <>
                      {deletePreview.speciesToRemoveCount} species' reference photos would be removed, freeing{" "}
                      {formatBytes(deletePreview.bytesToFree)}.
                    </>
                  )}
                </p>
                {deletePreview.speciesKeptCount > 0 && (
                  <p>
                    {deletePreview.speciesKeptCount} species would keep their photos: you've photographed them yourself, or another
                    downloaded pack still covers them.
                  </p>
                )}
                {deletePreview.checklistRegionsAffectedCount > 0 && (
                  <p>
                    {deletePreview.checklistRegionsAffectedCount === 1
                      ? "1 region's checklist (including this one)"
                      : `${deletePreview.checklistRegionsAffectedCount} regions' checklists (including this one)`}{" "}
                    would go back to being unavailable until re-downloaded.
                  </p>
                )}
                <p className="text-xs text-muted">
                  This only affects downloaded reference photos and checklist data. Your own captures and Gallery photos are never
                  touched.
                </p>
              </div>
            )}
            {deleteError && <p className="mt-3 text-sm text-red-600">{deleteError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOffloadTargets(null)}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmOffload}
                disabled={!deletePreview || deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Offloading…" : "Offload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
