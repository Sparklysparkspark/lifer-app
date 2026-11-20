import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Menu, { MenuItem, MenuLink, MenuPanel } from "../../components/Menu";
import RenameModal from "../../components/RenameModal";
import TargetListImportModal from "../../components/TargetListImportModal";
import { useConfirm } from "../../hooks/useConfirm";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { formatNumber } from "../../lib/format";
import { targetListsChanged, useTargetLists, type TargetList } from "../../lib/targetLists";
import { SettingRow } from "./shared";

/** Target lists: import one, and view, rename or delete each. Sits beside the eBird import. */
export default function TargetListsRow() {
  const { t } = useTranslation();
  const lists = useTargetLists();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const menu = useDropdownMenu<string>();
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<TargetList | null>(null);

  async function remove(list: TargetList) {
    const ok = await confirm({
      title: t("targetLists.deleteConfirm.title", { name: list.name }),
      message: t("targetLists.deleteConfirm.message"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api.delete(apiPath("/target-lists/{id}", { id: list.id }));
      targetListsChanged();
    } catch {
      setError(t("targetLists.deleteFailed"));
    }
  }

  return (
    <>
      <SettingRow
        label={t("targetLists.settings.label")}
        description={t("targetLists.settings.description")}
        control={
          <Button variant="secondary" size="sm" onClick={() => setImporting(true)}>
            {t("targetLists.importAction")}
          </Button>
        }
      >
        {error && <FormMessage error={error} />}
      </SettingRow>
      {lists?.map((list) => (
        <SettingRow
          key={list.id}
          label={<span className="break-words">{list.name}</span>}
          description={
            list.regionName
              ? t("targetLists.summaryRegion", { count: formatNumber(list.speciesIds.length), region: list.regionName })
              : t("targetLists.summaryGeneral", { count: formatNumber(list.speciesIds.length) })
          }
          control={
            <Menu
              open={menu.openKey === list.id}
              onToggle={() => menu.setOpenKey(menu.openKey === list.id ? null : list.id)}
              menuRef={menu.ref}
              className="relative shrink-0"
              trigger="plain"
            >
              <MenuPanel className="whitespace-nowrap">
                <MenuLink
                  to={`/?${new URLSearchParams({
                    ...(list.regionId ? { region: list.regionId } : {}),
                    show: "target",
                    targetList: list.id,
                  })}`}
                >
                  {t("targetLists.view")}
                </MenuLink>
                <MenuItem onSelect={() => setRenaming(list)}>{t("common.rename")}</MenuItem>
                <MenuItem onSelect={() => void remove(list)}>{t("common.delete")}</MenuItem>
              </MenuPanel>
            </Menu>
          }
        />
      ))}
      {importing && <TargetListImportModal onClose={() => setImporting(false)} />}
      {renaming && (
        <RenameModal
          title={t("targetLists.renameTitle")}
          initialName={renaming.name}
          onCancel={() => setRenaming(null)}
          onSave={async (name) => {
            await api.patch(apiPath("/target-lists/{id}", { id: renaming.id }), { name });
            targetListsChanged();
            setRenaming(null);
          }}
        />
      )}
    </>
  );
}
