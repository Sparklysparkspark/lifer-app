import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectLocation } from "../lib/libraryLocations";
import Button from "./Button";

/** One click to mount a network share holding the library; only this button waits. */
export default function ConnectShareButton({
  mountPath,
  name,
  onDone,
}: {
  mountPath: string;
  name: string;
  onDone?: (connected: boolean) => void;
}) {
  const { t } = useTranslation();
  const connect = useConnectLocation();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const ok = await connect(mountPath, name);
        setBusy(false);
        onDone?.(ok);
      }}
    >
      {t("libraryLocations.connect", { name })}
    </Button>
  );
}
