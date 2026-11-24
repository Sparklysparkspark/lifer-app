// The Tree of life's detail pane: the selected group or species, its best photos, how much of it
// you have, its rarest finds, and ways onward (species page, a random species).
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import Button from "../../components/Button";
import ProgressiveImg from "../../components/ProgressiveImg";
import { buttonClasses } from "../../lib/buttonClasses";
import { backStateFor } from "../../lib/backLabel";
import { formatNumber } from "../../lib/format";
import { tierLabel } from "../../lib/speciesGroups";
import { ancestorIds, collectedLeaves, rarestFirst, type TreeIndex, type TreeNode } from "./treeModel";

const MOSAIC = 6;
const RAREST = 5;

function ProgressRing({ collected, total }: { collected: number; total: number }) {
  const { t } = useTranslation();
  const r = 22;
  const length = 2 * Math.PI * r;
  const share = total > 0 ? collected / total : 0;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 56 56" className="h-14 w-14 shrink-0 -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" className="stroke-line" />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${share * length} ${length}`}
          className="stroke-accent transition-[stroke-dasharray] duration-500"
        />
      </svg>
      <p className="text-callout text-ink">
        {t("explorer.speciesOf", {
          collected: formatNumber(collected),
          total: formatNumber(total),
        })}
      </p>
    </div>
  );
}

export default function ExplorerDetail({
  index,
  id,
  label,
  onSelect,
  onRandom,
  onOpenPhotos,
}: {
  index: TreeIndex;
  id: string;
  label: (node: TreeNode) => string;
  onSelect: (id: string) => void;
  onRandom: (() => void) | null;
  /** Opens the viewer on these species' best photos at `start`. */
  onOpenPhotos: (nodes: TreeNode[], start: number) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const entry = index.byId.get(id);
  if (!entry) return null;
  const { node } = entry;
  const isSpecies = node.rank === "species";
  const leaves = collectedLeaves(index, id);
  const rarest = rarestFirst(leaves);
  const mosaic = rarest.filter((l) => l.node.photoId).slice(0, MOSAIC);
  const crumbs = ancestorIds(index, id);

  return (
    <div className="space-y-4">
      {crumbs.length > 0 && (
        <nav aria-label={t("explorer.breadcrumbs")} className="flex flex-wrap items-center gap-x-1 text-footnote">
          {crumbs.map((crumbId, i) => (
            <span key={crumbId} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-muted">
                  /
                </span>
              )}
              <Button variant="link" size="sm" onClick={() => onSelect(crumbId)}>
                {label(index.byId.get(crumbId)!.node)}
              </Button>
            </span>
          ))}
        </nav>
      )}
      <div>
        <h2 className="text-title-3 font-semibold text-ink wrap-anywhere">{label(node)}</h2>
        {isSpecies && node.commonName && label(node) !== node.name && (
          <p className="text-callout text-muted italic wrap-anywhere">{node.name}</p>
        )}
        {isSpecies && node.tier && node.tier !== "unrated" && (
          <p className="text-footnote text-muted">{tierLabel(node.tier)}</p>
        )}
      </div>

      {node.collected === 0 ? (
        <div className="space-y-2">
          {node.referenceUrl && (
            // raw-control: the whole photo is the button that opens it full size, as in the mosaic.
            <button
              type="button"
              aria-label={t("explorer.openPhoto", { name: label(node) })}
              onClick={() => onOpenPhotos([node], 0)}
              className="cover-uncollected block w-full overflow-hidden rounded-panel transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ProgressiveImg thumbSrc={node.referenceUrl} alt="" className="aspect-[4/3] w-full object-cover" />
            </button>
          )}
          <p className="text-callout text-muted">{t("explorer.notYet")}</p>
        </div>
      ) : (
        mosaic.length > 0 && (
          <ul className={`grid gap-1 ${mosaic.length === 1 ? "grid-cols-1" : "grid-cols-3"}`}>
            {mosaic.map((leaf, i) => (
              <li key={leaf.id} className={mosaic.length > 1 && i === 0 ? "col-span-2 row-span-2" : ""}>
                {/* raw-control: the whole photo is the button that opens it full size. */}
                <button
                  type="button"
                  aria-label={t("explorer.openPhoto", { name: label(leaf.node) })}
                  onClick={() =>
                    onOpenPhotos(
                      mosaic.map((m) => m.node),
                      i,
                    )
                  }
                  className="block aspect-square w-full overflow-hidden rounded-control transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${leaf.node.photoId}/thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {!isSpecies && <ProgressRing collected={node.collected} total={node.total} />}
      {node.photos > 0 && (
        <p className="text-callout text-ink">
          {t("explorer.photoCount", { count: node.photos, formatted: formatNumber(node.photos) })}
        </p>
      )}

      {!isSpecies && rarest.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-footnote font-semibold text-ink">{t("explorer.rarest")}</h3>
          <ul className="space-y-1">
            {rarest.slice(0, RAREST).map((leaf) => (
              <li key={leaf.id} className="flex items-baseline justify-between gap-3">
                <Button variant="link" size="sm" onClick={() => onSelect(leaf.id)} className="min-w-0 text-left">
                  <span className="wrap-anywhere">{label(leaf.node)}</span>
                </Button>
                {leaf.node.tier && leaf.node.tier !== "unrated" && (
                  <span className="shrink-0 text-footnote text-muted">{tierLabel(leaf.node.tier)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        {node.speciesId && (
          <Link
            to={`/species/${node.speciesId}`}
            state={backStateFor(location, t)}
            className={buttonClasses("secondary", "sm")}
          >
            {t("explorer.openSpecies")}
          </Link>
        )}
        {onRandom && (
          <Button variant="secondary" size="sm" onClick={onRandom}>
            {t("explorer.random")}
          </Button>
        )}
      </div>
    </div>
  );
}
