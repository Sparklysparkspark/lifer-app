import ProgressiveImg from "../../components/ProgressiveImg";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import SpeciesPicker from "../../components/SpeciesPicker";
import RegionBrowser from "../../components/RegionBrowser";
import ImportReviewRow from "../../components/importReview/ImportReviewRow";
import ImportCompareView from "../../components/importReview/ImportCompareView";
import Button from "../../components/Button";
import type { TripScanImport } from "./useTripScanImport";
import CullMarksChoice from "../../components/importReview/CullMarksChoice";
import { rejectedRowNote } from "../../lib/cullInfo";
import Panel from "../../components/Panel";

function rowStatusText(status: string, error: string | undefined, t: TFunction): string | undefined {
  return status === "done"
    ? t("trips.scanReview.imported")
    : status === "error"
      ? error
      : status === "importing"
        ? t("trips.scanReview.importing")
        : "";
}

// What a scan found that isn't imported yet: pick a species for each (or several at once), an
// optional region for the batch, then import.
export default function TripScanReview({
  tripId,
  destinationFolder,
  suggestEnabled,
  jobs,
}: {
  tripId: string | undefined;
  destinationFolder: string;
  suggestEnabled: boolean;
  jobs: TripScanImport;
}) {
  const { t } = useTranslation();
  const { reviewRows, readyCount, notWildlifeCount, review, reviewRegionId, importing, cullOption } = jobs;
  const { selected, bulkKeys, toggleSelected, focusedRowKey, setFocusedRowKey, activeRow, highlightIndex } = review;

  return (
    <Panel as="section" className="space-y-3">
      <div className="flex items-center gap-3 text-callout text-muted">
        <span>
          {t("trips.scanReview.summary", { count: reviewRows.length, ready: readyCount })}
          {notWildlifeCount > 0 && ` · ${t("trips.scanReview.notWildlife", { count: notWildlifeCount })}`}
        </span>
        {bulkKeys.length > 0 && (
          <div className="flex items-center gap-2">
            <span>{t("trips.scanReview.assignSelected", { count: bulkKeys.length })}</span>
            <div className="w-56">
              <SpeciesPicker
                placeholder={t("species.selection.typeSpecies")}
                regionId={reviewRegionId}
                onSelect={(r) => review.assignSpecies(bulkKeys, r)}
              />
            </div>
          </div>
        )}
        <Button size="sm" onClick={jobs.importReady} disabled={importing || readyCount === 0} className="ml-auto">
          {importing
            ? t("trips.scanReview.importing")
            : readyCount
              ? t("trips.scanReview.importCount", { count: readyCount })
              : t("trips.scanReview.importPhotos")}
        </Button>
      </div>
      <CullMarksChoice
        total={jobs.scannedCount}
        rejected={jobs.cullRejected}
        value={cullOption}
        onChange={jobs.selectCullOption}
        disabled={importing}
      />
      <div>
        <p className="mb-1 text-callout text-muted">
          {suggestEnabled ? t("trips.scanReview.regionForSuggestions") : t("trips.scanReview.batchLocation")}
        </p>
        <RegionBrowser regionId={reviewRegionId} onChange={jobs.selectReviewRegion} allowAnyRegion={!suggestEnabled} />
        {suggestEnabled && !reviewRegionId && (
          <p className="mt-1 text-footnote text-muted">{t("trips.scanReview.pickRegion")}</p>
        )}
      </div>
      <p className="text-footnote text-muted">{t("trips.scanReview.copiedTo", { folder: destinationFolder })}</p>

      <div className="divide-y divide-line border-t border-line">
        {reviewRows.map((row) => (
          <ImportReviewRow
            key={row.key}
            row={row}
            name={row.key}
            preview={
              <ProgressiveImg
                thumbSrc={`/api/trips/${tripId}/scan-preview?file=${encodeURIComponent(row.key)}`}
                fullSrc={`/api/trips/${tripId}/scan-preview?file=${encodeURIComponent(row.key)}`}
                alt=""
                className="h-14 w-14 rounded-badge object-cover"
              />
            }
            status={
              <span className="text-footnote text-muted">
                {rowStatusText(row.status, row.error, t) || rejectedRowNote(row, cullOption)}
              </span>
            }
            removable={row.status !== "importing" && row.status !== "done"}
            onRemove={() => jobs.removeReviewRow(row.key)}
            removeLabel={t("trips.scanReview.removeRow")}
            selected={selected.has(row.key)}
            onToggleSelected={() => toggleSelected(row.key)}
            focused={focusedRowKey === row.key}
            onFocus={() => setFocusedRowKey(row.key)}
            regionId={reviewRegionId}
            onPick={(r) => review.assignAndAdvance(row.key, r)}
            isActive={row.key === activeRow?.key}
            highlightIndex={highlightIndex}
            onDismissWarning={(warning) => review.dismissWarning(row.key, warning)}
            onCompare={(speciesId) => review.openCompare(row.key, speciesId)}
            onNoAnimal={() => review.markNoAnimal([row.key])}
          />
        ))}
      </div>
      {review.compare && (
        <ImportCompareView
          rows={reviewRows}
          target={review.compare}
          regionId={reviewRegionId}
          photoUrl={(r) => `/api/trips/${tripId}/scan-preview?file=${encodeURIComponent(r.key)}`}
          nameOf={(r) => r.key}
          onConfirm={(keys, species) =>
            keys.length === 1 ? review.assignAndAdvance(keys[0], species) : review.assignSpecies(keys, species)
          }
          onNoAnimal={review.markNoAnimal}
          onClose={review.closeCompare}
        />
      )}
    </Panel>
  );
}
