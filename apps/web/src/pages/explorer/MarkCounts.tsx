// A node's Targets and Seen marks: the card icons, with "3 targets" on a group. A species row shows
// the icons alone, named for screen readers and on hover.
import { useTranslation } from "react-i18next";
import { SeenIcon, TargetIcon } from "../../components/MarkIcon";
import { formatNumber } from "../../lib/format";
import type { TreeNode } from "./treeModel";

export default function MarkCounts({ node, iconsOnly = false }: { node: TreeNode; iconsOnly?: boolean }) {
  const { t } = useTranslation();
  const species = node.rank === "species";
  const marks = [
    node.targetCount > 0 && {
      key: "target",
      icon: <TargetIcon />,
      text: species
        ? t("speciesCard.targetTitle")
        : t("explorer.marks.targets", { count: node.targetCount, formatted: formatNumber(node.targetCount) }),
    },
    node.seenCount > 0 && {
      key: "seen",
      icon: <SeenIcon />,
      text: species
        ? t("speciesCard.seenTitle")
        : t("explorer.marks.seen", { count: node.seenCount, formatted: formatNumber(node.seenCount) }),
    },
  ].filter((m) => !!m);
  return marks.map((m) =>
    iconsOnly ? (
      <span key={m.key} role="img" aria-label={m.text} title={m.text} className="inline-flex text-muted">
        {m.icon}
      </span>
    ) : (
      <span key={m.key} className="inline-flex items-center gap-1 text-footnote text-muted tabular-nums">
        {m.icon}
        {m.text}
      </span>
    ),
  );
}
