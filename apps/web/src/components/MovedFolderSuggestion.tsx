import { useTranslation } from "react-i18next";
import { parentFolder } from "@lifer/shared";
import { useAddMovedFolder } from "../hooks/useAddMovedFolder";
import Button from "./Button";

/** The one-line offer shown wherever Lifer lists photos it can't find, when they were all in one
 *  folder (`folder`, from commonFolder). The picker opens one level above it. */
export default function MovedFolderSuggestion({ folder }: { folder: string }) {
  const { t } = useTranslation();
  const { choose, node } = useAddMovedFolder();
  return (
    <div className="flex flex-wrap items-center justify-between gap-item">
      <p className="min-w-0 text-callout text-ink">{t("movedPhotos.suggest.line")}</p>
      <Button size="sm" variant="secondary" onClick={() => void choose(parentFolder(folder))}>
        {t("movedPhotos.suggest.add")}
      </Button>
      {node}
    </div>
  );
}
