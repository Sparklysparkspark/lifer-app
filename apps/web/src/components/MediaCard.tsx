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
// design-token: the scrim under names on a photo-filled card; dark in both themes so white text reads over any photo.
const SCRIM = "bg-linear-to-t from-black/85 via-black/55 to-transparent text-white";
// The photo count: the overlay pill's look, but as wide as its number.
const COUNT_PILL =
  // design-token: the dark overlay pill over a photo, as OVERLAY_PILL.
  "pointer-events-none inline-flex h-5 min-w-7 items-center justify-center rounded-full bg-black/40 px-1.5 text-footnote font-medium leading-none tabular-nums text-white";

export default function MediaCard({
  media,
  mediaClassName = "aspect-square",
  title,
  titleClassName = "",
  lines = [],
  badge,
  footer,
  titleLines,
  textClassName = "",
  compact = false,
  selected = false,
  markLabel,
  actions,
  mediaOverlay,
  layout = "stacked",
  count,
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
  /** Status or actions pinned to the card's bottom, so they line up across a row whatever the
   *  title and lines above them take. */
  footer?: ReactNode;
  /** Reserves this many title lines, so cards in a row keep one shape (clamp the title to match). */
  titleLines?: 1 | 2;
  /** Dims or otherwise styles the text block. */
  textClassName?: string;
  /** The smallest card sizes: a tighter text block. */
  compact?: boolean;
  selected?: boolean;
  /** Shows the select tick with this name. */
  markLabel?: string;
  /** The top-right overlay row (Preview, the ⋯ menu); outside the body so it's never nested in it. */
  actions?: ReactNode;
  /** Controls laid over the media box (outside the body, so never nested in it); positioned like the media. */
  mediaOverlay?: ReactNode;
  /** "overlay": the media fills the card and the text sits on a scrim at its bottom. */
  layout?: "stacked" | "overlay";
  /** A number pill at the top right (a photo count), after the actions; its label names what it counts. */
  count?: { value: string; label: string };
  /** The interactive element (a Link, button or option) given the card's class and content. */
  renderBody: (props: { className: string; children: ReactNode }) => ReactNode;
  as?: "div" | "li";
  className?: string;
}) {
  const hasText = title != null;
  const overlay = layout === "overlay";
  const text = hasText && (
    <div
      className={
        overlay
          ? `absolute inset-x-0 bottom-0 flex flex-col gap-0.5 px-3 pb-2.5 pt-10 ${SCRIM} ${textClassName}`
          : `flex flex-1 flex-col ${compact ? "gap-0 px-1.5 py-1" : "gap-0.5 p-3"} ${textClassName}`
      }
    >
      <p
        className={`break-words leading-tight ${overlay ? "font-semibold" : `font-medium text-ink ${titleLines === 2 ? "min-h-[2lh]" : ""}`} ${titleClassName}`}
      >
        {title}
      </p>
      {lines.map((line, i) =>
        !line ? null : typeof line === "string" ? (
          <p key={i} className={`break-words text-footnote ${overlay ? "opacity-85" : "text-muted"}`}>
            {line}
          </p>
        ) : (
          <div key={i}>{line}</div>
        ),
      )}
      {badge && <div className={compact ? "mt-0.5" : "mt-1"}>{badge}</div>}
      {footer != null && footer !== false && <div className="mt-auto pt-1">{footer}</div>}
    </div>
  );
  const content = (
    <>
      <div
        className={`relative w-full shrink-0 overflow-hidden ${overlay ? "bg-media" : "bg-surface-muted"} ${
          hasText && !overlay ? MEDIA_ROUND_TOP : MEDIA_ROUND_ALL
        } ${mediaClassName}`}
      >
        {media}
        {overlay && text}
      </div>
      {!overlay && text}
    </>
  );
  return (
    <Tag className={`group relative ${className}`} role={Tag === "li" ? "none" : undefined}>
      {renderBody({ className: `${FRAME} ${selected ? CARD_SELECTED : "border-line"}`, children: content })}
      {mediaOverlay && (
        <div className={`pointer-events-none absolute inset-x-px top-px ${mediaClassName}`}>{mediaOverlay}</div>
      )}
      {markLabel !== undefined && <SelectMark checked={selected} label={markLabel} />}
      {(actions || count) && (
        <div className="absolute right-2 top-1.5 flex items-center gap-1">
          {actions}
          {count && (
            <span className={COUNT_PILL} role="img" aria-label={count.label}>
              {count.value}
            </span>
          )}
        </div>
      )}
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

/** A photo filling its box, or the empty fill when there is none; dimmed when left out. `src` is
 *  a picture from elsewhere (an iNaturalist photo) for when there is no library photo. */
export function Thumb({
  photoId,
  src,
  dim = false,
  className = "",
}: {
  photoId: string | null;
  src?: string | null;
  dim?: boolean;
  className?: string;
}) {
  const look = `h-full w-full object-cover ${dim ? "opacity-35 grayscale" : ""}`;
  const thumbSrc = photoId ? `/api/photos/${photoId}/thumb` : src;
  return (
    <div className={`overflow-hidden bg-surface-muted ${className}`}>
      {thumbSrc && <ProgressiveImg thumbSrc={thumbSrc} alt="" className={look} />}
    </div>
  );
}

export type MosaicPhoto = { id: string; photoId: string | null; src?: string | null; dim?: boolean };
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
          <Thumb photoId={p.photoId} src={p.src} dim={p.dim} className="absolute inset-0" />
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
