import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { docsUrl } from "../lib/docs";
import { backStateFor } from "../lib/backLabel";
import Menu, { MenuItem, MenuLink, MenuNote, MenuPanel, MenuSeparator } from "./Menu";

export default function AccountMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const { openKey, setOpenKey, ref } = useDropdownMenu<true>();
  const { t } = useTranslation();
  const location = useLocation();
  const open = openKey === true;
  const initial = email.trim().charAt(0).toUpperCase() || "?";

  return (
    <Menu
      open={open}
      onToggle={() => setOpenKey(open ? null : true)}
      menuRef={ref}
      className="relative"
      trigger={(props) => (
        // raw-control: the account avatar, a round initial rather than a toolbar button.
        <button
          type="button"
          {...props}
          aria-label={t("nav.account.menu")}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-callout font-medium text-canvas hover:opacity-90"
        >
          {initial}
        </button>
      )}
    >
      <MenuPanel className="mt-2! w-56">
        <MenuNote>{email}</MenuNote>
        <MenuSeparator />
        <MenuLink to="/settings/account" state={backStateFor(location, t)}>
          {t("nav.account.settings")}
        </MenuLink>
        <MenuLink href={docsUrl("/intro")}>{t("nav.account.help")}</MenuLink>
        <MenuSeparator />
        <MenuItem onSelect={onLogout}>{t("nav.account.logOut")}</MenuItem>
      </MenuPanel>
    </Menu>
  );
}
