import { useState } from "react";
import ProgressiveImg from "../../components/ProgressiveImg";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import Checkbox from "../../components/Checkbox";
import Modal from "../../components/Modal";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { useApiRoute } from "../../lib/resource";
import { useSpeciesName } from "../../lib/speciesName";
import { useTripDates } from "../../lib/tripDates";
import type { TripDetail } from "./types";

// Photos taken during the trip that are in no trip: suggested, never added on their own. The user
// adds some or all, or dismisses them, and a dismissed photo isn't suggested for this trip again.
export default function TripSuggestions({ trip, onChanged }: { trip: TripDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const tripDates = useTripDates();
  // The page remounts this when the trip's dates change, so it asks again.
  const suggestions = useApiRoute(trip.startDate ? apiPath("/trips/{id}/suggestions", { id: trip.id }) : null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const items = suggestions.data?.items ?? [];
  if (!trip.startDate || items.length === 0) return null;

  async function act(add: boolean) {
    const captureIds = [...selected];
    setBusy(true);
    try {
      if (add) await api.post(apiPath("/trips/{id}/captures", { id: trip.id }), { captureIds });
      else await api.post(apiPath("/trips/{id}/suggestions/dismiss", { id: trip.id }), { captureIds });
      setSelected(new Set());
      await suggestions.reload();
      if (add) onChanged();
      toast.success(
        add
          ? t("trips.suggestions.added", { count: captureIds.length })
          : t("trips.suggestions.dismissed", { count: captureIds.length }),
      );
      // Some still to decide keeps the dialog open on them.
      if (captureIds.length === items.length) setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err, t("trips.suggestions.failed")));
    } finally {
      setBusy(false);
    }
  }

  const allSelected = selected.size === items.length;
  return (
    <>
      <p role="status" className="text-callout text-ink">
        {t("trips.suggestions.note", {
          count: items.length,
          name: trip.name,
          dates: tripDates(trip.startDate, trip.endDate),
        })}{" "}
        <Button variant="link" onClick={() => setOpen(true)} className="font-medium text-ink underline">
          {t("trips.suggestions.review")}
        </Button>
      </p>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        size="lg"
        title={t("trips.suggestions.title", { name: trip.name })}
        footer={
          <>
            <Button variant="secondary" disabled={busy || selected.size === 0} onClick={() => void act(false)}>
              {t("trips.suggestions.dismiss", { count: selected.size })}
            </Button>
            <Button loading={busy} disabled={selected.size === 0} onClick={() => void act(true)}>
              {t("trips.suggestions.add", { count: selected.size })}
            </Button>
          </>
        }
      >
        <Checkbox
          checked={allSelected}
          indeterminate={selected.size > 0 && !allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.captureId)))}
          className="mb-3"
        >
          {t("trips.suggestions.selectAll")}
        </Checkbox>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {items.map((item) => {
            const checked = selected.has(item.captureId);
            return (
              <li key={item.captureId}>
                <label className="block cursor-pointer text-footnote">
                  <span className="relative block aspect-square overflow-hidden rounded-control bg-surface-muted">
                    {item.photoId && (
                      <ProgressiveImg
                        thumbSrc={`/api/photos/${item.photoId}/thumb`}
                        fullSrc={`/api/photos/${item.photoId}/thumb`}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                    {/* raw-control: the photo tile is this checkbox's label, so it sits over the photo */}
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) next.delete(item.captureId);
                          else next.add(item.captureId);
                          return next;
                        })
                      }
                      className="absolute left-1.5 top-1.5 h-4 w-4"
                    />
                  </span>
                  <span className="mt-1 block truncate text-ink">{speciesName(item)}</span>
                  {item.takenAt && <span className="block text-muted">{formatDate(item.takenAt)}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </Modal>
    </>
  );
}
