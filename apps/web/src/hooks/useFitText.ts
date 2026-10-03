import { useLayoutEffect, useRef, useState } from "react";

const MAX_FONT_PX = 14; // matches text-sm
const MIN_FONT_PX = 9;
const MAX_LINES = 2;

// Shrinks font size (down to MIN_FONT_PX) until the full text fits in MAX_LINES lines, for long
// species card names. Don't pair with CSS line-clamp: it breaks the scrollHeight measurement.
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
