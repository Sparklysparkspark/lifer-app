import { useState } from "react";
import type { PackStatusEntry } from "../lib/packIndex";
import { TAXON_CLASS_LABEL } from "@lifer/shared";
import { api, type ApiResponse } from "../api/client";
import { usePackDownloadJob } from "../hooks/usePackDownloadStatus";
import PackProgress from "./PackProgress";
import { formatBytes } from "../lib/format";
import { errorMessage } from "../lib/errorMessage";
import { nextPackDownloadFinish } from "../lib/waitForPackDownload";
import { useTranslation } from "react-i18next";
import { useJobPoll } from "../hooks/useJobPoll";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import SegmentedControl from "./SegmentedControl";
import Chevron from "./Chevron";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";
import Panel from "./Panel";
import Checkbox from "./Checkbox";
import { useToast } from "../hooks/useToast";
import type { AddedSpeciesRow } from "./AddedSpeciesList";

type GroupTab = "main" | "seaZones";
const MAIN_TAB: GroupTab = "main";
const SEA_ZONES_TAB: GroupTab = "seaZones";

// Prefixed so an added-species group's selection id can't collide with a pack id.
const addedId = (r: AddedSpeciesRow) => `added:${r.key}`;

export type DeletePreview = ApiResponse<"/offline-packs/offload-preview", "post">;

// A country's packs grouped with the sea-zone packs it depends on. Keyed by pack id, since a zone
// can have a pack per taxon.
function groupPacks(packs: PackStatusEntry[]): [string, { main: PackStatusEntry[]; seaZones: PackStatusEntry[] }][] {
  const seaZoneOwner = new Map<string, string>();
  for (const p of packs) {
    if (p.type === "region" && p.seaZoneDependencies) {
      for (const depId of p.seaZoneDependencies) seaZoneOwner.set(depId, p.region ?? "");
    }
  }
  const groups = new Map<string, { main: PackStatusEntry[]; seaZones: PackStatusEntry[] }>();
  for (const p of packs) {
    const groupName = p.type === "seaZone" ? (seaZoneOwner.get(p.id) ?? p.seaZone ?? "") : (p.region ?? "");
    let group = groups.get(groupName);
    if (!group) groups.set(groupName, (group = { main: [], seaZones: [] }));
    (p.type === "seaZone" ? group.seaZones : group.main).push(p);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// The full/small counterpart of the same region (or zone) and taxon, matched on identity.
function siblingVariantPack(p: PackStatusEntry, allPacks: PackStatusEntry[]): PackStatusEntry | undefined {
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
function orphanedSeaZoneDependents(allPacks: PackStatusEntry[], targets: PackStatusEntry[]): PackStatusEntry[] {
  const targetIds = new Set(targets.map((t) => t.id));
  const survivingDependencyIds = new Set(
    allPacks.filter((p) => p.type === "region" && !targetIds.has(p.id)).flatMap((p) => p.seaZoneDependencies ?? []),
  );
  const orphaned: PackStatusEntry[] = [];
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
  addedRows = [],
}: {
  packs: PackStatusEntry[];
  onRefresh: () => void;
  /** An extra per-pack action (e.g. the province manager). */
  renderPackExtra?: (pack: PackStatusEntry) => React.ReactNode;
  /** A block below a pack's row, outside its flex layout. */
  renderPackPanel?: (pack: PackStatusEntry) => React.ReactNode;
  /** false when the page already shows its own pack-download progress (Offline Packs). */
  showJobProgress?: boolean;
  /** Species you added from iNaturalist, shown under their country after its downloaded groups. */
  addedRows?: AddedSpeciesRow[];
}) {
  const { t } = useTranslation();
  const downloadedPacks = packs.filter((p) => p.downloaded);
  const packGroups = groupPacks(downloadedPacks);
  // A country with only added species still gets its group.
  const groups = [
    ...packGroups,
    ...[...new Set(addedRows.map((r) => r.country))]
      .filter((c) => !packGroups.some(([name]) => name === c))
      .map((c): (typeof packGroups)[number] => [c, { main: [], seaZones: [] }]),
  ].sort(([a], [b]) => a.localeCompare(b));
  const addedFor = (country: string) => addedRows.filter((r) => r.country === country);
  const selectableAddedIds = (rows: AddedSpeciesRow[]) => rows.filter((r) => r.removable).map(addedId);
  const toast = useToast();
  const [upgradingIds, setUpgradingIds] = useState<Set<string>>(new Set());

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupTab, setGroupTab] = useState<Map<string, GroupTab>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [offloadTargets, setOffloadTargets] = useState<PackStatusEntry[] | null>(null);
  const [offloadAdded, setOffloadAdded] = useState<AddedSpeciesRow[]>([]);
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Packs whose removal was asked for but whose job the server hasn't reported yet.
  const [pendingRemovalIds, setPendingRemovalIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Added species need no preview: their rows already say what goes.
  const offloadReady = !!offloadTargets && (offloadTargets.length === 0 || !!deletePreview);
  useEnterToConfirm(() => void confirmOffload(), offloadReady);

  // The server's job, so an update started elsewhere or before mounting still shows here, and
  // any run finishing refreshes the list.
  const downloadJob = usePackDownloadJob({
    onFinish: (status) => {
      if (status.error) setError(status.error);
      onRefresh();
    },
  });
  // Removal is a server job too: the dialog closes at once and rows read "Removing..." until done.
  const removalJob = useJobPoll<ApiResponse<"/offline-packs/removal-status", "get">>("/offline-packs/removal-status", {
    onFinish: (status) => {
      if (status.error) setError(t("offlinePacks.offload.failedKept"));
      else toast.success(t("offlinePacks.offload.done", { count: status.processed ?? 0 }));
      onRefresh();
    },
  });
  const removingIds = new Set([...pendingRemovalIds, ...(removalJob.status?.running ? removalJob.status.packIds : [])]);
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
  async function upgradeToFull(smallPack: PackStatusEntry, fullPack: PackStatusEntry) {
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
      await removalJob.start("/offline-packs/offload-batch", { packIds: [smallPack.id] });
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

  async function openOffloadConfirm(targets: PackStatusEntry[], added: AddedSpeciesRow[] = []) {
    setOffloadTargets(targets);
    setOffloadAdded(added);
    setDeletePreview(null);
    setDeleteError(null);
    if (targets.length === 0) return;
    try {
      const preview = await api.post("/offline-packs/offload-preview", {
        packIds: targets.map((p) => p.id),
      });
      setDeletePreview(preview);
    } catch (err) {
      setDeleteError(errorMessage(err, t("offlinePacks.offload.previewFailed")));
    }
  }

  async function confirmOffload() {
    if (!offloadTargets) return;
    const packIds = offloadTargets.map((p) => p.id);
    const added = offloadAdded;
    // The dialog closes at once and the rows read "Removing..." while the work runs.
    setOffloadTargets(null);
    setDeletePreview(null);
    setSelectedIds(new Set());
    setError(null);
    setPendingRemovalIds(new Set(packIds));
    try {
      if (packIds.length > 0 && !(await removalJob.start("/offline-packs/offload-batch", { packIds })))
        throw new Error(t("offlinePacks.offload.failed"));
      // One call per group: the per-group route already keeps species you've photographed.
      let removed = 0;
      for (const r of added) removed += await r.removeQuietly();
      if (added.length > 0) toast.success(t("addedSpecies.removed", { count: removed }));
      onRefresh();
    } catch (err) {
      setError(errorMessage(err, t("offlinePacks.offload.failed")));
    } finally {
      setPendingRemovalIds(new Set());
      if (added.length > 0) void added[0].reload();
    }
  }

  const selectedPacks = downloadedPacks.filter((p) => selectedIds.has(p.id));
  const selectedAdded = addedRows.filter((r) => r.removable && selectedIds.has(addedId(r)));
  const selectedCount = selectedPacks.length + selectedAdded.length;
  const allSelectableIds = [...downloadedPacks.map((p) => p.id), ...selectableAddedIds(addedRows)];
  const allSelected = allSelectableIds.every((id) => selectedIds.has(id));
  const offloadAddedSpecies = offloadAdded.reduce((sum, r) => sum + r.removableCount, 0);
  const offloadAddedKept = offloadAdded.reduce((sum, r) => sum + r.photographedCount, 0);

  if (downloadedPacks.length === 0 && addedRows.length === 0) return null;

  function renderPackRow(p: PackStatusEntry) {
    const fullSibling = p.variant === "small" ? siblingVariantPack(p, packs) : undefined;
    const upgrading = upgradingIds.has(p.id);
    const removing = removingIds.has(p.id);
    return (
      <div className="flex items-center gap-2 text-callout">
        <Checkbox
          checked={selectedIds.has(p.id)}
          onChange={() => toggleSelection(p.id)}
          disabled={removing}
          aria-labelledby={`downloaded-pack-${p.id}`}
        />
        <span id={`downloaded-pack-${p.id}`} className="flex-1 text-ink">
          {p.type === "seaZone"
            ? p.taxon
              ? t("offlinePacks.downloaded.nameWithTaxon", { name: p.seaZone, taxon: TAXON_CLASS_LABEL[p.taxon] })
              : p.seaZone
            : p.taxon
              ? TAXON_CLASS_LABEL[p.taxon]
              : t("offlinePacks.allTaxa")}
          {p.variant === "small" && (
            <span className="ml-2 text-footnote text-muted" title={t("offlinePacks.downloaded.smallTitle")}>
              {t("offlinePacks.downloaded.small")}
            </span>
          )}
          {p.updateAvailable && (
            <span className="ml-2 text-footnote text-accent">{t("offlinePacks.downloaded.updateAvailable")}</span>
          )}
        </span>
        <span
          className="text-footnote text-muted"
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
          <Button
            variant="secondary"
            size="sm"
            loading={upgrading}
            onClick={() => upgradeToFull(p, fullSibling)}
            tooltip={{ label: t("offlinePacks.downloaded.getFullTitle") }}
          >
            {upgrading
              ? t("offlinePacks.downloaded.gettingFull")
              : t("offlinePacks.downloaded.getFull", { size: formatBytes(fullSibling.sizeBytes) })}
          </Button>
        )}
        {p.updateAvailable && (
          <Button variant="secondary" size="sm" loading={updatingIds.has(p.id)} onClick={() => updatePacks([p.id])}>
            {updatingIds.has(p.id) ? t("offlinePacks.downloaded.updating") : t("offlinePacks.downloaded.update")}
          </Button>
        )}
        {renderPackExtra?.(p)}
        <Button
          variant="secondary"
          size="sm"
          loading={removing}
          onClick={() => openOffloadConfirm([p, ...orphanedSeaZoneDependents(downloadedPacks, [p])])}
        >
          {removing ? t("offlinePacks.offload.offloading") : t("offlinePacks.offload.button")}
        </Button>
      </div>
    );
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-callout font-semibold text-ink">{t("offlinePacks.downloaded.title")}</p>
        <div className="flex flex-wrap gap-2">
          {groups.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setExpandedGroups(
                  expandedGroups.size === groups.length ? new Set() : new Set(groups.map(([name]) => name)),
                )
              }
            >
              {expandedGroups.size === groups.length
                ? t("offlinePacks.downloaded.collapseAll")
                : t("offlinePacks.downloaded.expandAll")}
            </Button>
          )}
          {allSelectableIds.length > 1 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSelectedIds(allSelected ? new Set() : new Set(allSelectableIds))}
            >
              {allSelected ? t("offlinePacks.downloaded.deselectAll") : t("offlinePacks.downloaded.selectAll")}
            </Button>
          )}
          {downloadedPacks.some((p) => p.updateAvailable) && (
            <Button
              size="sm"
              loading={bulkUpdating}
              onClick={() => updatePacks(downloadedPacks.filter((p) => p.updateAvailable).map((p) => p.id))}
            >
              {bulkUpdating ? t("offlinePacks.downloaded.updating") : t("offlinePacks.downloaded.updateAll")}
            </Button>
          )}
          {selectedCount > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                openOffloadConfirm(
                  [...selectedPacks, ...orphanedSeaZoneDependents(downloadedPacks, selectedPacks)],
                  selectedAdded,
                )
              }
            >
              {t("offlinePacks.offload.selected", { count: selectedCount })}
            </Button>
          )}
        </div>
      </div>
      <FormMessage error={error ?? downloadJob.actionError} className="mt-2" />
      {showJobProgress && downloadStatus?.running && (
        <div className="mt-3">
          <PackProgress
            status={downloadStatus}
            onCancel={(downloadsOnly) =>
              void downloadJob.cancel("/offline-packs/download/cancel", downloadsOnly ? { downloadsOnly } : undefined)
            }
            cancelling={downloadJob.cancelling}
          />
        </div>
      )}
      <div className="mt-2 divide-y divide-line">
        {groups.map(([groupName, { main, seaZones }]) => {
          const allPacks = [...main, ...seaZones];
          const added = addedFor(groupName);
          const groupIds = [...allPacks.map((p) => p.id), ...selectableAddedIds(added)];
          const groupSelected = groupIds.length > 0 && groupIds.every((id) => selectedIds.has(id));
          const groupBytes =
            allPacks.reduce((sum, p) => sum + p.sizeBytes, 0) + added.reduce((sum, r) => sum + r.bytes, 0);
          const collapsed = !expandedGroups.has(groupName);
          // Added species sit with the country's own downloads.
          const mainCount = main.length + added.length;
          const hasBothTabs = mainCount > 0 && seaZones.length > 0;
          const activeTab = groupTab.get(groupName) ?? (mainCount > 0 ? MAIN_TAB : SEA_ZONES_TAB);
          const activePacks = activeTab === SEA_ZONES_TAB ? seaZones : main;
          const activeIds = [
            ...activePacks.map((p) => p.id),
            ...(activeTab === MAIN_TAB ? selectableAddedIds(added) : []),
          ];
          // A standalone sea zone pack would be a group of one with its own name: show it flat.
          const isTrivialSelfGroup =
            added.length === 0 &&
            allPacks.length === 1 &&
            allPacks[0].type === "seaZone" &&
            allPacks[0].seaZone === groupName;
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
              <div className="flex items-center gap-2 text-callout">
                <Checkbox
                  checked={groupSelected}
                  indeterminate={!groupSelected && groupIds.some((id) => selectedIds.has(id))}
                  disabled={groupIds.length === 0}
                  aria-label={t("offlinePacks.downloaded.selectCountry", { country: groupName })}
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
                />
                {/* raw-control: the group's whole header row is its disclosure. */}
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroupCollapsed(groupName)}
                  className="flex flex-1 items-center justify-between rounded-control text-left text-ink transition-colors hover:bg-surface-muted"
                >
                  <span>
                    {groupName}{" "}
                    <span className="text-footnote text-muted">
                      {t("offlinePacks.downloaded.groupPackCount", { count: allPacks.length + added.length })}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-footnote text-muted">
                    {formatBytes(groupBytes)} <Chevron open={!collapsed} />
                  </span>
                </button>
              </div>
              {!collapsed && hasBothTabs && (
                <div className="mt-1.5 ml-6">
                  <SegmentedControl
                    value={activeTab}
                    onChange={(tab) => setGroupTab(new Map(groupTab).set(groupName, tab))}
                    options={[
                      { value: MAIN_TAB, label: t("offlinePacks.downloaded.packsTab", { count: mainCount }) },
                      {
                        value: SEA_ZONES_TAB,
                        label: t("offlinePacks.downloaded.seaZonesTab", { count: seaZones.length }),
                      },
                    ]}
                  />
                </div>
              )}
              {!collapsed && activeIds.length > 1 && (
                <div className="mt-1.5 ml-6">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        const allActiveSelected = activeIds.every((id) => next.has(id));
                        for (const id of activeIds) {
                          if (allActiveSelected) next.delete(id);
                          else next.add(id);
                        }
                        return next;
                      })
                    }
                  >
                    {activeIds.every((id) => selectedIds.has(id))
                      ? t("offlinePacks.downloaded.deselectAll")
                      : t("offlinePacks.downloaded.selectAll")}
                  </Button>
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
                  {activeTab === "main" &&
                    added.map((r) => (
                      <li key={r.key} className="py-1.5">
                        {r.row(
                          <Checkbox
                            checked={r.removable && selectedIds.has(addedId(r))}
                            disabled={!r.removable}
                            title={r.removable ? undefined : t("addedSpecies.allPhotographed")}
                            onChange={() => toggleSelection(addedId(r))}
                            aria-label={r.label}
                          />,
                        )}
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
        title={
          offloadAdded.length > 0
            ? t("offlinePacks.offload.titleManyItems", {
                count: (offloadTargets?.length ?? 0) + offloadAdded.length,
              })
            : offloadTargets?.length === 1
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
            <Button variant="secondary" onClick={() => setOffloadTargets(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={confirmOffload} disabled={!offloadReady}>
              {t("offlinePacks.offload.button")}
            </Button>
          </>
        }
      >
        <p className="mb-2 text-body text-ink">{t("offlinePacks.offload.ownPhotosSafe")}</p>
        {!offloadReady && !deleteError && (
          <p className="text-callout text-muted">{t("offlinePacks.offload.checking")}</p>
        )}
        {deletePreview && (
          <div className="space-y-2 text-callout text-muted">
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
          </div>
        )}
        {offloadAdded.length > 0 && (
          <div className={`space-y-2 text-callout text-muted${deletePreview ? " mt-2" : ""}`}>
            <p>
              {t("offlinePacks.offload.addedSpecies", {
                count: offloadAddedSpecies,
                size: formatBytes(offloadAdded.reduce((sum, r) => sum + r.bytes, 0)),
              })}
            </p>
            {offloadAddedKept > 0 && <p>{t("addedSpecies.removeConfirm.stays", { count: offloadAddedKept })}</p>}
          </div>
        )}
        <FormMessage error={deleteError} className="mt-3" />
      </Modal>
    </Panel>
  );
}
