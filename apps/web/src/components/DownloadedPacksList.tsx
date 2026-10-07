import { useState } from "react";
import type { TaxonClass } from "@lifer/shared";
import { TAXON_CLASS_LABEL } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { usePackDownloadJob, packProgressDetail, PACK_DOWNLOAD_PHASES } from "../hooks/usePackDownloadStatus";
import { formatBytes } from "../lib/format";
import { errorMessage } from "../lib/errorMessage";
import { nextPackDownloadFinish } from "../lib/waitForPackDownload";
import { useTranslation } from "react-i18next";
import JobProgress from "./JobProgress";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import Pill from "./Pill";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";
import InlineSpinner from "./InlineSpinner";

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

// A country's packs grouped with the sea-zone packs it depends on. Keyed by pack id, since a zone
// can have a pack per taxon.
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

// The full/small counterpart of the same region (or zone) and taxon, matched on identity.
function siblingVariantPack(p: PackEntry, allPacks: PackEntry[]): PackEntry | undefined {
  const wantVariant = (p.variant ?? "full") === "small" ? "full" : "small";
  return allPacks.find(
    (o) =>
      o.type === p.type &&
      o.region === p.region &&
      o.seaZone === p.seaZone &&
      o.taxon === p.taxon &&
      (o.variant ?? "full") === wantVariant,
  );
}

// Sea-zone packs no other remaining country pack depends on once `targets` are offloaded; only
// these are folded into the offload.
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

// The shared "what's downloaded" list for Offline packs and Settings > Offline Data. The caller
// owns `packs` and `onRefresh`; selection, grouping, update and offload live here.
export default function DownloadedPacksList({
  packs,
  onRefresh,
  renderPackExtra,
  renderPackPanel,
  showJobProgress = true,
}: {
  packs: PackEntry[];
  onRefresh: () => void;
  /** An extra per-pack action (e.g. the province manager). */
  renderPackExtra?: (pack: PackEntry) => React.ReactNode;
  /** A block below a pack's row, outside its flex layout. */
  renderPackPanel?: (pack: PackEntry) => React.ReactNode;
  /** false when the page already shows its own pack-download progress (Offline Packs). */
  showJobProgress?: boolean;
}) {
  const { t } = useTranslation();
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
  useEnterToConfirm(() => void confirmOffload(), !!offloadTargets && !!deletePreview && !deleting);

  // The server's job, so an update started elsewhere or before mounting still shows here, and
  // any run finishing refreshes the list.
  const downloadJob = usePackDownloadJob({
    onFinish: (status) => {
      if (status.error) setError(status.error);
      onRefresh();
    },
  });
  const downloadStatus = downloadJob.status;
  const jobPackIds = new Set(downloadStatus?.running ? downloadStatus.packIds : []);
  const updatingIds = jobPackIds;
  const bulkUpdating = downloadStatus?.running === true && downloadStatus.packIds.length > 1;

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
    // Only starts the job; onFinish above refreshes the list when it ends.
    if (!(await downloadJob.start("/offline-packs/download", { packIds })))
      setError(t("offlinePacks.downloaded.updateStartFailed"));
  }

  // Downloads the full counterpart of a small pack, then offloads the small one: the full pack
  // covers everything it did, so keeping both would only be confusing bookkeeping.
  async function upgradeToFull(smallPack: PackEntry, fullPack: PackEntry) {
    setError(null);
    setUpgradingIds((prev) => new Set([...prev, smallPack.id]));
    try {
      const wait = nextPackDownloadFinish([fullPack.id]);
      if (!(await downloadJob.start("/offline-packs/download", { packIds: [fullPack.id] }))) {
        wait.cancel();
        throw new Error(t("offlinePacks.downloaded.downloadStartFailed"));
      }
      const status = await wait.finished;
      if (status.error) throw new Error(status.error);
      if (status.cancelled) throw new Error(t("offlinePacks.downloaded.downloadCancelled"));
      await api.post("/offline-packs/offload-batch", { packIds: [smallPack.id] });
      onRefresh();
    } catch (err) {
      console.error(err);
      setError(errorMessage(err, t("offlinePacks.downloaded.upgradeFailed")));
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
      const preview = await api.post<DeletePreview>("/offline-packs/offload-preview", {
        packIds: targets.map((p) => p.id),
      });
      setDeletePreview(preview);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : t("offlinePacks.offload.previewFailed"));
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
      setDeleteError(err instanceof ApiError ? err.message : t("offlinePacks.offload.failed"));
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
        <input
          type="checkbox"
          checked={selectedIds.has(p.id)}
          onChange={() => toggleSelection(p.id)}
          className="h-4 w-4"
        />
        <span className="flex-1 text-ink">
          {p.type === "seaZone"
            ? p.taxon
              ? t("offlinePacks.downloaded.nameWithTaxon", { name: p.seaZone, taxon: TAXON_CLASS_LABEL[p.taxon] })
              : p.seaZone
            : p.taxon
              ? TAXON_CLASS_LABEL[p.taxon]
              : t("offlinePacks.allTaxa")}
          {p.variant === "small" && (
            <span className="ml-2 text-xs text-muted" title={t("offlinePacks.downloaded.smallTitle")}>
              {t("offlinePacks.downloaded.small")}
            </span>
          )}
          {p.updateAvailable && (
            <span className="ml-2 text-xs text-accent">{t("offlinePacks.downloaded.updateAvailable")}</span>
          )}
        </span>
        <span
          className="text-xs text-muted"
          title={
            p.photoBytes != null && p.checklistBytes != null
              ? t("offlinePacks.downloaded.sizeBreakdown", {
                  photos: formatBytes(p.photoBytes),
                  checklist: formatBytes(p.checklistBytes),
                })
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
            title={t("offlinePacks.downloaded.getFullTitle")}
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
          >
            {upgrading && <InlineSpinner size="xs" tone="ink" />}
            {upgrading
              ? t("offlinePacks.downloaded.gettingFull")
              : t("offlinePacks.downloaded.getFull", { size: formatBytes(fullSibling.sizeBytes) })}
          </button>
        )}
        {p.updateAvailable && (
          <button
            type="button"
            disabled={updatingIds.has(p.id)}
            onClick={() => updatePacks([p.id])}
            className="flex items-center gap-1.5 rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent hover:bg-surface-muted disabled:opacity-50"
          >
            {updatingIds.has(p.id) && <InlineSpinner size="xs" />}
            {updatingIds.has(p.id) ? t("offlinePacks.downloaded.updating") : t("offlinePacks.downloaded.update")}
          </button>
        )}
        {renderPackExtra?.(p)}
        <button
          type="button"
          onClick={() => openOffloadConfirm([p, ...orphanedSeaZoneDependents(downloadedPacks, [p])])}
          className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
        >
          {t("offlinePacks.offload.button")}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">{t("offlinePacks.downloaded.title")}</p>
        <div className="flex gap-2">
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setExpandedGroups(
                  expandedGroups.size === groups.length ? new Set() : new Set(groups.map(([name]) => name)),
                )
              }
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              {expandedGroups.size === groups.length
                ? t("offlinePacks.downloaded.collapseAll")
                : t("offlinePacks.downloaded.expandAll")}
            </button>
          )}
          {downloadedPacks.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setSelectedIds(
                  downloadedPacks.every((p) => selectedIds.has(p.id))
                    ? new Set()
                    : new Set(downloadedPacks.map((p) => p.id)),
                )
              }
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              {downloadedPacks.every((p) => selectedIds.has(p.id))
                ? t("offlinePacks.downloaded.deselectAll")
                : t("offlinePacks.downloaded.selectAll")}
            </button>
          )}
          {downloadedPacks.some((p) => p.updateAvailable) && (
            <button
              type="button"
              disabled={bulkUpdating}
              onClick={() => updatePacks(downloadedPacks.filter((p) => p.updateAvailable).map((p) => p.id))}
              className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
            >
              {bulkUpdating && <InlineSpinner size="xs" tone="onAccent" />}
              {bulkUpdating ? t("offlinePacks.downloaded.updating") : t("offlinePacks.downloaded.updateAll")}
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
              {t("offlinePacks.offload.selected", { count: selectedIds.size })}
            </button>
          )}
        </div>
      </div>
      <FormMessage error={error ?? downloadJob.actionError} className="mt-2" />
      {showJobProgress && downloadStatus?.running && (
        <div className="mt-3">
          <JobProgress
            status={downloadStatus}
            phases={PACK_DOWNLOAD_PHASES}
            detail={packProgressDetail(downloadStatus)}
            onCancel={() => void downloadJob.cancel("/offline-packs/download/cancel")}
            cancelling={downloadJob.cancelling}
          />
        </div>
      )}
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
          // A standalone sea zone pack would be a group of one with its own name: show it flat.
          const isTrivialSelfGroup =
            allPacks.length === 1 && allPacks[0].type === "seaZone" && allPacks[0].seaZone === groupName;
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
                <button
                  type="button"
                  onClick={() => toggleGroupCollapsed(groupName)}
                  className="flex flex-1 items-center justify-between text-left text-ink"
                >
                  <span>
                    {groupName}{" "}
                    <span className="text-xs text-muted">
                      {t("offlinePacks.downloaded.groupPackCount", { count: allPacks.length })}
                    </span>
                  </span>
                  <span className="text-xs text-muted">
                    {formatBytes(groupBytes)} {collapsed ? "▸" : "▾"}
                  </span>
                </button>
              </div>
              {!collapsed && hasBothTabs && (
                <div className="mt-1.5 ml-6 flex gap-1">
                  <Pill
                    size="sm"
                    active={activeTab === "main"}
                    onClick={() => setGroupTab(new Map(groupTab).set(groupName, "main"))}
                  >
                    {t("offlinePacks.downloaded.packsTab", { count: main.length })}
                  </Pill>
                  <Pill
                    size="sm"
                    active={activeTab === "seaZones"}
                    onClick={() => setGroupTab(new Map(groupTab).set(groupName, "seaZones"))}
                  >
                    {t("offlinePacks.downloaded.seaZonesTab", { count: seaZones.length })}
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
                    {activePacks.every((p) => selectedIds.has(p.id))
                      ? t("offlinePacks.downloaded.deselectAll")
                      : t("offlinePacks.downloaded.selectAll")}
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

      <Modal
        open={!!offloadTargets}
        onClose={() => setOffloadTargets(null)}
        size="sm"
        title={
          offloadTargets?.length === 1
            ? offloadTargets[0].taxon
              ? t("offlinePacks.offload.titleOneWithTaxon", {
                  name: offloadTargets[0].region ?? offloadTargets[0].seaZone,
                  taxon: TAXON_CLASS_LABEL[offloadTargets[0].taxon],
                })
              : t("offlinePacks.offload.titleOne", { name: offloadTargets[0].region ?? offloadTargets[0].seaZone })
            : t("offlinePacks.offload.titleMany", { count: offloadTargets?.length ?? 0 })
        }
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setOffloadTargets(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" size="sm" onClick={confirmOffload} disabled={!deletePreview} loading={deleting}>
              {deleting ? t("offlinePacks.offload.offloading") : t("offlinePacks.offload.button")}
            </Button>
          </>
        }
      >
        {!deletePreview && !deleteError && <p className="text-sm text-muted">{t("offlinePacks.offload.checking")}</p>}
        {deletePreview && (
          <div className="space-y-2 text-sm text-muted">
            <p>
              {deletePreview.isEstimate
                ? t("offlinePacks.offload.estimate", { size: formatBytes(deletePreview.bytesToFree) })
                : t("offlinePacks.offload.photosRemoved", {
                    count: deletePreview.speciesToRemoveCount,
                    size: formatBytes(deletePreview.bytesToFree),
                  })}
            </p>
            {deletePreview.speciesKeptCount > 0 && (
              <p>{t("offlinePacks.offload.speciesKept", { count: deletePreview.speciesKeptCount })}</p>
            )}
            {deletePreview.checklistRegionsAffectedCount > 0 && (
              <p>
                {t("offlinePacks.offload.checklistsAffected", { count: deletePreview.checklistRegionsAffectedCount })}
              </p>
            )}
            <p className="text-xs text-muted">{t("offlinePacks.offload.ownPhotosSafe")}</p>
          </div>
        )}
        <FormMessage error={deleteError} className="mt-3" />
      </Modal>
    </div>
  );
}
