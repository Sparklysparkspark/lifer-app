import { Link } from "react-router-dom";
import { docsUrl } from "../lib/docs";

export interface SettingsGroupSummary {
  id: string;
  label: string;
}

// Presentational: the group list and its visibility rules live in SettingsPage.tsx.
export default function SettingsSidebar({ groups, activeId }: { groups: SettingsGroupSummary[]; activeId: string }) {
  return (
    <nav className="flex shrink-0 flex-col gap-0.5 md:w-48">
      {groups.map((group) => (
        <Link
          key={group.id}
          to={`/settings/${group.id}`}
          // Replace, so browser back leaves Settings in one step instead of once per tab visited.
          replace
          className={`rounded-md px-3 py-2.5 text-sm transition-colors ${
            group.id === activeId ? "bg-accent text-accent-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]" : "text-ink hover:bg-surface-muted"
          }`}
        >
          {group.label}
        </Link>
      ))}
      {/* target=_blank links open in the system browser inside the desktop app (see main.tsx). */}
      <a
        href={docsUrl("/settings")}
        target="_blank"
        rel="noreferrer"
        className="mt-2 flex items-center justify-between rounded-md border-t border-line px-3 py-2.5 text-sm text-muted transition-colors hover:bg-surface-muted hover:text-ink"
      >
        Help
        <span aria-hidden="true">↗</span>
      </a>
    </nav>
  );
}
