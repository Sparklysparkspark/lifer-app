import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDesktopMode } from "../hooks/useDesktopMode";
import SpeciesPicker from "./SpeciesPicker";
import { Logo } from "./Logo";
import AccountMenu from "./AccountMenu";

// The one top nav bar in the app (previously inline in CollectionPage.tsx, the only page that
// ever rendered it — every other page uses PageHeader's own lighter back-link/title bar
// instead). Extracted so account/logout no longer sits as permanent inline text
// ("user@email.com · Log out") taking up nav space on every visit — that's now tucked behind
// AccountMenu, a small icon opened on demand, matching how API keys were already moved off this
// same bar into Settings for the same "occasional action, not everyday nav" reason.
export default function AppNav({ collectedCount, totalCount }: { collectedCount: number; totalCount: number | null }) {
  const { user, logout } = useAuth();
  const isDesktopMode = useDesktopMode();

  return (
    <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
      <div>
        <Logo variant="wordmark" className="h-7 w-auto" />
        {totalCount != null && (
          <p className="text-xs text-muted">
            {collectedCount} / {totalCount} collected
          </p>
        )}
      </div>
      <div className="flex items-center gap-4">
        <SpeciesPicker />
        <Link to="/import" className="text-sm text-muted hover:underline">
          Import
        </Link>
        <Link to="/stats" className="text-sm text-muted hover:underline">
          Stats
        </Link>
        <Link to="/gallery" className="text-sm text-muted hover:underline">
          Gallery
        </Link>
        <Link to="/albums" className="text-sm text-muted hover:underline">
          {isDesktopMode ? "Albums & Trips" : "Albums"}
        </Link>
        <Link to="/settings" className="text-sm text-muted hover:underline">
          Settings
        </Link>
        {!isDesktopMode && user?.email && <AccountMenu email={user.email} onLogout={() => logout()} />}
      </div>
    </header>
  );
}
