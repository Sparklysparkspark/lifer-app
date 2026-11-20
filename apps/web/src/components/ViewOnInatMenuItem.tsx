import { useTranslation } from "react-i18next";
import { MenuItem } from "./Menu";
import { useInatStatus } from "../hooks/useInatStatus";
import { openExternal } from "../lib/openExternal";

/** "View on iNaturalist" for a photo menu: only when iNaturalist is connected and the photo has an
 *  observation there. */
export default function ViewOnInatMenuItem({
  observationId,
  onSelect,
}: {
  observationId: string | null | undefined;
  /** Runs first, e.g. to close the menu. */
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const inat = useInatStatus();
  if (!inat?.connected || !observationId) return null;
  return (
    <MenuItem
      onSelect={() => {
        onSelect?.();
        openExternal(`https://www.inaturalist.org/observations/${observationId}`);
      }}
    >
      {t("inaturalist.send.view")}
    </MenuItem>
  );
}
