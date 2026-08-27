import { Link } from "react-router-dom";
import type { TripSummary } from "@lifer/shared";
import { useFitText } from "../hooks/useFitText";
import { cropToImageStyle } from "../lib/crop";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";

function formatDateRange(earliest: string | null, latest: string | null): string | null {
  if (!earliest) return null;
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short" };
  const start = new Date(earliest).toLocaleDateString(undefined, opts);
  if (!latest || latest === earliest) return start;
  const end = new Date(latest).toLocaleDateString(undefined, opts);
  return start === end ? start : `${start} – ${end}`;
}

// Mirrors SpeciesCard.tsx's shape (cover image block, useFitText title, badge row) — swaps
// species-specific badges (tier/endemic/vagrant) for trip-relevant ones (date range, species
// count), since those concepts don't apply here.
export default function TripCard({ trip }: { trip: TripSummary }) {
  const { ref: nameRef, fontSize: nameFontSize } = useFitText([trip.name]);
  const dateRange = formatDateRange(trip.earliestTakenAt, trip.latestTakenAt);

  return (
    <Link
      to={`/trips/${trip.id}`}
      className="group block overflow-hidden rounded-lg border border-line bg-surface transition hover:shadow-md"
    >
      <div className="relative aspect-square overflow-hidden bg-surface-muted">
        {trip.processing ? (
          // A scan or import is running — the cover photo may not exist yet, or is about to
          // change, so a spinner reads more honestly here than a placeholder or a stale image.
          <div className="flex h-full w-full items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
          </div>
        ) : trip.coverPhotoUrl ? (
          <ProgressiveImg
            thumbSrc={trip.coverPhotoUrl}
            fullSrc={trip.coverPhotoUrl.replace(/\/thumb$/, "/display")}
            alt={trip.name}
            className="h-full w-full"
            style={cropToImageStyle(trip.coverCropX, trip.coverCropY, trip.coverCropSize)}
          />
        ) : (
          <PhotoPlaceholder className="h-full w-full" />
        )}
      </div>
      <div className="p-3">
        <p ref={nameRef} className="overflow-hidden font-medium leading-tight text-ink" style={{ fontSize: nameFontSize }}>
          {trip.name}
        </p>
        {dateRange && <p className="truncate text-xs text-muted">{dateRange}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
            {trip.speciesCount} species
          </span>
          <span className="inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
            {trip.captureCount} photo{trip.captureCount === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </Link>
  );
}
