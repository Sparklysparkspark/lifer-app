import ProgressiveImg from "./ProgressiveImg";
import { matches } from "../lib/keymap";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import PageHeader from "./PageHeader";
import InfoTip from "./InfoTip";
import SearchInput from "./SearchInput";
import EmptyState from "./EmptyState";
import Button from "./Button";
import Menu, { MenuItems, MenuPanel, type MenuAction } from "./Menu";
import { Spinner } from "./LoadingScreen";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import TextField from "./TextField";

/** A row's or section's menu action; danger ones go last, in red, and the page confirms them. */
export type ManageMenuItem = MenuAction;

export interface ManageRow {
  key: string;
  primary: ReactNode;
  secondary?: ReactNode;
  /** Muted, right-aligned: a count or a region. */
  trailing?: ReactNode;
  /** A small leading image. */
  thumb?: ReactNode;
  /** The whole row opens this. */
  to?: string;
  linkState?: unknown;
  menu?: ManageMenuItem[];
  /** Rows sharing a section run together under its heading; the page sorts them. */
  section?: string;
  /** Replaces the row's content, e.g. an inline rename field. */
  editor?: ReactNode;
}

// Enough to fill several screens; more on request keeps a list of thousands quick.
const PAGE_SIZE = 200;

// A Settings management page laid out like a macOS list window: back link, title and a one-line
// description on the left, search and page actions in the header's trailing area, and the
// content left-aligned with the header below it.
export default function ManageListPage({
  title,
  backLabel,
  backFallbackTo = "/settings",
  description,
  help,
  docsHref,
  search,
  actions,
  headerExtra,
  banner,
  loading = false,
  error,
  onRetry,
  isEmpty = false,
  empty,
  noMatch,
  wide = false,
  children,
}: {
  title: string;
  backLabel: string;
  /** Where Back goes when there's no history, e.g. a link opened in a new window. */
  backFallbackTo?: string;
  /** One line. Details go in `help` or the docs. */
  description?: ReactNode;
  help?: string[];
  /** A docsUrl() for the "Learn more" link. */
  docsHref?: string;
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  actions?: ReactNode;
  /** Under the description, e.g. tabs. */
  headerExtra?: ReactNode;
  /** A bar between the header and the content, e.g. a selection bar. */
  banner?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Nothing to manage: the empty state shows, and the description, search and actions hide. */
  isEmpty?: boolean;
  /** `action` is for pages whose header actions hide while empty, e.g. an Add button. */
  empty?: { icon: ReactNode; title: string; description: string; action?: { label: string; onClick: () => void } };
  /** Shown instead of the content when a search or filter hides everything. Ignored while the
   *  page's search box is empty, so a page never claims `No places match ""`; a page with other
   *  sections renders ManageNoMatch in place of its list instead. */
  noMatch?: string | null;
  /** Photo grids use the full width; lists stay a readable width. */
  wide?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const ready = !loading && !error;
  const showChrome = ready && !isEmpty;
  const showNoMatch = !!noMatch && (!search || search.value.trim() !== "");

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={title}
        backFallbackTo={backFallbackTo}
        backLabel={backLabel}
        titleAddon={help && showChrome ? <InfoTip paragraphs={help} /> : undefined}
        actions={
          showChrome && (actions || search) ? (
            <>
              {actions}
              {search && (
                <SearchInput
                  value={search.value}
                  onChange={search.onChange}
                  placeholder={search.placeholder}
                  aria-label={search.placeholder}
                  className="w-56"
                />
              )}
            </>
          ) : undefined
        }
      >
        {showChrome && description && (
          <p className="mt-1 max-w-2xl text-subheadline text-muted">
            {description}
            {docsHref && (
              <>
                {" "}
                {/* eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component */}
                <a href={docsHref} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  {t("manageList.learnMore")}
                </a>
              </>
            )}
          </p>
        )}
        {headerExtra}
      </PageHeader>
      {banner}

      <main className="p-page">
        {/* Status screens centre in the window; the list keeps a readable width on the left. */}
        {error ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <p className="text-body text-muted">{error}</p>
            {onRetry && (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                {t("common.retry")}
              </Button>
            )}
          </div>
        ) : loading ? (
          <Spinner />
        ) : isEmpty && empty ? (
          <EmptyState icon={empty.icon} title={empty.title} description={empty.description} action={empty.action} />
        ) : (
          <div className={`space-y-section ${wide ? "" : "max-w-3xl"}`}>
            {showNoMatch ? <ManageNoMatch text={noMatch!} /> : children}
          </div>
        )}
      </main>
    </div>
  );
}

/** "Nothing matches", in place of one list on a page that has other sections too. */
export function ManageNoMatch({ text }: { text: string }) {
  return <p className="py-8 text-body text-muted">{text}</p>;
}

// One grouped list per section: a rounded container with hairline separators, each row with a
// "⋯" menu (shown on hover or focus, always on touch) and the same menu on right-click.
export function ManageList({
  rows,
  label,
  sectionMenu,
}: {
  rows: ManageRow[];
  label: string;
  sectionMenu?: (section: string) => ManageMenuItem[];
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(PAGE_SIZE);
  const menu = useDropdownMenu<{ key: string; point: { x: number; y: number } | null }>();

  const sectionTotals = new Map<string, number>();
  for (const row of rows) if (row.section) sectionTotals.set(row.section, (sectionTotals.get(row.section) ?? 0) + 1);
  const sections: { name: string | undefined; rows: ManageRow[] }[] = [];
  for (const row of rows.slice(0, shown)) {
    const last = sections[sections.length - 1];
    if (last && last.name === row.section) last.rows.push(row);
    else sections.push({ name: row.section, rows: [row] });
  }

  const panel = (items: ManageMenuItem[]) => (
    <MenuPanel>
      <MenuItems items={items} />
    </MenuPanel>
  );

  const menuFor = (key: string, items: ManageMenuItem[] | undefined) => {
    if (!items?.length) return null;
    const open = menu.openKey?.key === key;
    const point = open ? menu.openKey!.point : null;
    return (
      <>
        <Menu
          trigger="plain"
          open={open && !point}
          onToggle={() => menu.setOpenKey(open ? null : { key, point: null })}
          menuRef={menu.ref}
          // Hidden until hover or focus where there's a mouse; touch screens always show it.
          className={`relative z-[1] shrink-0 ${
            open
              ? ""
              : "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100"
          }`}
        >
          {panel(items)}
        </Menu>
        {point && (
          <Menu open onToggle={menu.close} menuRef={menu.ref} anchorPoint={point}>
            {panel(items)}
          </Menu>
        )}
      </>
    );
  };

  const onContextMenu = (key: string, items: ManageMenuItem[] | undefined) => (e: React.MouseEvent) => {
    if (!items?.length) return;
    e.preventDefault();
    menu.setOpenKey({ key, point: { x: e.clientX, y: e.clientY } });
  };

  return (
    <div className="space-y-section">
      {sections.map((section, i) => (
        <section key={`${section.name ?? ""}-${i}`} aria-label={section.name ?? label}>
          {section.name && (
            <div className="group mb-2 flex items-center gap-2 px-4">
              <h2 className="min-w-0 flex-1 truncate text-subheadline font-semibold text-ink">
                {section.name}{" "}
                <span className="font-normal tabular-nums text-muted">{sectionTotals.get(section.name)}</span>
              </h2>
              {sectionMenu && menuFor(`section:${section.name}`, sectionMenu(section.name))}
            </div>
          )}
          <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
            {section.rows.map((row) => (
              <li
                key={row.key}
                onContextMenu={row.editor ? undefined : onContextMenu(row.key, row.menu)}
                className={`group relative flex min-h-11 items-center gap-3 px-4 py-2 first:rounded-t-panel last:rounded-b-panel ${
                  row.to && !row.editor ? "hover:bg-surface-muted" : ""
                }`}
              >
                {row.editor ?? (
                  <>
                    {row.thumb && <div className="shrink-0">{row.thumb}</div>}
                    <div className="min-w-0 flex-1">
                      {row.to ? (
                        <Link
                          to={row.to}
                          state={row.linkState}
                          // Stretched over the row, so the whole row opens it; the menu sits above.
                          // design-token: the focus ring takes the row's own corners (panel at the ends).
                          className="block break-words text-body text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-accent"
                        >
                          {row.primary}
                        </Link>
                      ) : (
                        <p className="break-words text-body text-ink">{row.primary}</p>
                      )}
                      {row.secondary && <div className="break-words text-footnote text-muted">{row.secondary}</div>}
                    </div>
                    {row.trailing && (
                      <span className="max-w-[40%] shrink-0 truncate text-footnote tabular-nums text-muted">
                        {row.trailing}
                      </span>
                    )}
                    {menuFor(row.key, row.menu)}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {rows.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          {t("manageList.showMore", { count: Math.min(PAGE_SIZE, rows.length - shown) })}
        </Button>
      )}
    </div>
  );
}

/** The thumbnail for a species row. */
export function RowThumb({ src, alt }: { src: string | null; alt: string }) {
  return src ? (
    <ProgressiveImg thumbSrc={src} alt={alt} className="h-9 w-9 rounded-badge bg-surface-muted object-cover" />
  ) : (
    <div aria-hidden className="h-9 w-9 rounded-badge bg-surface-muted" />
  );
}

/** The inline rename field a row swaps in while renaming. */
export function RowRenameField({
  label,
  value,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center gap-2">
      <TextField
        autoFocus
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (matches(e, "confirm")) onSave();
          else if (matches(e, "close")) onCancel();
        }}
        className="flex-1"
        size="sm"
      />
      <Button variant="secondary" size="sm" className="shrink-0" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button size="sm" className="shrink-0" onClick={onSave} loading={saving}>
        {saving ? t("common.saving") : t("common.save")}
      </Button>
    </div>
  );
}
