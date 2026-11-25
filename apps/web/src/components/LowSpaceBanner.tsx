import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format";
import { checkImportSpace, type ImportSpace } from "../lib/importSpace";
import { dismissLowSpace, shouldShowLowSpace } from "../lib/lowSpaceDismissal";
import { IconButton } from "./Button";

export const LOW_SPACE_CHECK_MS = 5 * 60_000;

/** One quiet line under the toolbar while the drive holding Lifer's data and database has less
 *  free than the room Lifer keeps (apps/api/src/lib/importSpace.ts), anywhere in the app. */
export default function LowSpaceBanner() {
  const { t } = useTranslation();
  const [space, setSpace] = useState<ImportSpace | null>(null);
  // Fallback for blocked storage; the remembered dismissal lives in lowSpaceDismissal.
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const check = () => void checkImportSpace(0, 0).then((s) => live && setSpace(s));
    check();
    const timer = setInterval(check, LOW_SPACE_CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!space || space.free === null || !shouldShowLowSpace(space) || (hiddenAt !== null && space.free >= hiddenAt / 2))
    return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-line bg-surface-muted px-6 py-1.5 text-footnote text-muted"
    >
      <p className="min-w-0 flex-1">{t("status.lowSpace.message", { free: formatBytes(space.free) })}</p>
      <IconButton
        tone="plain"
        onClick={() => {
          dismissLowSpace(space);
          setHiddenAt(space.free);
        }}
        aria-label={t("status.lowSpace.dismiss")}
      >
        ✕
      </IconButton>
    </div>
  );
}
