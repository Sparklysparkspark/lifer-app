import type { AriaAttributes, InputHTMLAttributes, Ref } from "react";

// The one search-box look used everywhere, with a real clear button.
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
  inputRef,
  inputProps,
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
  inputRef?: Ref<HTMLInputElement>;
  // Combobox wiring (role, aria-expanded, aria-controls, aria-activedescendant, id).
  inputProps?: AriaAttributes &
    Pick<InputHTMLAttributes<HTMLInputElement>, "id" | "role" | "autoComplete" | "spellCheck">;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        {...inputProps}
        ref={inputRef}
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
          // Keeps focus in the field, so a combobox's list doesn't close on the click.
          onMouseDown={(e) => e.preventDefault()}
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
