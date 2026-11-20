import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format";

/** Free space beside a download size, or why it won't fit. Uses the same 10% margin as the
 *  server's check (packages/core/src/lib/freeSpace.ts). */
export default function FreeSpaceNote({ needed, free }: { needed: number; free: number | null }) {
  const { t } = useTranslation();
  if (free == null) return null;
  if (needed * 1.1 <= free)
    return <span className="ml-2 text-footnote">{t("offlinePacks.selection.free", { size: formatBytes(free) })}</span>;
  return (
    // design-token: the error rose of FormMessage, with no error token in the theme yet.
    <span className="ml-2 text-footnote text-rose-700 dark:text-rose-400">
      {t("offlinePacks.selection.tooBig", { needed: formatBytes(needed), free: formatBytes(free) })}
    </span>
  );
}
