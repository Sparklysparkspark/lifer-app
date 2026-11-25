import { useRef, useState, type KeyboardEvent } from "react";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import Button from "./Button";
import Checkbox from "./Checkbox";

export interface StarRange {
  min: number | null;
  max: number | null;
  unrated: boolean;
}

const STARS = [1, 2, 3, 4, 5];
// design-token: the gold of StarRating, shared by every star in the app.
const STAR_ON = "text-amber-500";
const STAR_OFF = "text-muted hover:text-amber-400"; // design-token: same gold, hover

// Pick a range of star ratings: click one star, click a second for the range, or drag across.
// A missing max reads as five stars, matching how the filter stores "3 or more".
export default function StarRangePicker({ value, onChange }: { value: StarRange; onChange: (v: StarRange) => void }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<number | null>(null);
  const dragging = useRef(false);
  const lo = value.min ?? 0;
  const hi = value.min === null ? 0 : (value.max ?? 5);

  function set(a: number, b: number) {
    onChange({ min: Math.min(a, b), max: Math.max(a, b), unrated: false });
  }
  function press(star: number) {
    dragging.current = true;
    if (anchor !== null) {
      set(anchor, star);
      setAnchor(null);
    } else if (lo === star && hi === star) onChange({ min: null, max: null, unrated: false });
    else {
      set(star, star);
      setAnchor(star);
    }
  }
  function keys(e: KeyboardEvent<HTMLElement>, star: number) {
    const next = matches(e, "stepUp") ? star + 1 : matches(e, "stepDown") ? star - 1 : 0;
    if (next < 1 || next > 5) return;
    e.preventDefault();
    e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-star]")[next - 1]?.focus();
  }

  return (
    <div className="space-y-2">
      <div
        className="flex items-center"
        onPointerLeave={() => (dragging.current = false)}
        role="group"
        aria-label={t("gallery.toolbar.rating")}
      >
        {STARS.map((star) => (
          // raw-control: each star is one glyph of this shared control. Narrow, full-height hit areas
          // that touch, so the stars sit together with no dead gap between them.
          <button
            key={star}
            type="button"
            data-star
            aria-pressed={star >= lo && star <= hi}
            aria-label={t("gallery.toolbar.ratingExactly", { count: star })}
            onPointerDown={(e) => {
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              press(star);
            }}
            onPointerEnter={() => {
              if (dragging.current && anchor !== null) set(anchor, star);
            }}
            onPointerUp={() => {
              dragging.current = false;
              if (anchor !== null && lo !== hi) setAnchor(null);
            }}
            onKeyDown={(e) => keys(e, star)}
            onClick={(e) => {
              // Keyboard activation has no pointer events; a mouse click already ran press().
              if (e.detail === 0) press(star);
            }}
            className={`h-11 w-6 rounded-control text-title-2 leading-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              star >= lo && star <= hi ? STAR_ON : STAR_OFF
            }`}
          >
            ★
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Checkbox
          size="sm"
          checked={value.unrated}
          onChange={(checked) => onChange({ min: null, max: null, unrated: checked })}
        >
          {t("gallery.toolbar.unrated")}
        </Checkbox>
        {(value.min !== null || value.unrated) && (
          <Button
            variant="link"
            onClick={() => {
              setAnchor(null);
              onChange({ min: null, max: null, unrated: false });
            }}
          >
            {t("gallery.toolbar.clearRating")}
          </Button>
        )}
      </div>
    </div>
  );
}
