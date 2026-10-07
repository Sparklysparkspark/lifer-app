import EditableTextField from "../../components/EditableTextField";
import InfoTip from "../../components/InfoTip";
import { pluralize } from "../../lib/pluralize";
import type { TripDetail, TripFolder, TripSummary } from "./types";

const RELOCATE_INFO_PARAGRAPHS = [
  "Use this if this trip's folder moved: a new computer, a reinstall, a renamed drive.",
  "It doesn't move or copy any files. It just updates the path Lifer has stored, then automatically rescans the new location and relinks your existing photos by their content. You won't need to reassign species to anything that's already here.",
];

// Under the trip's name: its two folders, the photo count, what was notable, and the description.
export default function TripHeaderDetails({
  trip,
  photoCount,
  summary,
  onRelocate,
  onSaveDescription,
}: {
  trip: TripDetail;
  photoCount: number;
  summary: TripSummary | null;
  onRelocate: (which: TripFolder) => void;
  onSaveDescription: (description: string) => void;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
        <span className="shrink-0">Trip folder:</span>
        <span className="min-w-0 truncate" title={trip.sourceFolder}>
          {trip.sourceFolder}
        </span>
        <button onClick={() => onRelocate("sourceFolder")} className="shrink-0 underline hover:text-ink">
          Relocate…
        </button>
        <InfoTip paragraphs={RELOCATE_INFO_PARAGRAPHS} className="shrink-0" />
        <span className="shrink-0">· {pluralize(photoCount, "photo")}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
        <span className="shrink-0">Wildlife saved to:</span>
        <span className="min-w-0 truncate" title={trip.destinationFolder}>
          {trip.destinationFolder}
        </span>
        <button onClick={() => onRelocate("destinationFolder")} className="shrink-0 underline hover:text-ink">
          Relocate…
        </button>
      </div>
      {summary && summary.speciesCount > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          <span>
            <span className="font-medium text-ink">{summary.speciesCount}</span> species
          </span>
          {summary.liferCount > 0 && (
            <span>
              <span className="font-medium text-ink">{summary.liferCount}</span>{" "}
              {summary.liferCount === 1 ? "lifer" : "lifers"}
            </span>
          )}
          {summary.rareCount > 0 && (
            <span>
              <span className="font-medium text-ink">{summary.rareCount}</span> rare/legendary
            </span>
          )}
          {summary.endemicCount > 0 && (
            <span>
              <span className="font-medium text-ink">{summary.endemicCount}</span> endemic
            </span>
          )}
        </div>
      )}
      <div className="mt-2 w-full">
        <EditableTextField
          value={trip.description ?? ""}
          onSave={onSaveDescription}
          placeholder="Add a description…"
          className="text-sm text-ink"
          multiline
        />
      </div>
    </>
  );
}
