import type { ReactNode } from "react";
import Panel from "./Panel";

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
    <Panel as="section">
      <h2 className="text-callout font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-footnote text-muted">{description}</p>}
      {children && <div className="mt-item space-y-3">{children}</div>}
    </Panel>
  );
}
