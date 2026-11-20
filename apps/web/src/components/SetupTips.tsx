import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SETUP_TIPS, SETUP_TIP_MS } from "../lib/setupTips";
import { matchAction, shortcutLabel } from "../lib/keymap";
import { docsUrl } from "../lib/docs";
import { openExternal } from "../lib/openExternal";
import { ICONS } from "./AppSidebar";
import Button, { IconButton } from "./Button";
import Panel from "./Panel";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** What Lifer can do, one card at a time, while setup works. Moves on by itself until the user
 *  pages (arrows or the Left and Right keys), never with reduced motion. Never blocks anything. */
export default function SetupTips() {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(() => !reducedMotion());
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % SETUP_TIPS.length), SETUP_TIP_MS);
    return () => clearTimeout(timer);
  }, [auto, index]);

  const go = (step: number) => {
    setAuto(false);
    setIndex((i) => (i + step + SETUP_TIPS.length) % SETUP_TIPS.length);
  };
  function onKeyDown(e: KeyboardEvent) {
    const action = matchAction(e, ["previous", "next"] as const);
    if (action) {
      e.preventDefault();
      go(action === "previous" ? -1 : 1);
    }
  }

  const tip = SETUP_TIPS[index];
  return (
    <Panel as="section" aria-label={t("setupTips.label")} onKeyDown={onKeyDown} className="flex items-center gap-3">
      <IconButton aria-label={t("tour.back")} onClick={() => go(-1)}>
        <span aria-hidden="true">‹</span>
      </IconButton>
      <div className="flex min-w-0 flex-1 items-start gap-3" aria-live={auto ? "off" : "polite"}>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="mt-0.5 h-6 w-6 shrink-0 text-accent"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={ICONS[tip.icon]} />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-headline font-semibold text-ink">{t(tip.title)}</p>
          <p className="mt-1 text-callout text-muted">
            {t(tip.body, { palette: shortcutLabel("palette"), shortcuts: shortcutLabel("shortcuts") })}
          </p>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-footnote text-muted tabular-nums">
              {t("tour.position", { current: index + 1, total: SETUP_TIPS.length })}
            </p>
            <Button variant="link" size="sm" onClick={() => openExternal(docsUrl(tip.guide))}>
              {t("setupTips.guide")}
            </Button>
          </div>
        </div>
      </div>
      <IconButton aria-label={t("tour.next")} onClick={() => go(1)}>
        <span aria-hidden="true">›</span>
      </IconButton>
    </Panel>
  );
}
