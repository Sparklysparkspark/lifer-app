import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatNumber } from "../../lib/format";
import Button from "../Button";

const BATCH = 2000;

async function clearInBatches(paths: string[]) {
  let cleared = 0;
  let sidecars = 0;
  const trashed: string[] = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const res = await api.post("/uploads/source-folders/clear", { paths: paths.slice(i, i + BATCH) });
    cleared += res.cleared;
    sidecars += res.sidecars;
    trashed.push(...res.trashed);
  }
  return { cleared, sidecars, trashed };
}

// "Clear out the ones already in Lifer": files in a folder on this computer whose exact bytes the
// library holds go to the system Trash at once, as Move does on import; the toast says how many and
// that they're still in the Trash. The server checks each file and its library copy again; files
// only skipped before are never among them.
export default function ClearKnownFiles({
  paths,
  onCleared,
}: {
  /** Already-imported files from a folder on this computer. */
  paths: string[];
  onCleared: (gone: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const done = await clearInBatches(paths);
      if (done.cleared === 0) {
        toast.show(t("import.known.clearNone"));
        return;
      }
      onCleared(new Set(done.trashed));
      const counts = { count: done.cleared, formatted: formatNumber(done.cleared), sidecars: done.sidecars };
      toast.show(t("import.known.cleared", counts), {
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
