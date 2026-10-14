import type { ReactNode } from "react";
import BackToCollectionLink from "./BackToCollectionLink";

// The shared back-link and title bar under the app nav.
export default function PageHeader({
  title,
  topLevel = false,
  backFallbackTo,
  backLabel,
  titleAddon,
  actions,
  sticky = false,
  children,
}: {
  /** Omit for a page whose real title lives in the body (a species' hero); only the back link shows. */
  title?: ReactNode;
  /** A page the app nav links to: no back link (the nav reaches every other page) and no visible
   *  title (the nav marks where you are). Without actions or children there's no bar at all. */
  topLevel?: boolean;
  /** Passed to BackToCollectionLink for a page with a non-default fallback or label. */
  backFallbackTo?: string;
  backLabel?: string;
  /** Inline next to the title (e.g. an InfoTip). */
  titleAddon?: ReactNode;
  /** Right-aligned content (a filter, a search box, a secondary link). */
  actions?: ReactNode;
  /** Keeps the header visible while the page scrolls under it. */
  sticky?: boolean;
  /** Extra rows under the title: a description, a metadata line, a status count. */
  children?: ReactNode;
}) {
  if (topLevel && !actions && !children) return <h1 className="sr-only">{title}</h1>;

  return (
    <header
      // A back-link bar reads as part of the app nav above it: the mac title bar only shows its
      // bottom edge once this has scrolled under it too (TitleBarDragRegion). A sticky one never does.
      data-header-extension={!topLevel && !sticky ? "" : undefined}
      // Harmless outside Tauri. Links and buttons inside still take clicks.
      data-tauri-drag-region=""
      className={`page-subheader border-b border-line bg-surface px-6 py-4 ${sticky ? "sticky top-0 z-20" : ""} ${
        actions ? "flex flex-wrap items-start justify-between gap-x-4 gap-y-2" : ""
      }`}
    >
      <div className={`min-w-0 ${actions ? "flex-1" : ""}`}>
        {!topLevel && (
          <BackToCollectionLink
            {...(backFallbackTo ? { fallbackTo: backFallbackTo } : {})}
            {...(backLabel ? { label: backLabel } : {})}
            className="text-sm text-muted hover:underline"
          />
        )}
        {title != null &&
          (topLevel ? (
            <h1 className="sr-only">{title}</h1>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <h1 className="text-lg font-semibold text-ink">{title}</h1>
              {titleAddon}
            </div>
          ))}
        {children}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
