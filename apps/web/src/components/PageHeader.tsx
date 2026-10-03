import { useEffect, useRef, useState, type ReactNode } from "react";
import BackToCollectionLink from "./BackToCollectionLink";

// The shared back-link and title bar under the app nav.
export default function PageHeader({
  title,
  backFallbackTo,
  backLabel,
  titleAddon,
  actions,
  sticky = false,
  children,
}: {
  /** Omit for a page whose real title lives in the body (a species' hero); only the back link shows. */
  title?: ReactNode;
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
  // Once stuck to the top it sits where the mac traffic lights float, so index.css shifts its
  // content right while data-stuck is set (only on the desktop app).
  const ref = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!sticky) return;
    function check() {
      const el = ref.current;
      if (el) setStuck(window.scrollY > 0 && el.getBoundingClientRect().top <= 0);
    }
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    check();
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [sticky]);

  return (
    <header
      ref={ref}
      data-stuck={stuck ? "" : undefined}
      // Harmless outside Tauri. Links and buttons inside still take clicks.
      data-tauri-drag-region=""
      className={`page-subheader border-b border-line bg-surface px-6 py-4 ${sticky ? "sticky top-0 z-20" : ""} ${
        actions ? "flex flex-wrap items-start justify-between gap-x-4 gap-y-2" : ""
      }`}
    >
      <div className={`min-w-0 ${actions ? "flex-1" : ""}`}>
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
