// The desktop app's Mac-style chrome: a sidebar with the main areas, and a toolbar level with the
// window controls holding the page's title, search and Import. Used instead of AppNav's top bar
// in the desktop app when the window is wide enough (useSidebarLayout); the browser keeps AppNav.
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { shortcutLabel } from "../lib/keymap";
import { useTooltip } from "./Tooltip";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useInatStatus } from "../hooks/useInatStatus";
import { useReviewCount } from "../hooks/useReviewCount";
import { formatNumber } from "../lib/format";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useToast } from "../hooks/useToast";
import { backStateFor } from "../lib/backLabel";
import { openLocalLibrary } from "../lib/desktopConnection";
import { pluginIdFromPath, pluginPath, safeAccent, safeIconPath, useHiddenPlugins, usePlugins } from "../lib/plugins";
import { usePluginTitle } from "../lib/pluginHost";
import { SUGGESTED_APPS, offerPath, useSuggestedApps } from "../lib/suggestedApps";
import { isTauri } from "../lib/tauri";
import { buttonClasses } from "../lib/buttonClasses";
import AccountMenu from "./AccountMenu";
import { Logo } from "./Logo";
import { IconButton } from "./Button";
import Menu, { MenuItem, MenuPanel } from "./Menu";

const WIDE = "(min-width: 768px)";

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const HIDDEN_KEY = "lifer:sidebarHidden";

/** Whether the user hid the sidebar (toolbar button, View > Hide Sidebar), kept on this device. */
export function useSidebarHidden(): [boolean, () => void] {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setHidden((was) => {
      try {
        localStorage.setItem(HIDDEN_KEY, was ? "0" : "1");
      } catch {
        // Forgotten next launch; harmless.
      }
      return !was;
    });
  }, []);
  return [hidden, toggle];
}

/** The sidebar layout: the desktop app in a window wide enough for it. */
export function useSidebarLayout(): boolean {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
  return isTauri() && wide;
}

// 18px line icons, drawn to sit with SF Symbols' weight.
function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
// iNaturalist's own logo, so the sidebar entry reads as the service it is.
const INAT_ICON = "/branding/inaturalist.png";

export const ICONS = {
  collection: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z",
  gallery: "M4 6h16v12H4zM4 15l4-4 4 4 3-3 5 5M15 9.5h.01",
  albums: "M7 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7zM7 3v18M4 7h3M4 12h3M4 17h3M11 8.5h5v5h-5z",
  stats: "M5 20V10M12 20V4M19 20v-7",
  review: "M5 4h14v16H5zM8.5 12l2.5 2.5 4.5-5",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 10h0a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  app: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM15.5 13v7M13 16.5h7",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  map: "M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10zM12 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
};

// The toolbar's sidebar button: a panel outline, as in Finder and Mail.
function SidebarIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 5v14" />
    </svg>
  );
}

/** An app's own logo at the 18px of the line icons beside it, with its dark-theme variant if it has one. */
function AppLogo({ src, srcDark }: { src: string; srcDark?: string }) {
  return (
    <>
      {/* design-token: the same 18px as the line icons beside it. */}
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={`h-[18px] w-[18px] shrink-0 object-contain ${srcDark ? "dark:hidden" : ""}`}
      />
      {srcDark && (
        <img
          src={srcDark}
          alt=""
          aria-hidden="true"
          className="hidden h-[18px] w-[18px] shrink-0 object-contain dark:block"
        />
      )}
    </>
  );
}

function SidebarLink({
  to,
  icon,
  iconSrc,
  iconSrcDark,
  label,
  end,
  active,
  isOn,
  tour,
  title,
  iconColor,
  count,
}: {
  to: string;
  /** A line icon's path; or iconSrc, a picture such as a partner's logo, which keeps its own colours. */
  icon?: string;
  iconSrc?: string;
  /** The picture to use on the dark theme, when its colours need a variant. */
  iconSrcDark?: string;
  label: string;
  end?: boolean;
  active?: boolean;
  /** Decides the highlight outright, for two links that share a path (Gallery and Map). */
  isOn?: boolean;
  tour?: string;
  /** Full text for a label that may be cut short. */
  title?: string;
  iconColor?: string;
  /** A trailing count, as Mail shows unread mail; hidden when 0. */
  count?: number;
}) {
  const location = useLocation();
  const { t } = useTranslation();
  const tip = useTooltip(title ? { label: title } : undefined);
  return (
    <>
      <NavLink
        {...tip.props}
        to={to}
        end={end}
        state={backStateFor(location, t)}
        data-tour={tour}
        className={({ isActive }) =>
          `flex min-h-8 items-center gap-2.5 rounded-control px-2.5 py-1.5 text-callout transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
            (isOn ?? (isActive || active))
              ? "bg-accent/15 font-medium text-ink"
              : "text-ink/80 hover:bg-line hover:text-ink"
          }`
        }
      >
        <span style={iconColor ? { color: iconColor } : undefined} className="flex">
          {iconSrc ? <AppLogo src={iconSrc} srcDark={iconSrcDark} /> : <Icon d={icon ?? ""} />}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        {!!count && (
          <span className="ml-auto shrink-0 text-footnote tabular-nums text-muted">{formatNumber(count)}</span>
        )}
      </NavLink>
      {tip.node}
    </>
  );
}

/** The installed apps, minus the ones the user hid. Right-click offers Hide, undone from the toast
 *  or from Settings > Connected apps. */
function PluginLinks() {
  const { t } = useTranslation();
  const toast = useToast();
  const plugins = usePlugins();
  const { hidden, hide, show } = useHiddenPlugins();
  const menu = useDropdownMenu<{ id: string; label: string; point: { x: number; y: number } }>();
  const shown = plugins?.filter((p) => !hidden.has(p.id)) ?? [];
  if (shown.length === 0) return null;
  const open = menu.openKey;
  return (
    <>
      {shown.map((p) => {
        // An installed app Lifer also suggests keeps its own logo in the sidebar.
        const logo = SUGGESTED_APPS.find((a) => a.id === p.id);
        return (
          <div
            key={p.id}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.setOpenKey({ id: p.id, label: p.page.label, point: { x: e.clientX, y: e.clientY } });
            }}
          >
            <SidebarLink
              to={pluginPath(p.id)}
              icon={safeIconPath(p.page.icon) ?? ICONS.app}
              iconSrc={logo?.iconSrc}
              iconSrcDark={logo?.iconSrcDark}
              iconColor={safeAccent(p.page.accent) ?? undefined}
              label={logo?.label ?? p.page.label}
              title={logo?.label ?? p.page.label}
            />
          </div>
        );
      })}
      {open && (
        <Menu open onToggle={menu.close} menuRef={menu.ref} anchorPoint={open.point}>
          <MenuPanel className="max-w-72">
            <MenuItem
              onSelect={() => {
                menu.close();
                hide(open.id);
                toast.show(t("connectedApps.hidden", { name: open.label }), {
                  actions: [{ label: t("connectedApps.undo"), onClick: () => show(open.id) }],
                });
              }}
            >
              <span className="block truncate">{t("connectedApps.hide", { name: open.label })}</span>
            </MenuItem>
          </MenuPanel>
        </Menu>
      )}
    </>
  );
}

/** Apps Lifer suggests, shown only while Show suggested apps is on and they aren't installed. */
function SuggestedLinks() {
  const apps = useSuggestedApps();
  if (apps.length === 0) return null;
  return (
    <>
      {apps.map((a) => (
        <SidebarLink
          key={a.id}
          to={offerPath(a.id)}
          icon={safeIconPath(a.icon) ?? ICONS.app}
          iconSrc={a.iconSrc}
          iconSrcDark={a.iconSrcDark}
          label={a.label}
          title={a.label}
        />
      ))}
    </>
  );
}

export function AppSidebar() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const deploymentMode = useDeploymentMode();
  const inat = useInatStatus();
  const { pathname, search } = useLocation();
  const onMap = new URLSearchParams(search).get("view") === "map";
  const reviewCount = useReviewCount();

  async function signOut() {
    await logout();
    if (isTauri()) await openLocalLibrary();
  }

  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-sidebar/80 backdrop-blur-xl">
      {/* The window controls sit here; the strip drags the window. */}
      <div data-tauri-drag-region="" className="sidebar-window-controls h-[52px] shrink-0" />
      <div className="sidebar-logo px-4 pb-4">
        <Link to="/" aria-label={t("nav.collection")} className="inline-block">
          <Logo variant="wordmark" className="h-6 w-auto" />
        </Link>
      </div>
      <nav aria-label={t("nav.main")} className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          <SidebarLink to="/" end icon={ICONS.collection} label={t("nav.collection")} tour="collection" />
          <SidebarLink
            to="/gallery"
            icon={ICONS.gallery}
            label={t("nav.gallery")}
            tour="gallery"
            isOn={pathname.startsWith("/gallery") && !onMap}
          />
          <SidebarLink
            to="/gallery?view=map"
            icon={ICONS.map}
            label={t("nav.map")}
            tour="map"
            isOn={pathname.startsWith("/gallery") && onMap}
          />
          {/* Trips live on the Albums page, as in Photos; a trip's own page keeps Albums lit. */}
          <SidebarLink
            to="/albums"
            icon={ICONS.albums}
            label={t("nav.albums")}
            tour="albums"
            active={pathname.startsWith("/trips")}
          />
          <SidebarLink to="/stats" icon={ICONS.stats} label={t("nav.stats")} tour="stats" />
          {/* Only while photos wait, but it stays put while you work through the queue. */}
          {(reviewCount > 0 || pathname.startsWith("/review")) && (
            <SidebarLink to="/review" icon={ICONS.review} label={t("nav.review")} count={reviewCount} tour="review" />
          )}
        </div>
        {/* Services and apps beside Lifer's own pages; the divider goes when none is showing. */}
        <div className="mt-1.5 flex flex-col gap-0.5 border-t border-line pt-1.5 empty:hidden">
          {inat?.connected && <SidebarLink to="/inaturalist" iconSrc={INAT_ICON} label={t("nav.inaturalist")} />}
          <PluginLinks />
          <SuggestedLinks />
        </div>
      </nav>
      <div className="flex items-center gap-2 border-t border-line px-2 py-2">
        <div className="flex-1">
          <SidebarLink
            to="/settings"
            icon={ICONS.settings}
            label={t("nav.settings")}
            active={SETTINGS_PAGES.some((p) => pathname.startsWith(p))}
          />
        </div>
        {deploymentMode === "server" && user?.email && <AccountMenu email={user.email} onLogout={signOut} />}
      </div>
    </aside>
  );
}

// Settings and the pages opened from it, which belong to Settings in the toolbar and sidebar.
const SETTINGS_PAGES = [
  "/settings",
  "/tags",
  "/places",
  "/portfolio",
  "/archived",
  "/hidden-species",
  "/archive-health",
  "/sensitive-species",
  "/trash",
];

// The title the toolbar shows for the page the window is on.
function usePageTitle(): string {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const plugins = usePlugins();
  const titles: Array<[string, string]> = [
    ["/gallery", t("nav.gallery")],
    ["/albums", t("nav.albums")],
    ["/trips", t("nav.albums")],
    ["/stats", t("nav.stats")],
    ["/review", t("nav.review")],
    ["/year-in-review", t("nav.stats")],
    ["/explore", t("nav.stats")],
    ["/import", t("nav.import")],
    ...SETTINGS_PAGES.map((p): [string, string] => [p, t("nav.settings")]),
    ["/inaturalist", t("nav.inaturalist")],
    ["/species", t("nav.collection")],
  ];
  const appId = pluginIdFromPath(pathname);
  // The page's own title (host protocol `title`), else its sidebar label.
  const appTitle = usePluginTitle(appId);
  const offered = SUGGESTED_APPS.find((a) => pathname === offerPath(a.id));
  if (offered) return offered.label;
  if (appId !== null) return appTitle ?? plugins?.find((p) => p.id === appId)?.page.label ?? "";
  return titles.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? t("nav.collection");
}

export function AppToolbar({
  sidebarHidden,
  onToggleSidebar,
  children,
}: {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { open } = useCommandPalette();
  const { pathname } = useLocation();
  const title = usePageTitle();
  const appId = pluginIdFromPath(pathname);
  // An app Lifer also suggests is titled by its own name and logo, whatever its page sends.
  const known = appId === null ? undefined : SUGGESTED_APPS.find((a) => a.id === appId);
  const mac = window.liferSetup?.platform === "darwin";
  return (
    <header
      data-tauri-drag-region=""
      className={`page-header sticky top-0 z-30 flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/80 pr-5 backdrop-blur-xl ${
        // With the sidebar hidden, the window controls sit over the toolbar's left end.
        sidebarHidden && mac ? "pl-[84px]" : "pl-3"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconButton
          tone="plain"
          onClick={onToggleSidebar}
          aria-label={sidebarHidden ? t("nav.showSidebar") : t("nav.hideSidebar")}
          tooltip={{ shortcut: shortcutLabel("toggleSidebar") }}
          className="h-8! w-8 hover:bg-surface-muted"
        >
          <SidebarIcon />
        </IconButton>
        <p className="flex min-w-0 items-center gap-2 truncate text-headline font-semibold text-ink" aria-hidden="true">
          {known?.iconSrc && <AppLogo src={known.iconSrc} srcDark={known.iconSrcDark} />}
          <span className="truncate">{known ? known.name : title}</span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        {appId === null && (
          // raw-control: drawn as the search field it opens, not as a button.
          <button
            type="button"
            onClick={open}
            data-tour="search"
            className="flex h-8 w-56 items-center gap-2 rounded-control border border-control-line bg-control px-2.5 text-callout text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Icon d={ICONS.search} />
            <span className="flex-1 text-left">{t("nav.search")}</span>
            <kbd className="text-footnote">{shortcutLabel("palette")}</kbd>
          </button>
        )}
        {!pathname.startsWith("/import") && (
          // Also on an app's page, so photos can be imported without leaving it; secondary there so
          // the app keeps the one primary action.
          <Link
            to="/import"
            data-tour="import"
            className={buttonClasses(appId === null ? "primary" : "secondary", "sm")}
          >
            {t("nav.importPhotos")}
          </Link>
        )}
        {children}
      </div>
    </header>
  );
}
