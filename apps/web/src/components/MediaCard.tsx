import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ProgressiveImg from "./ProgressiveImg";
import SelectMark from "./SelectMark";

// The one card look: species, iNaturalist sightings, trips, albums and import suggestions. See
// docs/plans/shared-card.md; extend this rather than styling a lookalike.

/** The selected card's accent ring: a box shadow, so the card never changes size. */
export const CARD_SELECTED = "border-accent ring-2 ring-accent";

const FRAME =
  "flex h-full w-full flex-col overflow-hidden rounded-panel border bg-surface text-left transition hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// The panel radius minus the 1px border. clip-path too: WebKit leaves an oversized cropped photo's
// corners unclipped by overflow-hidden alone.
const MEDIA_ROUND_TOP =
  "rounded-t-[calc(var(--radius-panel)-1px)] [clip-path:inset(0_round_calc(var(--radius-panel)-1px)_calc(var(--radius-panel)-1px)_0_0)]";
const MEDIA_ROUND_ALL =
  "rounded-[calc(var(--radius-panel)-1px)] [clip-path:inset(0_round_calc(var(--radius-panel)-1px))]";

export default function MediaCard({
  media,
  mediaClassName = "aspect-square",
  title,
  titleClassName = "",
  lines = [],
  badge,
  textClassName = "",
  compact = false,
  selected = false,
  markLabel,
  actions,
  renderBody,
  as: Tag = "div",
  className = "",
}: {
  media: ReactNode;
  /** The media box's aspect and dimming. */
  mediaClassName?: string;
  /** Omitted: just the media, rounded on every corner. */
  title?: ReactNode;
  titleClassName?: string;
  /** Muted lines under the title; empty ones are skipped and elements pass through as they are. */
  lines?: ReactNode[];
  badge?: ReactNode;
  /** Dims or otherwise styles the text block. */
  textClassName?: string;
  /** The smallest card sizes: a tighter text block. */
  compact?: boolean;
  selected?: boolean;
  /** Shows the select tick with this name. */
  markLabel?: string;
  /** The top-right overlay row (Preview, the ⋯ menu); outside the body so it's never nested in it. */
  actions?: ReactNode;
  /** The interactive element (a Link, button or option) given the card's class and content. */
  renderBody: (props: { className: string; children: ReactNode }) => ReactNode;
  as?: "div" | "li";
  className?: string;
}) {
  const hasText = title != null;
  const content = (
    <>
      <div
        className={`relative w-full shrink-0 overflow-hidden bg-surface-muted ${
          hasText ? MEDIA_ROUND_TOP : MEDIA_ROUND_ALL
        } ${mediaClassName}`}
      >
        {media}
      </div>
      {hasText && (
        <div className={`flex flex-1 flex-col ${compact ? "gap-0 px-1.5 py-1" : "gap-0.5 p-3"} ${textClassName}`}>
          <p className={`break-words font-medium leading-tight text-ink ${titleClassName}`}>{title}</p>
          {lines.map((line, i) =>
            !line ? null : typeof line === "string" ? (
              <p key={i} className="break-words text-footnote text-muted">
                {line}
              </p>
            ) : (
              <div key={i}>{line}</div>
            ),
          )}
          {badge && <div className={compact ? "mt-0.5" : "mt-1"}>{badge}</div>}
        </div>
      )}
    </>
  );
  return (
    <Tag className={`group relative ${className}`} role={Tag === "li" ? "none" : undefined}>
      {renderBody({ className: `${FRAME} ${selected ? CARD_SELECTED : "border-line"}`, children: content })}
      {markLabel !== undefined && <SelectMark checked={selected} label={markLabel} />}
      {actions && <div className="absolute right-2 top-1.5 flex items-center gap-1">{actions}</div>}
    </Tag>
  );
}

/** The accent ring for a bare photo (Gallery tile, Trash, photo window). An overlay, because an
 *  inset shadow on the image itself paints underneath it. Its parent must be positioned. */
export function SelectedRing({ radiusPx }: { radiusPx?: number }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-0 ring-2 ring-inset ring-accent ${
        radiusPx == null ? "rounded-control" : ""
      }`}
      style={radiusPx == null ? undefined : { borderRadius: radiusPx }}
    />
  );
}

/** A photo filling its box, or the empty fill when there is none; dimmed when left out. */
export function Thumb({
  photoId,
  dim = false,
  className = "",
}: {
  photoId: string | null;
  dim?: boolean;
  className?: string;
}) {
  const look = `h-full w-full object-cover ${dim ? "opacity-35 grayscale" : ""}`;
  return (
    <div className={`overflow-hidden bg-surface-muted ${className}`}>
      {photoId && <ProgressiveImg thumbSrc={`/api/photos/${photoId}/thumb`} alt="" className={look} />}
    </div>
  );
}

export type MosaicPhoto = { id: string; photoId: string | null; dim?: boolean };
const MOSAIC = 3;

/** The cover plus up to two more, with a count of the rest over the last. Fills its box. */
export function PhotoMosaic({ photos }: { photos: MosaicPhoto[] }) {
  const { t } = useTranslation();
  const mosaic = photos.slice(0, MOSAIC);
  const more = photos.length - mosaic.length;
  return (
    <div className={`grid h-full w-full gap-0.5 ${mosaic.length > 1 ? "grid-cols-3 grid-rows-2" : ""}`}>
      {mosaic.length === 0 && <Thumb photoId={null} className="h-full w-full" />}
      {mosaic.map((p, i) => (
        <div
          key={p.id}
          className={`relative ${
            i === 0 && mosaic.length > 1 ? "col-span-2 row-span-2" : mosaic.length === 2 ? "row-span-2" : ""
          }`}
        >
          <Thumb photoId={p.photoId} dim={p.dim} className="absolute inset-0" />
          {more > 0 && i === mosaic.length - 1 && (
            // design-token: a scrim over photos, like PhotoTile's duration badge, reads the same in both themes.
            <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-footnote font-medium text-white">
              {t("inaturalist.import.morePhotos", { count: more })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
