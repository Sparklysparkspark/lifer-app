import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";

// Tag chips with a free-text input and autocomplete from tags used elsewhere.
export default function TagEditor({
  tags,
  onChange,
  existingTags,
  label,
  compact = false,
  dark = false,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Tags used elsewhere, for autocomplete; omit to disable suggestions. */
  existingTags?: string[];
  label?: string;
  /** Drops the heading and top border, for inline use in a toolbar row. */
  compact?: boolean;
  /** White-on-black styling for Lightbox's fixed black backdrop, which ignores the app theme. */
  dark?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Escape drops the half-typed tag; the blur that follows it mustn't save it.
  const discardOnBlur = useRef(false);

  function commitTag(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!tags.includes(trimmed)) onChange([...tags, trimmed]);
    setDraft("");
    setSuggestionsOpen(false);
  }

  const suggestions = (
    draft.trim() && existingTags
      ? existingTags.filter((x) => x.toLowerCase().includes(draft.trim().toLowerCase()) && !tags.includes(x))
      : []
  ).slice(0, 6);
  const listOpen = suggestionsOpen && suggestions.length > 0;
  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // On the top layer, so a dialog body's scroll never clips the suggestions.
  const listStyle = useAnchoredPosition(fieldRef, listRef, listOpen);

  return (
    <div
      className={compact ? "" : `mt-3 border-t pt-3 ${dark ? "border-white/20" : "border-line"}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!compact && (
        <p
          className={`mb-2 text-footnote font-medium uppercase tracking-wide ${dark ? "text-white/60" : "text-muted"}`}
        >
          {label ?? t("ui.tags.label")}
        </p>
      )}
      {/* Centred under the photo in the viewer; left-aligned in menus and dialogs. */}
      <div className={`flex flex-wrap items-center gap-1.5 ${dark ? "justify-center" : ""}`}>
        {tags.map((tag) => (
          <span
            key={tag}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-footnote ${
              dark ? "border-white/30 bg-white/10 text-white" : "border-line bg-surface-muted text-ink"
            }`}
          >
            {tag}
            <IconButton
              tone="plain"
              onClick={() => onChange(tags.filter((other) => other !== tag))}
              className={`h-4! min-w-4! ${dark ? "text-white/70! hover:text-white!" : ""}`}
              aria-label={t("ui.tags.remove", { tag })}
            >
              ×
            </IconButton>
          </span>
        ))}
        <div ref={fieldRef} className="relative">
          {/* raw-control: the tag field's own borderless input, inside the chip row. */}
          <input
            value={draft}
            onChange={(e) => {
              discardOnBlur.current = false;
              setDraft(e.target.value);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={(e) => {
              if (matches(e, "confirm")) {
                e.preventDefault();
                commitTag(draft);
              } else if (matches(e, "close")) {
                discardOnBlur.current = true;
                setDraft("");
                setSuggestionsOpen(false);
              }
            }}
            // Suggestion buttons preventDefault on mousedown, so blur only fires on a real click-away.
            onBlur={() => {
              if (discardOnBlur.current) discardOnBlur.current = false;
              else commitTag(draft);
            }}
            placeholder={t("ui.tags.add")}
            className={`w-28 rounded-full border border-dashed bg-transparent px-2.5 py-1 text-footnote outline-none ${
              dark
                ? "border-white/30 text-white placeholder:text-white/40 focus:border-white/60"
                : "border-line text-ink focus:border-accent"
            }`}
          />
          {listOpen &&
            createPortal(
              <div
                ref={listRef}
                style={listStyle}
                className={`z-50 w-40 rounded-panel border py-1 shadow-lg ${
                  dark ? "border-white/20 bg-[#1c1e1f]" : "border-line bg-surface"
                }`}
              >
                {suggestions.map((s) => (
                  // raw-control: a row of the suggestion list.
                  <button
                    key={s}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitTag(s);
                    }}
                    className={`block w-full truncate px-2.5 py-1 text-left text-footnote ${
                      dark ? "text-white hover:bg-white/10" : "text-ink hover:bg-surface-muted"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>,
              document.body,
            )}
        </div>
      </div>
    </div>
  );
}
