import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import { useConfirm } from "../hooks/useConfirm";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useRegions } from "../hooks/useRegions";
import { useToast } from "../hooks/useToast";
import { formatRelativeTime } from "../lib/format";
import { listCallError, listErrorMessage, type SpeciesList } from "../lib/speciesLists";
import Button from "./Button";
import Menu, { MenuItems, MenuPanel, type MenuAction } from "./Menu";
import ProgressBar from "./ProgressBar";
import RenameModal from "./RenameModal";

type Action = "pause" | "resume" | "refresh";

function statusText(list: SpeciesList, t: ReturnType<typeof useTranslation>["t"]): string {
  const added = list.addedCount;
  const total = list.sizeEstimate;
  switch (list.status) {
    case "queued":
      if (list.nextBatchAt && added > 0)
        return t("speciesLists.status.nextBatch", {
          added,
          total: total ?? added,
          when: formatRelativeTime(list.nextBatchAt),
        });
      return t("speciesLists.status.queued");
    case "running":
      return total === null
        ? t("speciesLists.status.startingCount")
        : t("speciesLists.status.adding", { added, total });
    case "paused":
      return t("speciesLists.status.paused", { added, total: total ?? added });
    case "offline":
      return t("speciesLists.status.offline");
    case "failed":
      return listErrorMessage(list.lastError);
    case "done":
      return list.photosReady < added
        ? t("speciesLists.status.done", { count: added })
        : t("speciesLists.status.doneReady", { count: added });
  }
}

/** One list: its state in plain words, progress while adding, and its actions. */
export function SpeciesListRow({
  list,
  onChanged,
  onRemoved,
}: {
  list: SpeciesList;
  onChanged: (list: SpeciesList) => void;
  onRemoved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const menu = useDropdownMenu();
  const { regions } = useRegions();
  const [busy, setBusy] = useState<Action | "hide" | "remove" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const regionName = regions?.find((r) => r.id === list.regionId)?.name ?? list.place.name;

  async function run(action: Action) {
    setBusy(action);
    try {
      const path =
        action === "pause"
          ? apiPath("/species-lists/{id}/pause", { id: list.id })
          : action === "resume"
            ? apiPath("/species-lists/{id}/resume", { id: list.id })
            : apiPath("/species-lists/{id}/refresh", { id: list.id });
      onChanged((await api.post(path)).list);
    } catch (err) {
      toast.error(listCallError(err));
    } finally {
      setBusy(null);
    }
  }

  async function setHidden(hidden: boolean) {
    setBusy("hide");
    try {
      onChanged((await api.patch(apiPath("/species-lists/{id}", { id: list.id }), { hidden })).list);
      // Hiding only takes the list off the Collection; Settings keeps it, so say where (rule F3).
      if (hidden)
        toast.show(t("speciesLists.toast.hidden", { name: list.name }), {
          actions: [{ label: t("common.undo"), onClick: () => void setHidden(false) }],
        });
    } catch (err) {
      toast.error(listCallError(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: t("speciesLists.remove.title", { name: list.name }),
      message: t("speciesLists.remove.message", { count: list.addedCount, region: regionName }),
      confirmLabel: t("speciesLists.remove.confirm"),
      danger: true,
    });
    if (!ok) return;
    setBusy("remove");
    try {
      const res = await api.delete(apiPath("/species-lists/{id}", { id: list.id }));
      onRemoved(list.id);
      toast.success(
        res.kept > 0
          ? t("speciesLists.toast.removedKept", { name: list.name, kept: res.kept })
          : t("speciesLists.toast.removed", { name: list.name }),
      );
    } catch (err) {
      toast.error(listCallError(err));
      setBusy(null);
    }
  }

  const adding = list.status === "queued" || list.status === "running";
  // The one action the state calls for sits on the row; the rest go in the menu.
  const inline: { label: string; action: Action } | null =
    list.status === "queued" && list.nextBatchAt
      ? { label: t("speciesLists.actions.continue"), action: "resume" }
      : adding
        ? { label: t("speciesLists.actions.pause"), action: "pause" }
        : list.status === "paused"
          ? { label: t("speciesLists.actions.resume"), action: "resume" }
          : list.status === "offline" || list.status === "failed"
            ? { label: t("speciesLists.actions.retry"), action: "resume" }
            : null;
  const items: MenuAction[] = [
    ...(list.status !== "running"
      ? [{ label: t("speciesLists.actions.update"), onSelect: () => void run("refresh") }]
      : []),
    ...(list.status === "offline"
      ? [{ label: t("speciesLists.actions.pause"), onSelect: () => void run("pause") }]
      : []),
    { label: t("speciesLists.actions.rename"), onSelect: () => setRenaming(true) },
    list.hidden
      ? { label: t("speciesLists.actions.show"), onSelect: () => void setHidden(false) }
      : { label: t("speciesLists.actions.hide"), onSelect: () => void setHidden(true) },
    { label: t("speciesLists.actions.remove"), onSelect: () => void remove(), danger: true },
  ];

  const showBar = list.status === "running" || (list.status === "paused" && list.sizeEstimate !== null);
  const photosPending = list.addedCount > 0 && list.photosReady < list.addedCount;

  return (
    <div className="px-panel py-3" aria-busy={busy !== null || undefined}>
      <div className="flex items-start justify-between gap-item">
        <div className="min-w-0 flex-1">
          <p className="break-words text-body text-ink">
            {list.name}
            {list.hidden && <span className="ml-2 text-footnote text-muted">{t("speciesLists.hiddenTag")}</span>}
          </p>
          <p className="mt-0.5 text-subheadline text-muted">{statusText(list, t)}</p>
          {showBar && (
            <ProgressBar
              value={list.sizeEstimate ? list.addedCount / list.sizeEstimate : null}
              label={t("speciesLists.progressLabel", { name: list.name })}
              className="mt-2 max-w-md"
            />
          )}
          {photosPending && (
            <p className="mt-1 text-footnote text-muted">
              {t("speciesLists.photos.pending", { ready: list.photosReady, total: list.addedCount })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {inline && (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === inline.action}
              onClick={() => void run(inline.action)}
            >
              {inline.label}
            </Button>
          )}
          <Menu
            open={menu.openKey === true}
            onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
            menuRef={menu.ref}
            className="relative"
            trigger="toolbar"
          >
            <MenuPanel className="w-52">
              <MenuItems items={items} />
            </MenuPanel>
          </Menu>
        </div>
      </div>
      {renaming && (
        <RenameModal
          title={t("speciesLists.rename.title")}
          initialName={list.name}
          onCancel={() => setRenaming(false)}
          onSave={async (name) => {
            onChanged((await api.patch(apiPath("/species-lists/{id}", { id: list.id }), { name })).list);
            setRenaming(false);
          }}
        />
      )}
    </div>
  );
}
