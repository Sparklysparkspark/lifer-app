import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import Tip from "../../components/Tip";
import Button from "../../components/Button";
import { buttonClasses } from "../../lib/buttonClasses";
import { useToast } from "../../hooks/useToast";

// Under a similar group's count: back to the list of groups, and the two ways to be done with this
// one. Both drop the group for good, and the toast's Undo brings it back.
export default function SimilarGroupActions({ captureId, alone }: { captureId: string; alone: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function dismiss(message: string) {
    setBusy(true);
    try {
      const { captureIds } = await api.post("/gallery/similar/dismiss", { captureId });
      navigate("/gallery/similar");
      toast.show(message, {
        tone: "success",
        actions: [
          {
            label: t("species.edits.undo"),
            onClick: () =>
              void api
                .delete("/gallery/similar/dismiss", { captureIds })
                .then(() => navigate(`/gallery?similarTo=${captureId}`))
                .catch(() => toast.error(t("similar.dismissFailed"))),
          },
        ],
      });
    } catch {
      toast.error(t("similar.dismissFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {!alone && <Tip id="similar-group" className="w-full" />}
      <Link to="/gallery/similar" className={buttonClasses("link", "sm")}>
        {t("similar.backToGroups")}
      </Link>
      {!alone && (
        <>
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void dismiss(t("similar.keptAll"))}>
            {t("similar.keepAll")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void dismiss(t("similar.markedNotSimilar"))}
          >
            {t("similar.notSimilar")}
          </Button>
        </>
      )}
    </div>
  );
}
