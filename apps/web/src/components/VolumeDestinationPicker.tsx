import type { useVolumeDestination } from "../hooks/useVolumeDestination";
import { pluralize, pluralWord } from "../lib/pluralize";
import Select from "./Select";

export function VolumeDestinationPicker({
  volumeId,
  setVolumeId,
  connectedVolumes,
  recommendedCount,
  disconnectedRecommendation,
}: ReturnType<typeof useVolumeDestination>) {
  if (connectedVolumes.length === 0 && !disconnectedRecommendation) return null;

  return (
    <div className="space-y-1 text-left">
      {disconnectedRecommendation && (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {pluralize(disconnectedRecommendation.count, "existing photo")} of this species{" "}
          {pluralWord(disconnectedRecommendation.count, "is", "are")} on "{disconnectedRecommendation.label}", which
          isn't connected right now. Plug it in to keep these together, or choose a different destination below.
        </p>
      )}
      {connectedVolumes.length > 0 && (
        <>
          <label className="text-xs font-medium text-muted">Save these photos to</label>
          <Select variant="form" value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
            <option value="">Main library</option>
            {connectedVolumes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.isDefault ? " (default)" : ""}
              </option>
            ))}
          </Select>
          {volumeId && recommendedCount > 0 && (
            <p className="text-xs text-muted">
              {pluralize(recommendedCount, "existing photo")} of this species{" "}
              {pluralWord(recommendedCount, "is", "are")} already on this drive.
            </p>
          )}
        </>
      )}
    </div>
  );
}
