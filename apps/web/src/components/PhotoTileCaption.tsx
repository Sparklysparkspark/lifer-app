import type { ReactNode } from "react";
import StarRating from "./StarRating";

// The rows under a photo tile that the View menu's Labels, Ratings and Camera info turn on, laid
// out the same on every grid.
export default function PhotoTileCaption({
  showLabels,
  showRatings,
  showCameraInfo,
  label,
  rating,
  onRate,
  shotLine,
}: {
  showLabels: boolean;
  showRatings: boolean;
  showCameraInfo: boolean;
  /** Usually the species name. */
  label: ReactNode;
  rating: number | null | undefined;
  onRate: (rating: number | null) => void;
  shotLine: string | null;
}) {
  return (
    <>
      {showLabels && label && <p className="mt-1 truncate text-footnote text-muted">{label}</p>}
      {showRatings && (
        // Tighter under a label so the two read as one caption.
        <div className={showLabels && label ? "mt-0.5" : "mt-1"}>
          <StarRating rating={rating ?? null} onRate={onRate} />
        </div>
      )}
      {showCameraInfo && shotLine && <p className="text-footnote text-muted">{shotLine}</p>}
    </>
  );
}
