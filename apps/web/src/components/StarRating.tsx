// Shared 1-5 star rating control — extracted from SpeciesDetailPage.tsx's own inline widget so
// GalleryPage.tsx can rate a photo directly instead of only from the species page. Clicking the
// currently-set star clears the rating (same toggle-off behavior the original had).
export default function StarRating({
  rating,
  onRate,
  size = "text-xs",
}: {
  rating: number | null;
  onRate: (rating: number | null) => void;
  size?: string;
}) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRate(rating === star ? null : star);
          }}
          className={`${size} leading-none ${rating != null && star <= rating ? "text-amber-500" : "text-muted"}`}
          aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
