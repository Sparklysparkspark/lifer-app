import { useLayoutEffect, useRef, useState } from "react";

const MAX_LINES = 2;

// Shrinks font size (from maxPx down to minPx) until the full text fits in MAX_LINES lines, for
// long card names. Don't pair with CSS line-clamp: it breaks the scrollHeight measurement.
// The defaults match text-callout.
export function useFitText(
  deps: readonly unknown[],
  { maxPx: MAX_FONT_PX = 14, minPx: MIN_FONT_PX = 9 }: { maxPx?: number; minPx?: number } = {},
): {
  ref: React.RefObject<HTMLParagraphElement | null>;
  fontSize: number;
} {
  const ref = useRef<HTMLParagraphElement>(null);
  const [fontSize, setFontSize] = useState(MAX_FONT_PX);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // Only written when it differs: a write between reads would force a fresh layout for every
      // card mounting in the same commit.
      if (el.style.fontSize !== `${MAX_FONT_PX}px`) el.style.fontSize = `${MAX_FONT_PX}px`;
      const lineHeightRatio = (parseFloat(getComputedStyle(el).lineHeight) || MAX_FONT_PX * 1.2) / MAX_FONT_PX;
      // Wrapping isn't proportional to size, so step down until it actually fits.
      let size = MAX_FONT_PX;
      while (size > MIN_FONT_PX && el.scrollHeight > lineHeightRatio * size * MAX_LINES + 1) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    };

    measure();
    // Width only: the height is what the font size changes, so watching it would re-trigger this.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      measure();
    });
    observer.observe(el);
    // A web font arriving changes how the name wraps without resizing anything.
    let live = true;
    if (document.fonts && document.fonts.status !== "loaded") void document.fonts.ready.then(() => live && measure());
    return () => {
      live = false;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's own dependency list
  }, deps);

  return { ref, fontSize };
}
