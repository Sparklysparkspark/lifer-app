import { useState } from "react";

// 1-5 star rating; clicking the current star clears it. Pointing at a star (or focusing it) lights
// it and the ones before it, so the rating a click will give shows first.
export default function StarRating({
  rating,
  onRate,
  size = "text-xs",
}: {
  rating: number | null;
  onRate: (rating: number | null) => void;
  size?: string;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const shown = preview ?? rating;
  return (
    <div className="flex gap-0.5" onMouseLeave={() => setPreview(null)}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRate(rating === star ? null : star);
            setPreview(null);
          }}
          onMouseEnter={() => setPreview(star)}
          onFocus={() => setPreview(star)}
          onBlur={() => setPreview(null)}
          className={`${size} leading-none transition-colors ${
            shown != null && star <= shown ? (preview != null ? "text-amber-400" : "text-amber-500") : "text-muted"
          }`}
          aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
