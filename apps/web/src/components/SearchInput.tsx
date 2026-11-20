import type { AriaAttributes, InputHTMLAttributes, Ref } from "react";
import { useTranslation } from "react-i18next";
import { FIELD, FIELD_HEIGHT } from "../lib/fieldClasses";

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
  size = "sm",
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
  // sm matches toolbar controls (h-8), md a form's fields and md Buttons.
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
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
        className={`${FIELD} ${FIELD_HEIGHT[size]} ${value ? "pr-7" : ""}`}
      />
      {value && (
        <button
          type="button"
          // Keeps focus in the field, so a combobox's list doesn't close on the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange("")}
          aria-label={t("ui.clearSearch")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-title-3 leading-none text-muted hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}
