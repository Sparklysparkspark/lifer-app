import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { docsUrl } from "../lib/docs";

export interface SettingsGroupSummary {
  id: string;
  label: string;
}

// Presentational: the group list and its visibility rules live in SettingsPage.tsx.
export default function SettingsSidebar({ groups, activeId }: { groups: SettingsGroupSummary[]; activeId: string }) {
  const { t } = useTranslation();
  // Kept across tabs, so the page's back link still names the page Settings was opened from.
  const { state } = useLocation();
  return (
    // Stays put while the section scrolls, below the toolbar or title bar, as in System Settings.
    <nav className="flex shrink-0 flex-col gap-0.5 md:sticky md:top-[calc(var(--mac-title-bar,0px)+1.5rem)] md:w-48 md:self-start">
      {groups.map((group) => (
        <Link
          key={group.id}
          to={`/settings/${group.id}`}
          // Replace, so browser back leaves Settings in one step instead of once per tab visited.
          replace
          state={state}
          aria-current={group.id === activeId ? "page" : undefined}
          className={`rounded-control px-3 py-2.5 text-callout transition-colors ${
            group.id === activeId
              ? "bg-accent text-accent-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)] hover:bg-accent/90"
              : "text-ink hover:bg-surface-muted"
          }`}
        >
          {group.label}
        </Link>
      ))}
      {/* target=_blank links open in the system browser inside the desktop app (see main.tsx). */}
      <a
        href={docsUrl("/settings")}
        // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
        target="_blank"
        rel="noreferrer"
        className="mt-2 flex items-center justify-between rounded-control border-t border-line px-3 py-2.5 text-callout text-muted transition-colors hover:bg-surface-muted hover:text-ink"
      >
        {t("settings.help")}
        <span aria-hidden="true">↗</span>
      </a>
    </nav>
  );
}
