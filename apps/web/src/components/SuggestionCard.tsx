import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPercent } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";
import type { SuggestedSpecies } from "./SpeciesPicker";
import PhotoPlaceholder from "./PhotoPlaceholder";
import MagnifierIcon from "./MagnifierIcon";
import MediaCard from "./MediaCard";
import { IconButton } from "./Button";

// A small species card with a match percent. The whole card assigns the species, since that's what
// people click first; seeing more of its photos is the corner magnifier, a sibling of the card's button.
export default function SuggestionCard({
  suggestion,
  matchPercent,
  highlighted,
  onSelect,
  onViewPhoto,
}: {
  suggestion: SuggestedSpecies;
  /** From the caller, so a lone certain match can show 100% instead of its raw score. Null for a
   *  species the user typed, which has no match. */
  matchPercent: number | null;
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
    <MediaCard
      // Wide enough for a three-part scientific name (Lithobates clamitans clamitans) in two lines.
      className="w-32 shrink-0"
      media={
        !photoFailed ? (
          <img
            src={`/api/species/${suggestion.id}/reference-photo/thumb`}
            alt={displayName}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setPhotoFailed(true)}
          />
        ) : (
          <PhotoPlaceholder className="h-full w-full" />
        )
      }
      title={displayName}
      // Two lines each, reserved even when one is enough, so every card in a row is the same height;
      // only a name longer than that is cut, and the card's tooltip has it whole.
      titleClassName="line-clamp-2 min-h-[2lh] text-footnote wrap-anywhere"
      lines={[
        <p key="sci" className="line-clamp-2 min-h-[2lh] text-footnote italic text-muted wrap-anywhere">
          {suggestion.scientific_name}
        </p>,
        matchPercent != null && t("species.suggestion.match", { percent: formatPercent(matchPercent / 100) }),
      ]}
      compact
      selected={highlighted}
      renderBody={(props) => (
        // raw-control: the whole card is the button.
        <button type="button" onClick={onSelect} title={`${displayName}\n${suggestion.scientific_name}`} {...props} />
      )}
      actions={
        <IconButton
          tone="overlay"
          onClick={onViewPhoto}
          aria-label={t("species.suggestion.morePhotos", { name: displayName })}
          tooltip={{ label: t("species.suggestion.morePhotosTitle") }}
        >
          <MagnifierIcon />
        </IconButton>
      }
    />
  );
}
