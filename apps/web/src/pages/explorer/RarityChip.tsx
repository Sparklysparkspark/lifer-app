// How rare a species or group is, in the Tree of life's rarity view: a swatch on the circle's scale
// and its tier, or for a group the average tier and how many are rare or rarer.
import { useTranslation } from "react-i18next";
import { tierLabel } from "../../lib/speciesGroups";
import { RARITY_BG, RARITY_STEPS, rarityOf, rarityText, type TreeNode } from "./treeModel";

export default function RarityChip({ node }: { node: TreeNode }) {
  const { t } = useTranslation();
  const rarity = rarityOf(node);
  if (!rarity) return null;
  return (
    <span className="inline-flex items-center gap-1 text-footnote text-muted">
      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${RARITY_BG[rarity.step]}`} />
      {rarityText(t, node)}
    </span>
  );
}

/** The scale under the circle, commonest to rarest. */
export function RarityLegend() {
  const { t } = useTranslation();
  return (
    <ul aria-label={t("explorer.rarity.legend")} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      {RARITY_STEPS.map((tier, i) => (
        <li key={tier} className="inline-flex items-center gap-1 text-footnote text-muted">
          <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${RARITY_BG[i]}`} />
          {tierLabel(tier)}
        </li>
      ))}
    </ul>
  );
}
