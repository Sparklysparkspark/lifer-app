import { useTranslation } from "react-i18next";
import { useApp } from "../../app/AppContext";
import { useSyncProgress } from "../../sync/progress";
import { syncLine } from "../../format/format";
import { Note } from "../../ui";

/** The one calm sync line (MR4). Offline is a state, never an error. */
export function SyncNote() {
  const { t } = useTranslation();
  const { sync, paired, mode } = useApp();
  const progress = useSyncProgress();
  if (mode === "standalone") return <Note text={t("sync.standalone")} />;
  if (sync.keyRefused) return <Note text={t("sync.keyRefused")} />;
  const line = syncLine({
    syncing: sync.syncing,
    lastSyncAt: sync.lastSyncAt,
    waiting: sync.waiting,
    now: new Date(),
    reachable: sync.reachable,
    desktop: paired?.hub.kind === "desktop",
  });
  const { key, ...values } = line;
  const text = t(key, values);
  return <Note text={sync.syncing && progress ? `${text} (${progress})` : text} />;
}
