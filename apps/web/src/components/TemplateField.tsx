import { useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Button from "./Button";
import InfoTip from "./InfoTip";
import Menu, { MenuItem, MenuPanel } from "./Menu";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { isEditKey, matches } from "../lib/keymap";

export interface TokenGroup {
  label: string;
  tokens: readonly string[];
}

// The template stays one string ("{species} taken on {longdate}"); it is split into text and token
// parts only to draw it, so a saved template round-trips exactly. split() with a capture group gives
// text at even positions and token names at odd ones, always starting and ending with text.
const serialize = (parts: string[]) => parts.map((p, i) => (i % 2 ? `{${p}}` : p)).join("");
const offsetOf = (parts: string[], i: number, caret: number) => serialize(parts.slice(0, i)).length + caret;

function locate(parts: string[], abs: number): { i: number; caret: number } {
  let rest = abs;
  for (let i = 0; i < parts.length; i += 2) {
    if (rest <= parts[i].length) return { i, caret: rest };
    rest -= parts[i].length;
    if (parts[i + 1] !== undefined) rest -= parts[i + 1].length + 2;
  }
  const last = parts.length - 1;
  return { i: last, caret: parts[last].length };
}

const BOX =
  "flex min-h-9.5 w-full min-w-0 cursor-text flex-wrap items-center gap-x-1 gap-y-1 rounded-control border border-control-line bg-control px-2 py-1 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent";
const TEXT = "px-0.5 py-0.5 text-callout text-ink";

/** A template edited as text with its tokens drawn as chips. Typing "{" or choosing from the Insert
 *  menu adds a chip; Backspace or Delete next to a chip, or on it, removes it; arrow keys move across. */
export default function TemplateField({
  value,
  onChange,
  groups,
  tokenLabel,
  label,
  placeholder,
  maxLength = 500,
  help,
  actions,
}: {
  value: string;
  onChange: (next: string) => void;
  groups: TokenGroup[];
  tokenLabel: (token: string) => string;
  /** Names the whole field for screen readers. */
  label: string;
  placeholder?: string;
  maxLength?: number;
  /** Paragraphs for an info button beside Insert. */
  help?: string[];
  /** More buttons beside Insert, such as a presets menu. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const menu = useDropdownMenu();
  const known = useMemo(() => groups.flatMap((g) => g.tokens), [groups]);
  const parts = useMemo(
    () => (known.length ? value.split(new RegExp(`\\{(${known.join("|")})\\}`)) : [value]),
    [value, known],
  );
  const textRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Where the next insert goes, and where focus lands after an edit re-renders the parts.
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pending.current === null) return;
    const caret = pending.current;
    pending.current = null;
    focusAt(caret);
  });

  function focusAt(caret: number) {
    const at = locate(parts, caret);
    const el = textRefs.current[at.i / 2];
    el?.focus();
    el?.setSelectionRange(at.caret, at.caret);
  }

  function commit(next: string, caret: number) {
    if (next.length > maxLength) return;
    pending.current = caret;
    onChange(next);
  }

  function insert(token: string) {
    const start = selection.current?.start ?? value.length;
    const end = selection.current?.end ?? start;
    const chip = `{${token}}`;
    commit(value.slice(0, start) + chip + value.slice(end), start + chip.length);
  }

  function removeChip(i: number) {
    const at = offsetOf(parts, i, 0);
    commit(serialize([...parts.slice(0, i - 1), parts[i - 1] + parts[i + 1], ...parts.slice(i + 2)]), at);
  }

  function remember(i: number, el: HTMLTextAreaElement) {
    selection.current = {
      start: offsetOf(parts, i, el.selectionStart),
      end: offsetOf(parts, i, el.selectionEnd),
    };
  }

  function onTextKey(i: number, e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    if (isEditKey(e, "{")) {
      e.preventDefault();
      remember(i, el);
      menu.setOpenKey(true);
    } else if (matches(e, "choose")) {
      // Templates are one line.
      e.preventDefault();
    } else if (isEditKey(e, "Backspace") && atStart && i > 0) {
      e.preventDefault();
      removeChip(i - 1);
    } else if (isEditKey(e, "Delete") && atEnd && i < parts.length - 1) {
      e.preventDefault();
      removeChip(i + 1);
    } else if (matches(e, "stepDown") && atStart && i > 0) {
      e.preventDefault();
      chipRefs.current[i - 1]?.focus();
    } else if (matches(e, "stepUp") && atEnd && i < parts.length - 1) {
      e.preventDefault();
      chipRefs.current[i + 1]?.focus();
    }
  }

  function onChipKey(i: number, e: ReactKeyboardEvent) {
    if (isEditKey(e, "Backspace") || isEditKey(e, "Delete")) {
      e.preventDefault();
      removeChip(i);
    } else if (matches(e, "stepDown") || matches(e, "stepUp")) {
      e.preventDefault();
      const to = i + (matches(e, "stepDown") ? -1 : 1);
      focusAt(offsetOf(parts, to, matches(e, "stepDown") ? parts[to].length : 0));
    }
  }

  return (
    <div className="space-y-1.5">
      {/* raw-control: the group is the field's frame; its text and chips are the controls. */}
      <div
        role="group"
        aria-label={label}
        className={BOX}
        onClick={(e) => {
          if (e.target === e.currentTarget) textRefs.current[Math.ceil(parts.length / 2) - 1]?.focus();
        }}
      >
        {parts.map((part, i) =>
          i % 2 ? (
            // raw-control: a chip is the token and its remove action in one focus stop.
            <button
              key={`c${i}`}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              type="button"
              aria-label={t("ui.templateField.chip", { name: tokenLabel(part) })}
              onClick={() => removeChip(i)}
              onKeyDown={(e) => onChipKey(i, e)}
              className="inline-flex max-w-full items-center gap-1 rounded-control bg-accent/15 px-1.5 py-0.5 text-footnote font-medium text-accent hover:bg-accent/25 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="truncate">{tokenLabel(part)}</span>
              <span aria-hidden="true">×</span>
            </button>
          ) : (
            // The hidden twin sizes the box to the text and wraps it like the field does.
            <span key={`t${i}`} className="relative inline-grid min-w-2 max-w-full">
              <span aria-hidden="true" className={`invisible whitespace-pre-wrap break-words ${TEXT}`}>
                {part || (parts.length === 1 ? placeholder : "") || " "}{" "}
              </span>
              {/* raw-control: a borderless text part inside the field's frame. */}
              <textarea
                ref={(el) => {
                  textRefs.current[i / 2] = el;
                }}
                rows={1}
                value={part}
                aria-label={label}
                placeholder={parts.length === 1 ? placeholder : undefined}
                onChange={(e) => {
                  const next = serialize(parts.map((p, j) => (j === i ? e.target.value.replace(/\n/g, " ") : p)));
                  // A token typed out in full ("{species}") turns into a chip, with the caret after it.
                  commit(next, offsetOf(parts, i, e.target.selectionStart));
                }}
                onSelect={(e) => remember(i, e.currentTarget)}
                onKeyDown={(e) => onTextKey(i, e)}
                // design-token: the frame around all parts shows the focus ring instead
                className={`absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent outline-none placeholder:text-muted ${TEXT}`}
              />
            </span>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Menu
          open={menu.openKey !== null}
          onToggle={() => (menu.openKey ? menu.close() : menu.setOpenKey(true))}
          menuRef={menu.ref}
          className="relative inline-block"
          trigger={(props) => (
            <Button
              {...props}
              variant="secondary"
              size="sm"
              tooltip={{
                label: t("ui.templateField.insert"),
                description: t("ui.templateField.insertHint", { brace: "{" }),
              }}
            >
              {t("ui.templateField.insert")}
            </Button>
          )}
        >
          <MenuPanel align="left" className="max-h-72 w-60 overflow-y-auto!">
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <p className="px-3 pb-0.5 pt-2 text-footnote font-semibold text-muted">{g.label}</p>
                {g.tokens.map((token) => (
                  <MenuItem key={token} onSelect={() => insert(token)}>
                    {tokenLabel(token)}
                  </MenuItem>
                ))}
              </div>
            ))}
          </MenuPanel>
        </Menu>
        {actions}
        {help && <InfoTip paragraphs={help} />}
      </div>
    </div>
  );
}
