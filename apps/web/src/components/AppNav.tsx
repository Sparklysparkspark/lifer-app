import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useNavCountsValue } from "../hooks/useNavCounts";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { Logo } from "./Logo";
import AccountMenu from "./AccountMenu";
import { openLocalLibrary } from "../lib/desktopConnection";
import { isTauri } from "../lib/tauri";
import { backLabelFor } from "../lib/backLabel";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm hover:underline ${isActive ? "font-medium text-ink" : "text-muted"}`;

// The app-wide top bar. The logo links back to the Collection. Search is Cmd/Ctrl+K only.
export default function AppNav() {
  const { user, logout } = useAuth();
  const deploymentMode = useDeploymentMode();
  const navCounts = useNavCountsValue();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  // The page a top-bar link leaves, so the next page's back link names where it goes.
  const from = { backLabel: backLabelFor(pathname, t) };

  // In the desktop app, signing out of a server goes back to the library on this computer.
  async function signOut() {
    await logout();
    if (isTauri()) await openLocalLibrary();
  }

  return (
    <header className="page-header flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface px-6 py-4">
      <div className="shrink-0">
        <Link to="/" aria-label={t("nav.collection")}>
          <Logo variant="wordmark" className="h-7 w-auto" />
        </Link>
        {navCounts && (
          <p className="text-xs text-muted">
            {t("nav.collectedCount", { collected: navCounts.collected, total: navCounts.total })}
          </p>
        )}
      </div>
      <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
        <NavLink to="/import" state={from} className={linkClass}>
          {t("nav.import")}
        </NavLink>
        <NavLink to="/stats" state={from} className={linkClass}>
          {t("nav.stats")}
        </NavLink>
        <NavLink to="/gallery" state={from} className={linkClass}>
          {t("nav.gallery")}
        </NavLink>
        <NavLink
          to="/albums"
          state={from}
          className={({ isActive }) => linkClass({ isActive: isActive || pathname.startsWith("/trips") })}
        >
          {t("nav.albumsAndTrips")}
        </NavLink>
        <NavLink to="/settings" state={from} className={linkClass}>
          {t("nav.settings")}
        </NavLink>
        {/* Desktop's auto-provisioned local user has no real account to manage. */}
        {deploymentMode === "server" && user?.email && <AccountMenu email={user.email} onLogout={signOut} />}
      </nav>
    </header>
  );
}
