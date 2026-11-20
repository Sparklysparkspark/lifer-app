import { Link } from "react-router-dom";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { isTripActive, localIsoDate, type TripSummary } from "@lifer/shared";
import CoverImage from "./CoverImage";
import MediaCard from "./MediaCard";
import Menu, { MenuItem, MenuPanel, MenuSeparator } from "./Menu";
import InlineSpinner from "./InlineSpinner";
import { formatDate } from "../lib/format";
import { useTripDates } from "../lib/tripDates";

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
  /** Router state for the card's link, so the trip's back link names the page it came from. */
  linkState?: unknown;
}

export default function TripCard({
  trip,
  menuOpen,
  onToggleMenu,
  menuRef,
  onRename,
  onDelete,
  linkState,
}: TripCardProps) {
  const { t } = useTranslation();
  const tripDates = useTripDates();
  // The dates the user gave the trip, else when its photos were taken.
  const dateRange = trip.startDate
    ? tripDates(trip.startDate, trip.endDate)
    : formatDateRange(trip.earliestTakenAt, trip.latestTakenAt);
  const active = isTripActive(trip, localIsoDate());

  return (
    <MediaCard
      media={
        trip.processing ? (
          // A scan or import is running, so the cover may not exist yet or is about to change.
          <div className="flex h-full w-full items-center justify-center">
            <InlineSpinner size="md" label={t("trips.card.processing")} />
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
        )
      }
      title={<span title={trip.name}>{trip.name}</span>}
      titleClassName="line-clamp-2"
      lines={[
        (dateRange || active) && (
          <p key="dates" className="truncate text-footnote text-muted">
            {active && (
              <span className="mr-1.5 rounded-badge bg-accent px-1 font-medium text-accent-fg">
                {t("trips.active.badge")}
              </span>
            )}
            {dateRange}
          </p>
        ),
        t("trips.card.counts", { species: trip.speciesCount, photos: trip.captureCount }),
      ]}
      actions={
        onToggleMenu && (
          <Menu open={!!menuOpen} onToggle={onToggleMenu} menuRef={menuRef} className="relative">
            <MenuPanel className="w-36">
              <MenuItem onSelect={() => onRename?.()}>{t("common.rename")}</MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => onDelete?.()}>
                {t("common.delete")}
              </MenuItem>
            </MenuPanel>
          </Menu>
        )
      }
      renderBody={(props) => <Link to={`/trips/${trip.id}`} state={linkState} {...props} />}
    />
  );
}
