// The "more" glyph for the overlay ⋯ button, drawn like MagnifierIcon so the pair sits on one
// centre line at one size; a text ⋯ rides on the font's baseline instead.
export default function DotsIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    // No aria-hidden: the button around it carries the name, and the attribute marks layout spacers elsewhere.
    <svg viewBox="0 0 16 16" focusable="false" className={className} fill="currentColor">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}
