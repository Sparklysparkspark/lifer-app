import { Link } from "react-router-dom";

export interface SettingsGroupSummary {
  id: string;
  label: string;
}

// Presentational only — the actual group list (with visibility rules) lives in SettingsPage.tsx,
// right next to the section components it's choosing between; this just renders whatever list
// it's handed as a left-hand nav, highlighting the active one.
export default function SettingsSidebar({ groups, activeId }: { groups: SettingsGroupSummary[]; activeId: string }) {
  return (
    <nav className="flex shrink-0 flex-col gap-0.5 md:w-48">
      {groups.map((group) => (
        <Link
          key={group.id}
          to={`/settings/${group.id}`}
          // Switching tabs replaces the current history entry instead of pushing a new one —
          // otherwise clicking through several tabs meant "back to Collection" had to be
          // clicked once per tab visited (real browser back, which BackToCollectionLink uses)
          // before it actually left Settings.
          replace
          className={`rounded-md px-3 py-2.5 text-sm transition-colors ${
            group.id === activeId
              ? "bg-accent text-accent-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]"
              : "text-ink hover:bg-surface-muted"
          }`}
        >
          {group.label}
        </Link>
      ))}
    </nav>
  );
}
