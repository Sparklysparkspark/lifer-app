import { useTranslation } from "react-i18next";
import Button from "../Button";
import { formatDateSpan, formatNumber } from "../../lib/format";

export interface OfferedTrip {
  id: string;
  name: string;
  from: string;
  to: string;
}

// A day's photos that look like part of a trip the batch isn't going into: Lifer asks, the user
// decides. Once added, the group says so with a way back out before importing.
export default function ImportTripNote({
  count,
  trips,
  chosen,
  onAdd,
  onRemove,
  onDismiss,
}: {
  count: number;
  /** One or two trips that fit (POST /trips/import-suggestions). */
  trips: OfferedTrip[];
  /** The trip these photos are marked for, if any. */
  chosen: OfferedTrip | null;
  onAdd: (tripId: string) => void;
  onRemove: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const n = { count, formatted: formatNumber(count) };
  if (chosen)
    return (
      <p className="mb-2 flex flex-wrap items-center gap-x-2 text-callout text-muted" data-trip-note>
        <span className="min-w-0 break-words">{t("import.tripFit.added", { ...n, name: chosen.name })}</span>
        <Button variant="link" size="sm" onClick={onRemove}>
          {t("import.tripFit.remove")}
        </Button>
      </p>
    );
  if (trips.length === 0) return null;
  const [only] = trips;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-callout" data-trip-note>
      <span className="min-w-0 break-words text-ink">
        {trips.length === 1
          ? t("import.tripFit.one", { ...n, name: only.name, dates: formatDateSpan(only.from, only.to) })
          : t("import.tripFit.several", n)}
      </span>
      {trips.length === 1 ? (
        <Button variant="secondary" size="sm" onClick={() => onAdd(only.id)}>
          {t("import.tripFit.add")}
        </Button>
      ) : (
        trips.map((trip) => (
          <Button key={trip.id} variant="secondary" size="sm" onClick={() => onAdd(trip.id)}>
            {t("import.tripFit.addTo", { name: trip.name, dates: formatDateSpan(trip.from, trip.to) })}
          </Button>
        ))
      )}
      <Button variant="link" size="sm" onClick={onDismiss}>
        {t("import.tripFit.notNow")}
      </Button>
    </div>
  );
}
