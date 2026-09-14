// The one search-box look used everywhere in the app — same rounded-md/border-line shape as
// every other text input (SpeciesPicker, CollectionPage's in-area search, RegionPicker,
// SpeciesHotspotMap's coordinate search), plus a real clear-X button. Gallery's own search box
// used to be the odd one out (rounded-full, relying on the browser's native type="search" clear
// icon, which several other boxes didn't have at all) — this unifies the shape everywhere and
// gives every one of them the same working clear button, not just Gallery's.
export default function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  onFocus,
  onBlur,
  onKeyDown,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  "aria-label"?: string;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel}
        className={`w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ink ${value ? "pr-7" : ""}`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-lg leading-none text-muted hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}
