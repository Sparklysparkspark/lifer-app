import { useLayoutEffect, useRef, useState } from "react";

const MAX_FONT_PX = 14; // matches text-sm
const MIN_FONT_PX = 9;
const MAX_LINES = 2;

// Shrinks a text element's font size (down to MIN_FONT_PX) just enough that its full,
// un-truncated content fits within MAX_LINES lines — used for species card names, which can
// run long ("Slate-Colored Fox Sparrow") on a card whose width comes from a responsive grid
// column, not a fixed size. Wrapping onto a second line handles most cases on its own; the
// font-size shrink is a fallback for names that would still overflow two lines even wrapped.
// Deliberately NOT paired with CSS `line-clamp` on the same element — line-clamp's own
// height-capping makes scrollHeight unreliable to measure against, which would prevent this
// from ever detecting how much overflow remains. useLayoutEffect (not useEffect) applies the
// shrunk size before paint, so an oversized name never flashes at MAX_FONT_PX first.
export function useFitText(deps: readonly unknown[]): { ref: React.RefObject<HTMLParagraphElement | null>; fontSize: number } {
  const ref = useRef<HTMLParagraphElement>(null);
  const [fontSize, setFontSize] = useState(MAX_FONT_PX);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      el.style.fontSize = `${MAX_FONT_PX}px`;
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || MAX_FONT_PX * 1.2;
      const maxHeight = lineHeight * MAX_LINES;
      const { scrollHeight } = el;
      if (scrollHeight <= maxHeight + 1) {
        setFontSize(MAX_FONT_PX);
        return;
      }
      const scaled = Math.floor(MAX_FONT_PX * (maxHeight / scrollHeight));
      setFontSize(Math.max(MIN_FONT_PX, scaled));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's own dependency list
  }, deps);

  return { ref, fontSize };
}
