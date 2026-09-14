import { Link } from "react-router-dom";
import { useDropdownMenu } from "../hooks/useDropdownMenu";

// Replaces the inline "user@email.com · Log out" text that used to sit directly in the nav bar
// (real nav-bar space for something used rarely, not on every visit) — same click-outside-closes
// shell useDropdownMenu already provides for every other dropdown in the app (Gallery's photo
// menu, OfflinePacksPage's group tabs), just with its own small trigger rather than DotMenu's
// "⋯" bubble, which is styled for overlaying a photo tile, not sitting in a nav bar.
export default function AccountMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const { openKey, setOpenKey, ref, close } = useDropdownMenu<true>();
  const open = openKey === true;
  const initial = email.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpenKey(open ? null : true)}
        aria-label="Account menu"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-sm font-medium text-canvas hover:opacity-90"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-md border border-line bg-surface py-1 shadow-md">
          <p className="truncate px-3 py-2 text-sm text-muted">{email}</p>
          <Link
            to="/settings/account"
            onClick={close}
            className="block px-3 py-2 text-sm text-ink hover:bg-surface-muted"
          >
            Account settings
          </Link>
          <button
            type="button"
            onClick={() => {
              close();
              onLogout();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
