import { useTranslation } from "react-i18next";
import { MenuItem } from "./Menu";
import { useOpenInEditors, type EditorTargets } from "../hooks/useOpenInEditors";

/** "Open in Photoshop" and the like for a photo menu. Nothing when no editor is installed or the
 *  files aren't on this computer. */
export default function OpenInMenuItems({
  targets,
  onSelect,
}: {
  targets: EditorTargets;
  /** Runs first, e.g. to close the menu. */
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const { editors, openIn } = useOpenInEditors();
  return editors.map((editor) => (
    <MenuItem
      key={editor.id}
      onSelect={() => {
        onSelect?.();
        openIn(editor, targets);
      }}
    >
      {t("openIn.item", { name: editor.name })}
    </MenuItem>
  ));
}
