import { useEffect, useRef, useState } from "react";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import { NAME_COUNTDOWN_FROM } from "@lifer/shared";

/** Always-editable inline text (a name or description) that saves on blur, and only when the
 * trimmed value changed. A bottom border on hover/focus is the only edit affordance. */
export default function EditableTextField({
  value,
  onSave,
  placeholder,
  hint,
  className,
  multiline,
  autoSelect,
  maxLength,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  /** Optional caption under the field. */
  hint?: string;
  className?: string;
  multiline?: boolean;
  /** Starts in edit mode with the text selected, so typing replaces it (a just-created item's name). */
  autoSelect?: boolean;
  /** Caps the text and counts down near the cap (album and trip names). */
  maxLength?: number;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoSelect) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only, so a later render never steals focus back
  }, []);
  const [draft, setDraft] = useState(value);
  // A new value from outside (a save landed, or another item) replaces the draft.
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(value);
  }

  function commit() {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  }

  const shared = `block w-full min-w-0 rounded-control border-b border-transparent bg-transparent px-0 outline-none transition-colors hover:border-line focus:border-ink focus:shadow-none ${className ?? ""}`;

  return (
    <div className="min-w-0">
      {multiline ? (
        // raw-control: text edited in place, drawn as the text itself rather than a field.
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          placeholder={placeholder}
          rows={2}
          // Sized to the text so a header lays it out at its natural width; capped so long text wraps.
          cols={Math.min(Math.max(draft.length, placeholder?.length ?? 0, 20), 60)}
          className={`${shared} resize-none`}
        />
      ) : (
        // The hidden copy of the text sizes the grid, so the field is exactly as wide as its text
        // (a size attribute is wider: it counts average characters), with room for the caret only
        // while editing. A long value truncates, with the full text on hover.
        <span className="group inline-grid max-w-full grid-cols-[minmax(0,max-content)] align-top">
          <span
            aria-hidden="true"
            className={`invisible col-start-1 row-start-1 overflow-hidden whitespace-pre border-b border-transparent group-focus-within:pr-2 ${className ?? ""}`}
          >
            {draft || placeholder || " "}
          </span>
          {/* raw-control: text edited in place, drawn as the text itself rather than a field. */}
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (matches(e, "confirm")) (e.target as HTMLInputElement).blur();
            }}
            placeholder={placeholder}
            size={1}
            maxLength={maxLength}
            title={draft}
            className={`${shared} col-start-1 row-start-1 text-ellipsis`}
          />
        </span>
      )}
      {maxLength !== undefined && maxLength - draft.length <= maxLength - NAME_COUNTDOWN_FROM && (
        <p aria-live="polite" className="mt-0.5 text-footnote text-muted">
          {t("ui.charactersLeft", { count: maxLength - draft.length })}
        </p>
      )}
      {hint && <p className="mt-0.5 text-footnote text-muted">{hint}</p>}
    </div>
  );
}
