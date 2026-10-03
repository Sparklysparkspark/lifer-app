import { Link } from "react-router-dom";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { docsUrl } from "../lib/docs";

const itemClass = "block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted";

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
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-sm font-medium text-canvas hover:opacity-90"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-md border border-line bg-surface py-1 shadow-md">
          <p className="truncate px-3 py-2 text-sm text-muted">{email}</p>
          <Link to="/settings/account" onClick={close} className={itemClass}>
            Account settings
          </Link>
          {/* target=_blank links open in the system browser inside the desktop app (see main.tsx). */}
          <a href={docsUrl()} target="_blank" rel="noreferrer" onClick={close} className={`${itemClass} flex items-center justify-between`}>
            Help
            <span aria-hidden="true" className="text-muted">
              ↗
            </span>
          </a>
          <button
            type="button"
            onClick={() => {
              close();
              onLogout();
            }}
            className={itemClass}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
