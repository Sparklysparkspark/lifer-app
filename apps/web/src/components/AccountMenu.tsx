import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { docsUrl } from "../lib/docs";
import { backStateFor } from "../lib/backLabel";
import { MENU_ITEM, MENU_PANEL, MENU_SEPARATOR } from "../lib/menuClasses";

export default function AccountMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const { openKey, setOpenKey, ref, close } = useDropdownMenu<true>();
  const { t } = useTranslation();
  const location = useLocation();
  const open = openKey === true;
  const initial = email.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpenKey(open ? null : true)}
        aria-label={t("nav.account.menu")}
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-sm font-medium text-canvas hover:opacity-90"
      >
        {initial}
      </button>
      {open && (
        <div className={`absolute right-0 top-full z-20 mt-2 w-56 ${MENU_PANEL}`}>
          <p className="truncate px-3 py-1.5 text-muted">{email}</p>
          <div className={MENU_SEPARATOR} />
          <Link to="/settings/account" state={backStateFor(location, t)} onClick={close} className={MENU_ITEM}>
            {t("nav.account.settings")}
          </Link>
          {/* target=_blank links open in the system browser inside the desktop app (see main.tsx). */}
          <a href={docsUrl()} target="_blank" rel="noreferrer" onClick={close} className={MENU_ITEM}>
            {t("nav.account.help")}
          </a>
          <div className={MENU_SEPARATOR} />
          <button
            type="button"
            onClick={() => {
              close();
              onLogout();
            }}
            className={MENU_ITEM}
          >
            {t("nav.account.logOut")}
          </button>
        </div>
      )}
    </div>
  );
}
