// Targets and Seen from the Tree of life: one species, or every species shown under a group, through
// POST /collection/bulk. Instant, with Undo on the notice; only a big group asks first.
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { MenuAction } from "../../components/Menu";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import { formatNumber } from "../../lib/format";
import { markable, type MarkAction, type TreeNode } from "./treeModel";

// More than this many species asks first, saying exactly how many.
const HANDFUL = 10;
// The bulk route's cap per call.
const CHUNK = 50_000;
const UNDO: Record<MarkAction, MarkAction> = { target: "untarget", untarget: "target", seen: "unseen", unseen: "seen" };
const DONE: Record<MarkAction, string> = {
  target: "collection.select.doneTarget",
  untarget: "explorer.marks.doneUntarget",
  seen: "collection.select.doneSeen",
  unseen: "explorer.marks.doneUnseen",
};
const SPECIES_LABEL: Record<MarkAction, string> = {
  target: "speciesCard.menu.addTarget",
  untarget: "speciesCard.menu.removeTarget",
  seen: "speciesCard.menu.markSeen",
  unseen: "speciesCard.menu.markUnseen",
};
// A group offers adding targets, marking seen and removing its targets.
const GROUP: { action: MarkAction; label: string; confirm: string }[] = [
  { action: "target", label: "explorer.marks.targetGroup", confirm: "explorer.marks.confirmTarget" },
  { action: "seen", label: "explorer.marks.seenGroup", confirm: "explorer.marks.confirmSeen" },
  { action: "untarget", label: "explorer.marks.untargetGroup", confirm: "explorer.marks.confirmUntarget" },
];

export function useTreeMarks(onChanged: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();

  async function send(action: MarkAction, speciesIds: string[]): Promise<string[]> {
    const changed: string[] = [];
    for (let i = 0; i < speciesIds.length; i += CHUNK) {
      const res = await api.post("/collection/bulk", { action, speciesIds: speciesIds.slice(i, i + CHUNK) });
      changed.push(...res.changedIds);
    }
    return changed;
  }

  async function run(action: MarkAction, ids: string[]) {
    try {
      const changed = await send(action, ids);
      onChanged();
      toast.show(t(DONE[action], { count: changed.length }), {
        tone: "success",
        actions:
          changed.length > 0
            ? [
                {
                  label: t("species.edits.undo"),
                  onClick: () =>
                    void send(UNDO[action], changed)
                      .then(onChanged)
                      .catch(() => toast.error(t("collection.select.failed"))),
                },
              ]
            : undefined,
      });
    } catch {
      toast.error(t("collection.select.failed"));
    }
  }

  /** What can be done to a species or group as shown, each item naming how many species it changes. */
  return (node: TreeNode, name: string): MenuAction[] => {
    if (node.rank === "species") {
      const actions: MarkAction[] = [node.targetCount ? "untarget" : "target"];
      if (node.collected === 0) actions.push(node.seenCount ? "unseen" : "seen");
      return actions.map((action) => ({
        label: t(SPECIES_LABEL[action]),
        onSelect: () => void run(action, markable(node, action)),
      }));
    }
    return GROUP.flatMap(({ action, label, confirm: question }) => {
      const ids = markable(node, action);
      if (ids.length === 0) return [];
      const counts = { count: ids.length, formatted: formatNumber(ids.length) };
      const text = t(label, counts);
      return [
        {
          label: text,
          onSelect: () =>
            void (async () => {
              if (
                ids.length > HANDFUL &&
                !(await confirm({ title: t(question, { ...counts, name }), confirmLabel: text }))
              )
                return;
              await run(action, ids);
            })(),
        },
      ];
    });
  };
}
