import { useState } from "react";
import type { SuggestedSpecies } from "./SpeciesPicker";
import PhotoPlaceholder from "./PhotoPlaceholder";

// Same card shape as SpeciesCard.tsx (square photo, name, italic scientific name) so a
// suggestion reads as the same kind of object as every other species card in the app, just
// smaller and with a match percent instead of rarity badges. Two separate buttons rather than
// one big clickable card: the photo opens a bigger view of the reference photo, everything else
// assigns the species to this row — a photo and a "pick this" action are different things a
// user might want to do with the same card.
export default function SuggestionCard({
  suggestion,
  matchPercent,
  highlighted,
  onSelect,
  onViewPhoto,
}: {
  suggestion: SuggestedSpecies;
  /** Precomputed by the caller — a lone suggestion reads as 100% match rather than whatever
   *  raw (and often much lower, since cosine similarity across unrelated photos rarely
   *  approaches 1.0) score the model happened to produce for it alone. */
  matchPercent: number;
  /** True when this is the keyboard-arrow-selected card for its row — Enter assigns it. Purely
   *  visual; assignment itself still only happens via onSelect (click or Enter). */
  highlighted?: boolean;
  onSelect: () => void;
  onViewPhoto: () => void;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const displayName = suggestion.common_name ?? suggestion.scientific_name;

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
        <p className="text-[10px] font-medium text-muted">{matchPercent}% match</p>
      </button>
    </div>
  );
}
