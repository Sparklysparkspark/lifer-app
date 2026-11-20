import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useTip } from "../hooks/useTip";
import { TIPS, type TipId } from "../lib/tips";
import { KEYMAP, shortcutLabel, type KeyAction } from "../lib/keymap";

// A tip, in the page's flow right above what it's about, so it never covers a control. `dark` for
// the photo viewer's black backdrop.
export default function Tip({
  id,
  when = true,
  dark = false,
  takeOver = false,
  className,
}: {
  id: TipId;
  /** The screen is usable for this tip (photos loaded, suggestions shown). */
  when?: boolean;
  dark?: boolean;
  /** Shows in place of the page's tip while open: for tips in a dialog or the photo viewer. */
  takeOver?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { show, dismiss } = useTip(id, when, takeOver);
  if (!show) return null;

  const kbd = dark
    ? "rounded-badge border border-white/30 bg-white/10 px-1.5 py-0.5 font-mono text-caption text-white"
    : "rounded-badge border border-control-line bg-control px-1.5 py-0.5 font-mono text-caption text-ink shadow-xs";
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border px-3 py-2 text-footnote ${
        dark ? "border-white/15 bg-white/10 text-white/85" : "border-accent/40 bg-accent/10 text-ink"
      } ${className ?? ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span className={`font-semibold ${dark ? "text-white" : "text-link"}`}>{t("tips.label")}</span>
      {TIPS[id].steps.map((step, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {step.keys.map((k) => (
            <Fragment key={k}>
              <kbd className={kbd}>{k in KEYMAP ? shortcutLabel(k as KeyAction) : k}</kbd>
            </Fragment>
          ))}
          <span>{t(step.text)}</span>
        </span>
      ))}
      {/* raw-control: follows the tip's own light or dark look. */}
      <button
        type="button"
        onClick={dismiss}
        className={`ml-auto rounded-control px-2 py-0.5 font-medium ${
          dark ? "text-white hover:bg-white/15" : "text-link hover:bg-accent/15"
        }`}
      >
        {t("tips.gotIt")}
      </button>
    </div>
  );
}
