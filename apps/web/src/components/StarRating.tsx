// 1-5 star rating; clicking the current star clears it.
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
