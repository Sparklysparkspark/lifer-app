import type { ReactNode } from "react";

/** The app's panel: a titled white card on the page background (Settings, the species page). */
export default function Card({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-panel">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      {children && <div className="mt-item space-y-3">{children}</div>}
    </section>
  );
}
