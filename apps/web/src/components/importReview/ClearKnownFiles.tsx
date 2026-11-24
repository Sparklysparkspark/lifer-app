import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatNumber } from "../../lib/format";
import Button from "../Button";

const BATCH = 2000;

async function clearInBatches(paths: string[], dryRun: boolean) {
  let cleared = 0;
  const trashed: string[] = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const res = await api.post("/uploads/source-folders/clear", { paths: paths.slice(i, i + BATCH), dryRun });
    cleared += res.cleared;
    trashed.push(...res.trashed);
  }
  return { cleared, trashed };
}

// "Clear out the ones already in Lifer": files in a folder on this computer whose exact bytes the
// library holds go to the system Trash, after saying how many. The server checks each file and its
// library copy again; files only skipped before are never among them.
export default function ClearKnownFiles({
  paths,
  onCleared,
}: {
  /** Already-imported files from a folder on this computer. */
  paths: string[];
  onCleared: (gone: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const { cleared: count } = await clearInBatches(paths, true);
      if (count === 0) {
        toast.show(t("import.known.clearNone"));
        return;
      }
      const n = { count, formatted: formatNumber(count) };
      const ok = await confirm({
        title: t("import.known.clearTitle", n),
        message: t("import.known.clearMessage"),
        confirmLabel: t("import.known.clearConfirm", n),
        danger: true,
      });
      if (!ok) return;
      const done = await clearInBatches(paths, false);
      onCleared(new Set(done.trashed));
      toast.show(t("import.known.cleared", { count: done.cleared, formatted: formatNumber(done.cleared) }), {
        tone: "success",
      });
    } catch (err) {
      toast.error(errorMessage(err, t("import.known.clearFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="link" size="sm" loading={busy} onClick={() => void run()}>
      {t("import.known.clear")}
    </Button>
  );
}
