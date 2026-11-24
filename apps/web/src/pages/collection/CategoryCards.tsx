import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CollectionItem } from "@lifer/shared";
import MediaCard from "../../components/MediaCard";
import PhotoPlaceholder from "../../components/PhotoPlaceholder";
import { cardImageSrc } from "../../lib/cardImage";
import { formatNumber } from "../../lib/format";
import { taxonFilterLabel } from "./taxonLabels";
import { summarizeCategories, type CategorySummary } from "./categorySummary";

// The last summary per list without an animal filter, so the row keeps every group (and a way back
// out) while one is picked. Module scope: it outlives a visit to a species page.
const unfilteredSummaries = new Map<string, CategorySummary[]>();

/** Animal group cards over the Collection: your progress in each, a click filters to it. */
export default function CategoryCards({
  items,
  available,
  active,
  listKey,
  namingStyles,
  onToggle,
}: {
  items: CollectionItem[];
  /** The animal filters the page offers (installed groups only). */
  available: string[];
  active: ReadonlySet<string>;
  /** The list apart from its animal filter (region, sea zones...). */
  listKey: string;
  namingStyles: string[];
  onToggle: (taxon: string) => void;
}) {
  const { t } = useTranslation();
  const summaries = useMemo(() => {
    const fresh = summarizeCategories(items, available);
    if (active.size === 0) {
      unfilteredSummaries.set(listKey, fresh);
      return fresh;
    }
    // The picked groups' numbers are live; the others are as last seen unfiltered.
    const live = new Map(fresh.map((s) => [s.taxon, s]));
    const kept = unfilteredSummaries.get(listKey);
    return kept ? kept.map((s) => live.get(s.taxon) ?? s) : fresh;
  }, [items, available, active, listKey]);

  // One group is the page itself; a card for it would only repeat the header (A1).
  if (summaries.length < 2) return null;
  return (
    <div
      role="group"
      aria-label={t("collection.categories.label")}
      className="-mx-1 mb-section flex gap-item overflow-x-auto px-1 pb-1 pt-1"
    >
      {summaries.map((s) => {
        const label = taxonFilterLabel(s.taxon, namingStyles);
        const src = s.cover && cardImageSrc(s.cover, 416);
        return (
          <MediaCard
            key={s.taxon}
            className="w-52 shrink-0"
            layout="overlay"
            mediaClassName={`aspect-[4/3] ${s.own ? "" : "cover-uncollected"}`}
            media={
              src ? (
                // dead-thumb-ok: the card is a filter button, not a photo.
                <img
                  src={src}
                  alt=""
                  decoding="async"
                  className="h-full w-full object-cover"
                  style={
                    s.own
                      ? undefined
                      : { objectPosition: `${s.cover?.referenceFocalX ?? 50}% ${s.cover?.referenceFocalY ?? 50}%` }
                  }
                />
              ) : (
                <PhotoPlaceholder className="h-full w-full" />
              )
            }
            title={label}
            titleClassName="text-headline"
            lines={[
              <p key="n" className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-display font-bold tabular-nums">{formatNumber(s.collected)}</span>
                <span className="text-footnote opacity-85">
                  {t("collection.breadcrumb.ofTotal", { total: formatNumber(s.total) })}
                </span>
              </p>,
            ]}
            selected={active.has(s.taxon)}
            renderBody={({ className, children }) => (
              // raw-control: the whole card is the filter toggle, as the animal pills are.
              <button
                type="button"
                aria-pressed={active.has(s.taxon)}
                onClick={() => onToggle(s.taxon)}
                className={className}
              >
                {children}
              </button>
            )}
          />
        );
      })}
    </div>
  );
}
