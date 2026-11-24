import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";
import FolderPath from "./FolderPath";
import SearchInput from "./SearchInput";

// Lists longer than this get a filter box.
const FILTER_AT = 8;

export interface FolderListItem {
  path: string;
  /** false: the folder isn't there now (an unplugged drive), said under its name. */
  available?: boolean;
  /** A line under the folder, e.g. that a folder above it already covers it. */
  note?: ReactNode;
}

/** A compact list of folders for Settings, each name first with its full path on hover: filterable
 *  past 8, scrolling past a few screens of rows. Each row ends in `renderControl` (a menu, a switch)
 *  or, given `onRemove`, a remove button. */
export default function FolderList<T extends FolderListItem>({
  label,
  folders,
  onRemove,
  renderControl,
}: {
  label: string;
  folders: T[];
  onRemove?: (path: string) => void;
  renderControl?: (folder: T) => ReactNode;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? folders.filter((f) => f.path.toLowerCase().includes(q)) : folders;
  return (
    <>
      {folders.length > FILTER_AT && (
        <SearchInput
          value={query}
          onChange={setQuery}
          aria-label={t("movedPhotos.settings.filterLabel", { list: label })}
          placeholder={t("movedPhotos.settings.filterPlaceholder")}
        />
      )}
      <ul aria-label={label} className="max-h-72 divide-y divide-line overflow-y-auto">
        {shown.map((f) => (
          <li key={f.path} className="flex min-h-9 items-center justify-between gap-item py-1">
            <div className="min-w-0 flex-1">
              <FolderPath path={f.path} className="text-callout" />
              {f.available === false && (
                <p className="text-footnote text-muted">{t("movedPhotos.settings.notFound")}</p>
              )}
              {f.note && <div className="text-footnote text-muted">{f.note}</div>}
            </div>
            {renderControl?.(f)}
            {onRemove && (
              <IconButton
                tone="plain"
                onClick={() => onRemove(f.path)}
                aria-label={t("movedPhotos.settings.removeFolder", { folder: f.path })}
              >
                ✕
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {q && shown.length === 0 && <p className="text-callout text-muted">{t("movedPhotos.settings.noMatch")}</p>}
    </>
  );
}
