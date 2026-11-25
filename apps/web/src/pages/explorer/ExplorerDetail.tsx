// The Tree of life's detail pane: the selected group or species, every photographed species in it
// (rarest first, scrolling, 30 at a time), how much of it you have, its rarest finds, its Targets and
// Seen marks, and ways onward. The parent keys it by id, so a new pick starts at the first page.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import Button from "../../components/Button";
import ProgressiveImg from "../../components/ProgressiveImg";
import type { MenuAction } from "../../components/Menu";
import { buttonClasses } from "../../lib/buttonClasses";
import { backStateFor } from "../../lib/backLabel";
import { formatNumber } from "../../lib/format";
import { tierLabel } from "../../lib/speciesGroups";
import MarkCounts from "./MarkCounts";
import RarityChip from "./RarityChip";
import { ancestorIds, collectedLeaves, rarestFirst, shownTier, type TreeIndex, type TreeNode } from "./treeModel";

const PAGE = 30;
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
  onFocusGroup,
  onOpenPhotos,
  marks,
  rarity,
  regionName,
  preview = false,
}: {
  index: TreeIndex;
  id: string;
  label: (node: TreeNode) => string;
  onSelect: (id: string) => void;
  /** Re-roots the tree at this group; null when it already is the root or is a species. */
  onFocusGroup: (() => void) | null;
  /** Opens the viewer on these species' best photos at `start`. */
  onOpenPhotos: (nodes: TreeNode[], start: number) => void;
  /** Add to targets, mark as seen and their reverses, for this species or the species shown under this group. */
  marks: MenuAction[];
  /** Show the rarity line, as the View option does on the tree. */
  rarity: boolean;
  /** The picked region, which a species' local tier is named after. */
  regionName: string | null;
  /** Shown for the arc or row the pointer rests on, not the selection: read-only, and says so. */
  preview?: boolean;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [shown, setShown] = useState(PAGE);
  const entry = index.byId.get(id);
  if (!entry) return null;
  const { node } = entry;
  const isSpecies = node.rank === "species";
  const leaves = collectedLeaves(index, id);
  const rarest = rarestFirst(leaves);
  const withPhotos = rarest.filter((l) => l.node.photoId);
  const mosaic = withPhotos.slice(0, shown);
  const more = withPhotos.length - mosaic.length;
  const crumbs = ancestorIds(index, id);
  const rated = (tier: string | null | undefined): tier is string => !!tier && tier !== "unrated";
  // As on species cards: the local tier leads, named after the region; the worldwide one follows
  // only when it differs.
  const tier = isSpecies ? shownTier(node) : null;
  const local = rated(tier) && regionName && tier !== node.tier ? tier : null;
  const tierText = local
    ? t("explorer.rarity.local", { tier: tierLabel(local), place: regionName })
    : rated(tier)
      ? tierLabel(tier)
      : null;

  return (
    <div className="space-y-4" inert={preview}>
      {preview && <p className="text-caption font-semibold text-muted uppercase">{t("explorer.preview")}</p>}
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
        {tierText && (
          <p className="text-footnote text-muted">{rarity ? <RarityChip node={node} text={tierText} /> : tierText}</p>
        )}
        {local && rated(node.tier) && (
          <p className="text-footnote text-muted">{t("explorer.rarity.worldwide", { tier: tierLabel(node.tier) })}</p>
        )}
        {rarity && !isSpecies && (
          <p className="mt-1">
            <RarityChip node={node} />
          </p>
        )}
        {(node.targetCount > 0 || node.seenCount > 0) && (
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <MarkCounts node={node} />
          </p>
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
          // Scrolls inside the pane, so the counts and actions below stay in reach.
          <div className="max-h-[28rem] overflow-y-auto">
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
            {more > 0 && (
              <Button variant="link" size="sm" onClick={() => setShown(shown + PAGE)} className="mt-2">
                {t("explorer.showMorePhotos", {
                  count: Math.min(more, PAGE),
                  formatted: formatNumber(Math.min(more, PAGE)),
                })}
              </Button>
            )}
          </div>
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
                {rated(shownTier(leaf.node)) && (
                  <span className="shrink-0 text-footnote text-muted">{tierLabel(shownTier(leaf.node)!)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={`flex flex-wrap gap-2 ${preview ? "opacity-50" : ""}`}>
        {node.speciesId && (
          <Link
            to={`/species/${node.speciesId}`}
            state={backStateFor(location, t)}
            className={buttonClasses("secondary", "sm")}
          >
            {t("explorer.openSpecies")}
          </Link>
        )}
        {onFocusGroup && (
          <Button variant="secondary" size="sm" onClick={onFocusGroup}>
            {t("explorer.focus")}
          </Button>
        )}
      </div>
      {marks.length > 0 && (
        <div className={`flex flex-wrap gap-2 ${preview ? "opacity-50" : ""}`}>
          {marks.map((m) => (
            <Button key={m.label} variant="secondary" size="sm" onClick={m.onSelect}>
              {m.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
