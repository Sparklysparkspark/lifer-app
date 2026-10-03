import { useEffect, useSyncExternalStore } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { Logo } from "./Logo";
import AccountMenu from "./AccountMenu";
import { openLocalLibrary } from "../lib/desktopConnection";
import { isTauri } from "../lib/tauri";

// The collection publishes its "collected / total" count here for the nav to show.
type NavCounts = { collected: number; total: number } | null;
let counts: NavCounts = null;
const listeners = new Set<() => void>();
function setCounts(next: NavCounts) {
  if (counts?.collected === next?.collected && counts?.total === next?.total) return;
  counts = next;
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const getCounts = () => counts;

/** Shows "collected / total" under the logo while the calling page is mounted. */
export function useNavCounts(collected: number, total: number | null): void {
  useEffect(() => {
    setCounts(total == null ? null : { collected, total });
  }, [collected, total]);
  useEffect(() => () => setCounts(null), []);
}

const linkClass = ({ isActive }: { isActive: boolean }) => `text-sm hover:underline ${isActive ? "font-medium text-ink" : "text-muted"}`;

// The app-wide top bar. The logo links back to the Collection. Search is Cmd/Ctrl+K only.
export default function AppNav() {
  const { user, logout } = useAuth();
  const deploymentMode = useDeploymentMode();
  const navCounts = useSyncExternalStore(subscribe, getCounts, getCounts);
  const { pathname } = useLocation();

  // In the desktop app, signing out of a server goes back to the library on this computer.
  async function signOut() {
    await logout();
    if (isTauri()) await openLocalLibrary();
  }

  return (
    <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
      <div>
        <Link to="/" aria-label="Collection">
          <Logo variant="wordmark" className="h-7 w-auto" />
        </Link>
        {navCounts && (
          <p className="text-xs text-muted">
            {navCounts.collected} / {navCounts.total} collected
          </p>
        )}
      </div>
      <nav className="flex items-center gap-4">
        <NavLink to="/import" className={linkClass}>
          Import
        </NavLink>
        <NavLink to="/stats" className={linkClass}>
          Stats
        </NavLink>
        <NavLink to="/gallery" className={linkClass}>
          Gallery
        </NavLink>
        <NavLink to="/albums" className={({ isActive }) => linkClass({ isActive: isActive || pathname.startsWith("/trips") })}>
          Albums & trips
        </NavLink>
        <NavLink to="/settings" className={linkClass}>
          Settings
        </NavLink>
        {/* Desktop's auto-provisioned local user has no real account to manage. */}
        {deploymentMode === "server" && user?.email && <AccountMenu email={user.email} onLogout={signOut} />}
      </nav>
    </header>
  );
}
