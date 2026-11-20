import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isTripActive, localIsoDate } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import RegionBrowser from "../../components/RegionBrowser";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { useTripDates } from "../../lib/tripDates";
import type { TripDetail } from "./types";
import TextField from "../../components/TextField";

type DatesPatch = Partial<Pick<TripDetail, "startDate" | "endDate" | "regionId" | "activeOverride">>;

// The trip's dates and whether it's active, which decides where the import screen files new
// photos. The user ends it, marks it inactive or active again, or edits its dates and region.
export default function TripDatesBar({ trip, onChanged }: { trip: TripDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const tripDates = useTripDates();
  const [editing, setEditing] = useState(false);
  const [startDate, setStartDate] = useState(trip.startDate ?? localIsoDate());
  const [endDate, setEndDate] = useState(trip.endDate ?? "");
  const [regionId, setRegionId] = useState(trip.regionId);
  const today = localIsoDate();
  const active = isTripActive(trip, today);

  async function save(patch: DatesPatch) {
    try {
      await api.patch(apiPath("/trips/{id}", { id: trip.id }), patch);
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, t("trips.active.saveFailed")));
    }
  }

  // Ending a trip that hasn't started yet can't set an end before its start: it's marked inactive.
  const end = () =>
    save(
      trip.startDate && trip.startDate > today ? { activeOverride: false } : { endDate: today, activeOverride: null },
    );

  if (editing) {
    return (
      <div className="mt-2 max-w-md space-y-2 text-callout">
        <div className="flex gap-3">
          <label className="flex-1 text-ink">
            {t("trips.start.startDate")}
            <TextField
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1"
            />
          </label>
          <label className="flex-1 text-ink">
            {t("trips.start.endDate")}
            <TextField
              type="date"
              min={startDate}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1"
            />
          </label>
        </div>
        <div>
          <p className="text-ink">{t("trips.start.region")}</p>
          <RegionBrowser regionId={regionId} onChange={setRegionId} />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!startDate}
            onClick={() => void save({ startDate, endDate: endDate || null, regionId })}
          >
            {t("common.save")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-muted">
      {active && (
        <span className="rounded-badge bg-accent px-1 font-medium text-accent-fg">{t("trips.active.badge")}</span>
      )}
      <span>{trip.startDate ? tripDates(trip.startDate, trip.endDate) : t("trips.dates.none")}</span>
      <Button variant="link" size="sm" onClick={() => setEditing(true)}>
        {trip.startDate ? t("trips.dates.edit") : t("trips.dates.set")}
      </Button>
      {active ? (
        <>
          {!trip.endDate || trip.endDate > today ? (
            <Button variant="link" size="sm" onClick={() => void end()}>
              {t("trips.active.end")}
            </Button>
          ) : null}
          <Button variant="link" size="sm" onClick={() => void save({ activeOverride: false })}>
            {t("trips.active.markInactive")}
          </Button>
        </>
      ) : (
        <Button variant="link" size="sm" onClick={() => void save({ activeOverride: true })}>
          {t("trips.active.markActive")}
        </Button>
      )}
    </div>
  );
}
