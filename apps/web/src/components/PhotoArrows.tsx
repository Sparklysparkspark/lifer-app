import type { MouseEvent } from "react";

// The previous and next buttons drawn over a photo, vertically centred on its edges: the Lightbox,
// the species page's carousel and compare's reference photos. Tall translucent ovals; `dark` is the
// Lightbox's, on its black surround, and `photo` the darker fill that reads on any photo. The parent
// must be positioned.
export default function PhotoArrows({
  onPrevious,
  onNext,
  previousLabel,
  nextLabel,
  tone = "photo",
  wide = false,
  className = "",
}: {
  onPrevious: () => void;
  onNext: () => void;
  previousLabel: string;
  nextLabel: string;
  tone?: "dark" | "photo";
  /** Further in from the edges on wider windows (the Lightbox's full-window photo). */
  wide?: boolean;
  /** Extra classes on both, e.g. to fade them while zoomed or reveal them on hover. */
  className?: string;
}) {
  // design-token: light glyphs on translucent fills over photos, as the Lightbox's controls.
  const fill = tone === "dark" ? "bg-white/10 hover:bg-white/20" : "bg-black/30 hover:bg-black/50";
  // design-token: white glyphs over photos, as above.
  const base = `absolute top-1/2 z-10 -translate-y-1/2 rounded-full px-2.5 py-1 text-title-3 leading-7 text-white transition-opacity duration-300 ${fill} ${className}`;
  const [left, right] = wide ? ["left-2 sm:left-6", "right-2 sm:right-6"] : ["left-2", "right-2"];
  const press = (go: () => void) => (e: MouseEvent) => {
    // Never also a click on the photo or backdrop beneath.
    e.stopPropagation();
    go();
  };
  return (
    <>
      {/* raw-control: arrows drawn over the photo, not toolbar buttons. */}
      <button type="button" onClick={press(onPrevious)} className={`${base} ${left}`} aria-label={previousLabel}>
        ‹
      </button>
      {/* raw-control: arrows drawn over the photo, not toolbar buttons. */}
      <button type="button" onClick={press(onNext)} className={`${base} ${right}`} aria-label={nextLabel}>
        ›
      </button>
    </>
  );
}
