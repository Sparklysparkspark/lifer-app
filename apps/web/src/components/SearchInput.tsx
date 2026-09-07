// The rounded-full search box styling — same visual language as SpeciesPicker's own input and
// Gallery's content-search box, previously each hand-styled with the identical class string.
// Deliberately just the INPUT (not the debounce/fetch logic around it, which differs enough per
// caller — Gallery's own text/semantic search vs. CollectionPage's plain in-view filter — that
// forcing one shared behavior would be the wrong abstraction); this only unifies the one thing
// that actually was identical everywhere: how the box looks.
export default function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ink ${className ?? ""}`}
    />
  );
}
