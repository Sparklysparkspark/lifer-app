import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../../api/client";
import { formatDate, formatNumber } from "../../lib/format";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import Button from "../Button";
import Modal from "../Modal";
import Panel from "../Panel";

type Skipped = ApiResponse<"/uploads/skipped">;

// Photos left out of earlier imports stay out when their folder is picked again. This lists them,
// and Forget lets one be offered again next time.
export default function SkippedPhotosManager() {
  const { t } = useTranslation();
  const toast = useToast();
  const [data, setData] = useState<Skipped | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(
    () =>
      api
        .get("/uploads/skipped")
        .then(setData)
        .catch(() => {}),
    [],
  );
  useEffect(() => void load(), [load]);

  async function forget(body: { fingerprints?: string[]; all?: boolean }) {
    try {
      await api.post("/uploads/skipped/forget", body);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t("import.skippedManager.forgetFailed")));
    }
  }

  if (!data || data.total === 0) return null;
  const reasons: Record<Skipped["files"][number]["reason"], string> = {
    removed: t("import.skippedManager.removed"),
    not_wildlife: t("import.skippedManager.notWildlife"),
    no_animal: t("import.skippedManager.noAnimal"),
  };

  return (
    <>
      <Button variant="link" size="sm" onClick={() => setOpen(true)}>
        {t("import.skippedManager.open", { count: data.total, formatted: formatNumber(data.total) })}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={t("import.skippedManager.title")}
        description={t("import.skippedManager.description")}
        footerStart={
          <Button variant="secondary" onClick={() => void forget({ all: true })}>
            {t("import.skippedManager.forgetAll")}
          </Button>
        }
        footer={<Button onClick={() => setOpen(false)}>{t("import.skippedManager.done")}</Button>}
      >
        <Panel grouped>
          {data.files.map((f) => (
            <div key={f.fingerprint} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-callout text-ink wrap-anywhere">{f.name}</p>
                <p className="text-footnote text-muted">
                  {reasons[f.reason]}, {formatDate(f.createdAt)}
                </p>
              </div>
              <Button variant="link" size="sm" onClick={() => void forget({ fingerprints: [f.fingerprint] })}>
                {t("import.skippedManager.forget")}
              </Button>
            </div>
          ))}
        </Panel>
        {data.total > data.files.length && (
          <p className="mt-2 text-footnote text-muted">
            {t("import.skippedManager.latest", {
              count: data.files.length,
              formatted: formatNumber(data.files.length),
            })}
          </p>
        )}
      </Modal>
    </>
  );
}
