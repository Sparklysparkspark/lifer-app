// How rare a species or group is, in the Tree of life's rarity view: a swatch on the circle's rarity
// band scale and its tier, or for a group the average tier and how many are rare or rarer.
import { useTranslation } from "react-i18next";
import { tierLabel } from "../../lib/speciesGroups";
import TierLabel, { Swatch } from "../../components/TierLabel";
import { RARITY_BG, RARITY_STEPS, rarityOf, rarityText, type TreeNode } from "./treeModel";

/** `text` replaces the tier wording, as the detail pane's "Legendary in Canada". */
export default function RarityChip({ node, text }: { node: TreeNode; text?: string }) {
  const { t } = useTranslation();
  const rarity = rarityOf(node);
  if (!rarity) return null;
  return <TierLabel>{text ?? rarityText(t, node)}</TierLabel>;
}

/** The band's scale under the circle, commonest to rarest. */
export function RarityLegend() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-footnote text-muted">
      <span>{t("explorer.rarity.edge")}</span>
      <ul
        aria-label={t("explorer.rarity.legend")}
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1"
      >
        {RARITY_STEPS.map((tier, i) => (
          <li key={tier} className="inline-flex items-center gap-1">
            <Swatch className={RARITY_BG[i]} />
            {tierLabel(tier)}
          </li>
        ))}
      </ul>
    </div>
  );
}
