import { useTranslation } from "react-i18next";
import { MenuItem } from "./Menu";
import { useOpenInEditors, type EditorTargets, type PhotoEditor } from "../hooks/useOpenInEditors";

/** "Open in Lightroom Classic" for the chosen editor (Settings > General), and "Open with" each
 *  other one found. Nothing when no editor is installed or the files aren't on this computer. */
export default function OpenInMenuItems({
  targets,
  hasEdit = false,
  onSelect,
}: {
  targets: EditorTargets;
  /** The photo has an edited file beside its RAW: that file can be opened too. */
  hasEdit?: boolean;
  /** Runs first, e.g. to close the menu. */
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const { editors, openIn } = useOpenInEditors();
  const [chosen, ...others] = editors;
  if (!chosen) return null;
  const open = (editor: PhotoEditor, edited = false) => () => {
    onSelect?.();
    openIn(editor, { ...targets, edited });
  };
  return (
    <>
      <MenuItem onSelect={open(chosen)}>{t("openIn.item", { name: chosen.name })}</MenuItem>
      {/* The RAW opens by default, as editors read its sidecar; the edit is a separate file. */}
      {hasEdit && <MenuItem onSelect={open(chosen, true)}>{t("openIn.edited", { name: chosen.name })}</MenuItem>}
      {others.map((editor) => (
        <MenuItem key={editor.id} onSelect={open(editor)}>
          {t("openIn.with", { name: editor.name })}
        </MenuItem>
      ))}
    </>
  );
}
