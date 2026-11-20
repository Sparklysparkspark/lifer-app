import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { Logo } from "./Logo";
import AccountMenu from "./AccountMenu";
import UpdatesBanner from "./UpdatesBanner";
import { openLocalLibrary } from "../lib/desktopConnection";
import { isTauri } from "../lib/tauri";
import { useInatStatus } from "../hooks/useInatStatus";
import { useReviewCount } from "../hooks/useReviewCount";
import { formatNumber } from "../lib/format";
import { pluginIdFromPath } from "../lib/plugins";
import { backStateFor } from "../lib/backLabel";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `-mx-1.5 rounded-control px-1.5 py-1.5 text-callout hover:bg-surface-muted ${isActive ? "font-medium text-ink" : "text-muted"}`;

// The app-wide top bar: the Collection (also the logo) and the other main pages, which therefore
// need no back link (PageHeader's topLevel). Search is Cmd/Ctrl+K only.
export default function AppNav() {
  const { user, logout } = useAuth();
  const deploymentMode = useDeploymentMode();
  const inat = useInatStatus();
  const location = useLocation();
  const { t } = useTranslation();
  // The page a top-bar link leaves, so the next page's back link names where it goes.
  const from = backStateFor(location, t);
  const onGallery = location.pathname.startsWith("/gallery");
  const onMap = new URLSearchParams(location.search).get("view") === "map";
  const reviewCount = useReviewCount();

  // In the desktop app, signing out of a server goes back to the library on this computer.
  async function signOut() {
    await logout();
    if (isTauri()) await openLocalLibrary();
  }

  return (
    <>
      <header className="page-header flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface px-6 py-4">
        <div className="shrink-0">
          <Link to="/" aria-label={t("nav.collection")} className="rounded-control transition-opacity hover:opacity-80">
            <Logo variant="wordmark" className="h-7 w-auto" />
          </Link>
        </div>
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
          {/* `end`: only the Collection itself, not every page under "/". */}
          <NavLink to="/" end className={linkClass} data-tour="collection">
            {t("nav.collection")}
          </NavLink>
          {/* The sidebar's order (AppSidebar). Gallery and Map share a path, so the view decides. */}
          <NavLink
            to="/gallery"
            state={from}
            data-tour="gallery"
            className={() => linkClass({ isActive: onGallery && !onMap })}
          >
            {t("nav.gallery")}
          </NavLink>
          <NavLink
            to="/gallery?view=map"
            state={from}
            data-tour="map"
            className={() => linkClass({ isActive: onGallery && onMap })}
          >
            {t("nav.map")}
          </NavLink>
          {/* Trips live on the Albums page, so a trip's own page keeps Albums marked. */}
          <NavLink
            to="/albums"
            state={from}
            data-tour="albums"
            className={({ isActive }) => linkClass({ isActive: isActive || location.pathname.startsWith("/trips") })}
          >
            {t("nav.albums")}
          </NavLink>
          <NavLink to="/stats" state={from} className={linkClass} data-tour="stats">
            {t("nav.stats")}
          </NavLink>
          {(reviewCount > 0 || location.pathname.startsWith("/review")) && (
            <NavLink to="/review" state={from} className={linkClass} data-tour="review">
              {t("nav.review")}
              {reviewCount > 0 && <span className="ml-1.5 tabular-nums text-muted">{formatNumber(reviewCount)}</span>}
            </NavLink>
          )}
          {inat?.connected && (
            <NavLink to="/inaturalist" state={from} className={linkClass}>
              {t("nav.inaturalist")}
            </NavLink>
          )}
          {pluginIdFromPath(location.pathname) === null && (
            <NavLink to="/import" state={from} className={linkClass} data-tour="import">
              {t("nav.import")}
            </NavLink>
          )}
          <NavLink to="/settings" state={from} className={linkClass}>
            {t("nav.settings")}
          </NavLink>
          {/* Desktop's auto-provisioned local user has no real account to manage. */}
          {deploymentMode === "server" && user?.email && <AccountMenu email={user.email} onLogout={signOut} />}
        </nav>
      </header>
      {/* In normal flow under the nav, so a waiting update never covers page content. */}
      <UpdatesBanner />
    </>
  );
}
