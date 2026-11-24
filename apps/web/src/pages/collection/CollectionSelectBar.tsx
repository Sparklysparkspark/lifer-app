import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { SelectionBar, type BarAction } from "../../components/SelectionActionRow";
import Button from "../../components/Button";
import { useToast } from "../../hooks/useToast";
import type { SpeciesChange } from "../../components/SpeciesCard";

type Action = "target" | "seen" | "archive";
type BulkAction = Action | "untarget" | "unseen" | "unarchive";

const DONE_KEY = {
  target: "collection.select.doneTarget",
  seen: "collection.select.doneSeen",
  archive: "collection.select.doneArchive",
} as const;

// What each action does to the cards on screen, and what reverses it.
const EFFECT: Record<BulkAction, { change: SpeciesChange; undo?: BulkAction }> = {
  target: { change: { isTarget: true }, undo: "untarget" },
  untarget: { change: { isTarget: false } },
  seen: { change: { state: "seen" }, undo: "unseen" },
  unseen: { change: { state: "unseen" } },
  archive: { change: "removed", undo: "unarchive" },
  unarchive: { change: "reload" },
};

// Select mode's bar on Collection: bulk add to targets, mark as seen or archive, one Undo each.
export default function CollectionSelectBar({
  selectedIds,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onChanged,
  onDone,
}: {
  selectedIds: ReadonlySet<string>;
  /** Species in the list, for Select all. */
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onChanged: (speciesIds: string[], change: SpeciesChange) => void;
  /** An action went through: leave select mode. */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState<Action | null>(null);
  const count = selectedIds.size;

  async function send(action: BulkAction, speciesIds: string[]): Promise<string[]> {
    const res = await api.post("/collection/bulk", { action, speciesIds });
    if (res.changedIds.length > 0) onChanged(res.changedIds, EFFECT[action].change);
    return res.changedIds;
  }

  async function run(action: Action) {
    setBusy(action);
    try {
      const changed = await send(action, [...selectedIds]);
      onDone();
      const undo = EFFECT[action].undo!;
      toast.show(t(DONE_KEY[action], { count: changed.length }), {
        tone: "success",
        actions:
          changed.length > 0
            ? [
                {
                  label: t("species.edits.undo"),
                  onClick: () => void send(undo, changed).catch(() => toast.error(t("collection.select.failed"))),
                },
              ]
            : undefined,
      });
    } catch {
      toast.error(t("collection.select.failed"));
    } finally {
      setBusy(null);
    }
  }

  const actions: BarAction[] = [
    {
      key: "target",
      label: t("collection.select.target"),
      onClick: () => void run("target"),
      loading: busy === "target",
    },
    { key: "seen", label: t("collection.select.seen"), onClick: () => void run("seen"), loading: busy === "seen" },
    {
      key: "archive",
      label: t("collection.select.archive"),
      onClick: () => void run("archive"),
      loading: busy === "archive",
    },
  ];
  return (
    <SelectionBar
      count={count}
      busyLabel={busy ? t("common.saving") : null}
      emptyText={t("collection.select.none")}
      actions={actions}
      links={
        <>
          {count < totalCount && (
            <Button variant="link" size="sm" onClick={onSelectAll} className="shrink-0">
              {t("collection.select.selectAll")}
            </Button>
          )}
          {count > 0 && (
            <Button variant="link" size="sm" onClick={onDeselectAll} className="shrink-0">
              {t("collection.select.deselectAll")}
            </Button>
          )}
        </>
      }
    />
  );
}
