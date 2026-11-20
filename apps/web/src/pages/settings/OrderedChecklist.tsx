import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Checkbox from "../../components/Checkbox";
import { IconButton } from "../../components/Button";

// A checklist whose ticked items are put in order: ticked ones first, in their order, each with
// up and down buttons. The species naming styles and the custom folder layout use it.
export default function OrderedChecklist<T extends string>({
  id,
  options,
  selected,
  onChange,
  disabled,
  label,
  hint,
  minSelected = 0,
}: {
  /** Prefix for each checkbox's id. */
  id: string;
  options: readonly T[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  disabled?: boolean;
  label: (option: T) => string;
  hint?: (option: T) => ReactNode;
  /** Ticked items that can't be unticked once only this many are left. */
  minSelected?: number;
}) {
  const { t } = useTranslation();
  const ordered = [...selected, ...options.filter((o) => !selected.includes(o))];

  function toggle(option: T) {
    onChange(selected.includes(option) ? selected.filter((s) => s !== option) : [...selected, option]);
  }

  function move(option: T, direction: -1 | 1) {
    const i = selected.indexOf(option);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <ul>
      {ordered.map((option) => {
        const selectedIdx = selected.indexOf(option);
        const isSelected = selectedIdx >= 0;
        return (
          <li key={option} className="flex items-center gap-2 py-1 text-callout text-ink">
            <Checkbox
              id={`${id}-${option}`}
              checked={isSelected}
              disabled={disabled || (isSelected && selected.length <= minSelected)}
              onChange={() => toggle(option)}
              className="flex-1"
            >
              <span>
                {label(option)} {hint && <span className="text-footnote text-muted">{hint(option)}</span>}
              </span>
            </Checkbox>
            {isSelected && (
              <div className="flex items-center gap-0.5">
                <IconButton
                  tone="plain"
                  disabled={disabled || selectedIdx === 0}
                  onClick={() => move(option, -1)}
                  aria-label={t("settings.species.moveUp", { name: label(option) })}
                >
                  ↑
                </IconButton>
                <IconButton
                  tone="plain"
                  disabled={disabled || selectedIdx === selected.length - 1}
                  onClick={() => move(option, 1)}
                  aria-label={t("settings.species.moveDown", { name: label(option) })}
                >
                  ↓
                </IconButton>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
