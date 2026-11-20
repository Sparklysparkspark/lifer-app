import { useTranslation } from "react-i18next";
import { MenuItem } from "./Menu";
import { useInatStatus } from "../hooks/useInatStatus";
import { useSendToInat } from "../hooks/useSendToInat";
import ViewOnInatMenuItem from "./ViewOnInatMenuItem";

/** "Send to iNaturalist" for a photo menu, or "View on iNaturalist" once it's there. Nothing until
 *  an account is connected. */
export default function SendToInatMenuItem({
  captureId,
  observationId,
  onSelect,
  onDone,
}: {
  captureId: string;
  observationId: string | null;
  /** Runs first, e.g. to close the menu. */
  onSelect?: () => void;
  /** After a send, e.g. to reload the grid so its badge shows. */
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const inat = useInatStatus();
  const send = useSendToInat();
  if (!inat?.connected) return null;
  if (observationId) return <ViewOnInatMenuItem observationId={observationId} onSelect={onSelect} />;
  return (
    <MenuItem
      onSelect={() => {
        onSelect?.();
        void send([captureId]).then((sent) => sent && onDone?.());
      }}
    >
      {t("inaturalist.send.action")}
    </MenuItem>
  );
}
