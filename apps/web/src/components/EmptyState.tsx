import type { ReactNode } from "react";

// The icon-circle + heading + description shape already used identically by
// ArchivedSpeciesPage.tsx and HiddenSpeciesPage.tsx, pulled out here now that a third and fourth
// caller (Albums/Trips empty states) need the same look — those two previously fell back to a
// single plain <p>, reading noticeably plainer than every other "nothing here yet" screen in the
// app. `action` is new: unlike Archived/Hidden (no single action un-empties "nothing archived
// yet"), an empty Albums/Trips tab has one obvious next step worth surfacing right there.
export default function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted">{icon}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
