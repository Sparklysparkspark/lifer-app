import { Link } from "react-router-dom";
import type { RefObject } from "react";
import type { TripSummary } from "@lifer/shared";
import { useFitText } from "../hooks/useFitText";
import CoverImage from "./CoverImage";
import DotMenu from "./DotMenu";
import InlineSpinner from "./InlineSpinner";
import { formatDate } from "../lib/format";
import { pluralize } from "../lib/pluralize";
import { MENU_ITEM, MENU_ITEM_DANGER, MENU_PANEL, MENU_SEPARATOR } from "../lib/menuClasses";

function formatDateRange(earliest: string | null, latest: string | null): string | null {
  const start = formatDate(earliest, "monthYear");
  if (!start) return null;
  const end = formatDate(latest, "monthYear");
  return !end || start === end ? start : `${start} – ${end}`;
}

// Same shape as SpeciesCard, with trip badges (date range, counts) instead of species ones.
interface TripCardProps {
  trip: TripSummary;
  menuOpen?: boolean;
  onToggleMenu?: () => void;
  menuRef?: RefObject<HTMLDivElement | null>;
  onRename?: () => void;
  onDelete?: () => void;
}

export default function TripCard({ trip, menuOpen, onToggleMenu, menuRef, onRename, onDelete }: TripCardProps) {
  const { ref: nameRef, fontSize: nameFontSize } = useFitText([trip.name]);
  const dateRange = formatDateRange(trip.earliestTakenAt, trip.latestTakenAt);

  return (
    <Link
      to={`/trips/${trip.id}`}
      className="group block overflow-hidden rounded-lg border border-line bg-surface transition hover:shadow-md"
    >
      <div className="relative aspect-square overflow-hidden bg-surface-muted">
        {onToggleMenu && (
          <DotMenu open={!!menuOpen} onToggle={onToggleMenu} menuRef={menuRef}>
            <div className={`absolute right-0 top-full z-10 mt-1 w-36 ${MENU_PANEL}`}>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleMenu();
                  onRename?.();
                }}
                className={MENU_ITEM}
              >
                Rename
              </button>
              <div className={MENU_SEPARATOR} />
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleMenu();
                  onDelete?.();
                }}
                className={MENU_ITEM_DANGER}
              >
                Delete
              </button>
            </div>
          </DotMenu>
        )}
        {trip.processing ? (
          // A scan or import is running, so the cover may not exist yet or is about to change.
          <div className="flex h-full w-full items-center justify-center">
            <InlineSpinner size="md" label="Processing" />
          </div>
        ) : (
          <CoverImage
            layout={trip.coverLayout}
            coverPhotoUrl={trip.coverPhotoUrl}
            cropX={trip.coverCropX}
            cropY={trip.coverCropY}
            cropSize={trip.coverCropSize}
            quadSlots={trip.quadPhotoIds.map((photoId) =>
              photoId ? { photoId, cropX: null, cropY: null, cropSize: null } : null,
            )}
            alt={trip.name}
          />
        )}
      </div>
      <div className="p-3">
        <p
          ref={nameRef}
          className="overflow-hidden font-medium leading-tight text-ink"
          style={{ fontSize: nameFontSize }}
        >
          {trip.name}
        </p>
        {dateRange && <p className="truncate text-xs text-muted">{dateRange}</p>}
        <p className="text-xs text-muted">
          {trip.speciesCount} species · {pluralize(trip.captureCount, "photo")}
        </p>
      </div>
    </Link>
  );
}
