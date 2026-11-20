import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Button from "./Button";
import Menu, { MenuItems, MenuPanel } from "./Menu";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import InlineSpinner from "./InlineSpinner";
import { formatNumber } from "../lib/format";

export interface BarAction {
  key: string;
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
  /** Always in More: occasional fixes that shouldn't crowd the row. */
  menuOnly?: boolean;
}

const ACTION_GAP_PX = 8;

/** The bar's buttons in priority order. Those that don't fit the row go, from the end, into a
 *  "More" menu, so nothing overlaps or clips at any width. */
export default function ActionRow({ actions: items }: { actions: BarAction[] }) {
  const { t } = useTranslation();
  const actions = items.filter((a) => !a.menuOnly);
  const menuOnly = items.filter((a) => a.menuOnly);
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(actions.length);
  const { openKey, setOpenKey, ref: menuRef } = useDropdownMenu<true>();
  const labels = items.map((a) => a.label).join("|");
  const alwaysMore = menuOnly.length > 0;

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    // The hidden copy keeps every button's natural width, whatever is shown right now.
    const fit = () => {
      const widths = [...measure.children].map((c) => (c as HTMLElement).offsetWidth);
      const moreWidth = widths.pop() ?? 0;
      const all = widths.reduce((sum, w) => sum + w + ACTION_GAP_PX, -ACTION_GAP_PX);
      // A row with no width yet (not laid out) shows everything rather than an empty More.
      if (!row.clientWidth || (!alwaysMore && all <= row.clientWidth)) return setShown(widths.length);
      let used = moreWidth;
      let n = 0;
      while (n < widths.length && used + ACTION_GAP_PX + widths[n] <= row.clientWidth)
        used += ACTION_GAP_PX + widths[n++];
      setShown(n);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    return () => observer.disconnect();
  }, [labels, alwaysMore]);

  const visible = actions.slice(0, shown);
  // Delete stays last in the menu.
  const rest = [...actions.slice(shown), ...menuOnly].sort(
    (a, b) => Number(a.variant === "danger") - Number(b.variant === "danger"),
  );
  return (
    <div ref={rowRef} className="relative flex min-w-0 flex-1 items-center justify-end gap-2">
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex h-0 w-0 gap-2 overflow-hidden"
      >
        {actions.map((a) => (
          <Button key={a.key} tabIndex={-1} variant={a.variant ?? "secondary"} size="sm" className="shrink-0">
            {a.label}
          </Button>
        ))}
        <Button tabIndex={-1} variant="secondary" size="sm" className="shrink-0">
          {t("gallery.select.more")}
        </Button>
      </div>
      {visible.map((a) => (
        <Button
          key={a.key}
          variant={a.variant ?? "secondary"}
          size="sm"
          loading={a.loading}
          onClick={a.onClick}
          className="shrink-0"
        >
          {a.label}
        </Button>
      ))}
      {rest.length > 0 && (
        <Menu
          open={!!openKey}
          onToggle={() => setOpenKey(openKey ? null : true)}
          menuRef={menuRef}
          className="relative shrink-0"
          trigger={(props) => (
            <Button variant="secondary" size="sm" {...props}>
              {t("gallery.select.more")}
            </Button>
          )}
        >
          <MenuPanel>
            <MenuItems
              items={rest.map((a) => ({ label: a.label, onSelect: a.onClick, danger: a.variant === "danger" }))}
            />
          </MenuPanel>
        </Menu>
      )}
    </div>
  );
}

/** Select mode's bar, the same on every page: the count, what's working, the page's own links
 *  (Select all), then the actions, or a line asking for a selection. `children` holds dialogs. */
export function SelectionBar({
  count,
  busyLabel,
  links,
  emptyText,
  actions,
  children,
}: {
  count: number;
  busyLabel?: string | null;
  links?: ReactNode;
  emptyText: string;
  actions: BarAction[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface-muted px-page py-2 text-footnote">
      <span className="shrink-0 text-muted">{t("gallery.select.selected", { count: formatNumber(count) })}</span>
      {busyLabel && <InlineSpinner size="xs" label={busyLabel} />}
      {links}
      {count === 0 ? <span className="min-w-0 flex-1 text-muted">{emptyText}</span> : <ActionRow actions={actions} />}
      {children}
    </div>
  );
}
