import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPercent } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";
import type { SuggestedSpecies } from "./SpeciesPicker";
import PhotoPlaceholder from "./PhotoPlaceholder";

// A small species card with a match percent. The photo opens the reference photos; the rest assigns.
export default function SuggestionCard({
  suggestion,
  matchPercent,
  highlighted,
  onSelect,
  onViewPhoto,
}: {
  suggestion: SuggestedSpecies;
  /** From the caller, so a lone certain match can show 100% instead of its raw score. */
  matchPercent: number;
  /** The keyboard-highlighted card for its row (visual only; Enter assigns via onSelect). */
  highlighted?: boolean;
  onSelect: () => void;
  onViewPhoto: () => void;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const displayName = speciesName({ commonName: suggestion.common_name, scientificName: suggestion.scientific_name });

  return (
    <div
      className={`w-28 shrink-0 overflow-hidden rounded-lg border bg-surface transition hover:border-accent hover:shadow-md ${
        highlighted ? "border-accent ring-2 ring-accent" : "border-line"
      }`}
    >
      <button type="button" onClick={onViewPhoto} className="block aspect-square w-full bg-surface-muted">
        {!photoFailed ? (
          <img
            src={`/api/species/${suggestion.id}/reference-photo/thumb`}
            alt={displayName}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setPhotoFailed(true)}
          />
        ) : (
          <PhotoPlaceholder className="h-full w-full" />
        )}
      </button>
      <button type="button" onClick={onSelect} className="block w-full p-1.5 text-left">
        <p className="truncate text-xs font-medium leading-tight text-ink">{displayName}</p>
        <p className="truncate text-[10px] italic text-muted">{suggestion.scientific_name}</p>
        <p className="text-[10px] font-medium text-muted">{t("species.suggestion.match", { percent: formatPercent(matchPercent / 100) })}
        </p>
      </button>
    </div>
  );
}
