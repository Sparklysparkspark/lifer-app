import type { ReactNode } from "react";
import SpeciesPicker from "../../components/SpeciesPicker";
import RegionBrowser from "../../components/RegionBrowser";
import ImportReviewRow from "../../components/importReview/ImportReviewRow";
import Button from "../../components/Button";
import { pluralize } from "../../lib/pluralize";
import type { TripScanImport } from "./useTripScanImport";
import CullMarksChoice from "../../components/importReview/CullMarksChoice";
import { rejectedRowNote } from "../../lib/cullInfo";

function rowStatusText(status: string, error: string | undefined): string | undefined {
  return status === "done" ? "✓ Imported" : status === "error" ? error : status === "importing" ? "Importing…" : "";
}

// What a scan found that isn't imported yet: pick a species for each (or several at once), an
// optional region for the batch, then import.
export default function TripScanReview({
  tripId,
  destinationFolder,
  suggestEnabled,
  jobs,
  onViewSpeciesGallery,
  speciesGalleryLightbox,
}: {
  tripId: string | undefined;
  destinationFolder: string;
  suggestEnabled: boolean;
  jobs: TripScanImport;
  onViewSpeciesGallery: (speciesId: string, label: string) => void;
  speciesGalleryLightbox: ReactNode;
}) {
  const { reviewRows, readyCount, notWildlifeCount, review, reviewRegionId, importing, cullOption } = jobs;
  const { selected, setSelected, toggleSelected, focusedRowKey, setFocusedRowKey, activeRow, highlightIndex } = review;

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-3 text-sm text-muted">
        <span>
          {pluralize(reviewRows.length, "new photo")} · {readyCount} ready to import
          {notWildlifeCount > 0 && ` · ${notWildlifeCount} not wildlife, left out`}
        </span>
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span>Assign {selected.size} selected to:</span>
            <div className="w-56">
              <SpeciesPicker
                placeholder="Type a species…"
                regionId={reviewRegionId}
                onSelect={(r) => {
                  review.assignSpecies([...selected], r);
                  setSelected(new Set());
                }}
              />
            </div>
          </div>
        )}
        <Button size="sm" onClick={jobs.importReady} disabled={importing || readyCount === 0} className="ml-auto">
          {importing ? "Importing…" : readyCount ? `Import ${pluralize(readyCount, "photo")}` : "Import photos"}
        </Button>
      </div>
      <CullMarksChoice
        total={jobs.scannedCount}
        rejected={jobs.cullRejected}
        value={cullOption}
        onChange={jobs.selectCullOption}
        disabled={importing}
      />
      <div className="rounded-lg border border-line bg-surface-muted px-3 py-2">
        <p className="mb-1 text-sm text-muted">
          {suggestEnabled
            ? "Region for species suggestions (also saved as each photo's location):"
            : "Location for this batch (optional):"}
        </p>
        <RegionBrowser regionId={reviewRegionId} onChange={jobs.selectReviewRegion} allowAnyRegion={!suggestEnabled} />
        {suggestEnabled && !reviewRegionId && (
          <p className="mt-1 text-xs text-muted">Pick a region to see species suggestions below.</p>
        )}
      </div>
      <p className="text-xs text-muted">
        Imported photos are copied to {destinationFolder}, sorted by species. The originals stay where they are.
      </p>

      <div className="divide-y divide-line rounded-lg border border-line bg-surface">
        {reviewRows.map((row) => (
          <ImportReviewRow
            key={row.key}
            row={row}
            name={row.key}
            preview={
              <img
                src={`/api/trips/${tripId}/scan-preview?file=${encodeURIComponent(row.key)}`}
                alt=""
                loading="lazy"
                className="h-14 w-14 rounded-md object-cover"
              />
            }
            status={
              <span className="text-xs text-muted">
                {rowStatusText(row.status, row.error) || rejectedRowNote(row, cullOption)}
              </span>
            }
            removable={row.status !== "importing" && row.status !== "done"}
            onRemove={() => jobs.removeReviewRow(row.key)}
            removeLabel="Leave this photo out of the import"
            selected={selected.has(row.key)}
            onToggleSelected={() => toggleSelected(row.key)}
            focused={focusedRowKey === row.key}
            onFocus={() => setFocusedRowKey(row.key)}
            regionId={reviewRegionId}
            onPick={(r) => review.assignAndAdvance(row.key, r)}
            isActive={row.key === activeRow?.key}
            highlightIndex={highlightIndex}
            onDismissWarning={(warning) => review.dismissWarning(row.key, warning)}
            onViewSpeciesGallery={onViewSpeciesGallery}
          />
        ))}
      </div>
      {speciesGalleryLightbox}
    </section>
  );
}
