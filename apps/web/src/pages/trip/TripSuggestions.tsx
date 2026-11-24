import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import Lightbox from "../../components/Lightbox";
import Modal from "../../components/Modal";
import PhotoGrid from "../../components/PhotoGrid";
import { SelectAllLinks } from "../../components/SelectionActionRow";
import { useSelectMode } from "../../hooks/useSelectMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate, metaLine } from "../../lib/format";
import { photoSlide } from "../../lib/photoSlide";
import { useApiRoute } from "../../lib/resource";
import { useSpeciesName } from "../../lib/speciesName";
import { useTripDates } from "../../lib/tripDates";
import type { TripDetail } from "./types";

const EMPTY: never[] = [];
const suggestionId = (item: { captureId: string }) => item.captureId;

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
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const items = suggestions.data?.items ?? EMPTY;
  // Always selecting: ticking is what this list is for. A reload drops ids no longer suggested.
  const select = useSelectMode(items, suggestionId, true, { pruneToItems: true });
  const selected = select.selectedIds;
  if (!trip.startDate || items.length === 0) return null;

  async function act(add: boolean) {
    const captureIds = [...selected];
    setBusy(true);
    try {
      if (add) await api.post(apiPath("/trips/{id}/captures", { id: trip.id }), { captureIds });
      else await api.post(apiPath("/trips/{id}/suggestions/dismiss", { id: trip.id }), { captureIds });
      select.clear();
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

  const withPhoto = items.filter((i) => i.photoId);
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
        footerStart={
          <Button variant="secondary" disabled={busy || selected.size === 0} onClick={() => void act(false)}>
            {t("trips.suggestions.dismiss", { count: selected.size })}
          </Button>
        }
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button loading={busy} disabled={selected.size === 0} onClick={() => void act(true)}>
              {t("trips.suggestions.add", { count: selected.size })}
            </Button>
          </>
        }
      >
        <div className="mb-3 flex gap-3">
          <SelectAllLinks
            count={selected.size}
            total={items.length}
            onSelectAll={() => select.setSelectedIds(new Set(items.map(suggestionId)))}
            onDeselectAll={select.clear}
          />
        </div>
        <PhotoGrid
          items={items}
          idFor={suggestionId}
          tileFor={(item) => ({ photoId: item.photoId, alt: speciesName(item) })}
          columnWidth={160}
          select={select}
          onOpen={() => {}}
          // One line per tile, so rows stay even; View opens the photo full size before adding it.
          renderLabel={(item) => (
            <div className="mt-1 flex items-baseline gap-2 text-footnote">
              <span className="min-w-0 flex-1 truncate text-muted">
                {metaLine([speciesName(item), item.takenAt && formatDate(item.takenAt)])}
              </span>
              {item.photoId && (
                <Button variant="link" size="sm" onClick={() => setViewing(withPhoto.indexOf(item))}>
                  {t("common.view")}
                </Button>
              )}
            </div>
          )}
        />
      </Modal>
      {viewing !== null && (
        <Lightbox
          slides={withPhoto.map((item) =>
            photoSlide({ photoId: item.photoId!, captureId: null }, { caption: speciesName(item) }),
          )}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
