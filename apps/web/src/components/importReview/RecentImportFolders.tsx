import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../../api/client";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { formatNumber } from "../../lib/format";
import Button from "../Button";
import { Tooltip } from "../Tooltip";

type Folder = ApiResponse<"/uploads/source-folders">["folders"][number];

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean);
const folderName = (p: string) => parts(p).pop() ?? p;
// Past this many, the rest wait behind "Show more", so years of imports don't fill the page.
const SHOWN = 6;

// Desktop: folders imported from before, each with a quiet count of photos added since. The count
// only compares names, sizes and dates (nothing is read), one folder at a time, when the page opens.
// Nothing is imported until the user clicks.
export default function RecentImportFolders({
  onImport,
  busyPath,
}: {
  onImport: (path: string) => void;
  /** The folder being read right now. */
  busyPath: string | null;
}) {
  const { t } = useTranslation();
  const desktop = useDeploymentMode() === "desktop";
  const [folders, setFolders] = useState<Folder[]>([]);
  // undefined while counting, null when the folder is gone or its drive unplugged.
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      const list = await api.get("/uploads/source-folders").then(
        (r) => r.folders,
        () => [],
      );
      if (cancelled) return;
      setFolders(list);
      for (const f of list) {
        const res = await api.post("/uploads/source-folders/new-count", { path: f.path }).catch(() => null);
        if (cancelled) return;
        setCounts((prev) => ({ ...prev, [f.path]: res?.available ? res.newCount : null }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const shown = folders.filter((f) => counts[f.path] !== null);
  if (!desktop || shown.length === 0) return null;
  // Same-named folders (DCIM, 100CANON) show their parent too.
  const names = shown.map((f) => folderName(f.path));
  const nameOf = (path: string) => {
    const name = folderName(path);
    return names.filter((n) => n === name).length > 1 ? parts(path).slice(-2).join("/") : name;
  };
  const hidden = shown.length - SHOWN;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-callout text-muted">{t("import.recentFolders.title")}</span>
      {(all ? shown : shown.slice(0, SHOWN)).map((f) => {
        const count = counts[f.path];
        const name = nameOf(f.path);
        return (
          <Tooltip key={f.path} content={{ label: f.path }}>
            {(tip) => (
              <Button
                {...tip}
                variant="secondary"
                size="sm"
                loading={busyPath === f.path}
                disabled={busyPath != null || count === 0}
                aria-label={t("import.recentFolders.importNew", { name })}
                onClick={() => onImport(f.path)}
              >
                <span className="max-w-48 truncate">{name}</span>
                {count != null && (
                  <span className="text-muted">
                    {count > 0
                      ? t("import.recentFolders.newCount", { count, formatted: formatNumber(count) })
                      : t("import.recentFolders.nothingNew")}
                  </span>
                )}
              </Button>
            )}
          </Tooltip>
        );
      })}
      {hidden > 0 && (
        <Button variant="link" size="sm" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all
            ? t("import.recentFolders.fewer")
            : t("import.recentFolders.more", { count: hidden, formatted: formatNumber(hidden) })}
        </Button>
      )}
    </div>
  );
}
