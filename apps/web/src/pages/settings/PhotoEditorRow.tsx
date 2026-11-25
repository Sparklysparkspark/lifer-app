import { useTranslation } from "react-i18next";
import Select from "../../components/Select";
import { SYSTEM_EDITOR_ID, useOpenInEditors } from "../../hooks/useOpenInEditors";
import { SettingRow } from "./shared";

const OTHER = "__pick";

/** Edit photos with: the editor the viewer's and menus' Open in uses on this computer. The first
 *  one found leads until the user picks, rather than whatever the system opens photos with. */
export default function PhotoEditorRow() {
  const { t } = useTranslation();
  const { editors, choose, pickOther } = useOpenInEditors();
  const apps = editors.filter((e) => e.id !== SYSTEM_EDITOR_ID);
  return (
    <SettingRow
      label={t("settings.general.editor.title")}
      description={t("settings.general.editor.description")}
      control={
        <Select
          variant="form"
          aria-label={t("settings.general.editor.title")}
          value={editors[0]?.id ?? SYSTEM_EDITOR_ID}
          onChange={(e) => (e.target.value === OTHER ? void pickOther() : choose(e.target.value))}
        >
          {apps.map((editor) => (
            <option key={editor.id} value={editor.id}>
              {editor.name}
            </option>
          ))}
          <option value={SYSTEM_EDITOR_ID}>{t("settings.general.editor.system")}</option>
          <option value={OTHER}>{t("settings.general.editor.other")}</option>
        </Select>
      }
    />
  );
}
