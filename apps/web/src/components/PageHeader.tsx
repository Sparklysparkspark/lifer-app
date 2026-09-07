import type { ReactNode } from "react";
import BackToCollectionLink from "./BackToCollectionLink";

// The one shared header every top-level page renders below its route root - standardizes the
// back-link/title layout instead of each page hand-rolling its own (confirmed drift: NearMePage
// put the back link and title side-by-side instead of stacked, and was missing the `mt-1` gap
// under the back link every other page has).
export default function PageHeader({
  title,
  backFallbackTo,
  backLabel,
  titleAddon,
  actions,
  sticky = false,
  children,
}: {
  /** Omit entirely for a page whose real title lives in the body, not the header (e.g. a
   *  species' own hero section) - the header then renders just the back link. */
  title?: ReactNode;
  /** Passed to BackToCollectionLink - see that component's own comment for when a page needs
   *  a non-default fallback/label (e.g. a page reachable from exactly one place). */
  backFallbackTo?: string;
  backLabel?: string;
  /** Rendered inline next to the title (e.g. an InfoTip) - for content that belongs beside the
   *  title itself, not below it (use `children` for that). */
  titleAddon?: ReactNode;
  /** Right-aligned content (a filter dropdown, a search box, a secondary link). */
  actions?: ReactNode;
  /** Only SpeciesDetailPage's loaded view uses this - keeps the header visible while its long
   *  photo grid scrolls underneath. */
  sticky?: boolean;
  /** Extra rows under the title - a description, a metadata line, a status count. */
  children?: ReactNode;
}) {
  return (
    <header
      className={`page-header border-b border-line bg-surface px-6 py-4 ${sticky ? "sticky top-0 z-20" : ""} ${
        actions ? "flex items-start justify-between" : ""
      }`}
    >
      <div className="min-w-0">
        <BackToCollectionLink
          {...(backFallbackTo ? { fallbackTo: backFallbackTo } : {})}
          {...(backLabel ? { label: backLabel } : {})}
          className="text-sm text-muted hover:underline"
        />
        {title != null && (
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-lg font-semibold text-ink">{title}</h1>
            {titleAddon}
          </div>
        )}
        {children}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
