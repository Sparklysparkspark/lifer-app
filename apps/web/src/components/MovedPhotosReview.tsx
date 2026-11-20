import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { movedPhotosChanged, useUndoRelinks } from "../hooks/useMovedPhotos";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { formatNumber } from "../lib/format";
import { ignore } from "../lib/ignore";
import { useSpeciesName } from "../lib/speciesName";
import Button from "./Button";
import FolderPath from "./FolderPath";
import { ManageList, RowThumb } from "./ManageListPage";
import Modal from "./Modal";

type Reviews = ApiResponse<"/moved-photos/reviews">;

/** The matches Lifer won't guess: pick the file that is the photo, or skip it. */
export default function MovedPhotosReview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const undo = useUndoRelinks();
  const speciesName = useSpeciesName();
  const [data, setData] = useState<Reviews | null>(null);

  const load = useCallback(() => {
    api.get("/moved-photos/reviews").then(setData).catch(ignore("Couldn't load moved photos to review"));
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function pick(originalId: string, path: string) {
    try {
      const res = await api.post(apiPath("/moved-photos/reviews/{id}/use", { id: originalId }), { path });
      movedPhotosChanged();
      load();
      toast.show(t("movedPhotos.found", { count: 1 }), {
        tone: "success",
        actions: [{ label: t("movedPhotos.undo"), onClick: () => void undo(res.batchId) }],
      });
    } catch (err) {
      toast.error(errorMessage(err, t("movedPhotos.failed")));
    }
  }

  async function skip(originalId: string) {
    await api
      .post(apiPath("/moved-photos/reviews/{id}/dismiss", { id: originalId }))
      .catch(ignore("Couldn't skip a moved photo"));
    movedPhotosChanged();
    load();
  }

  const items = data?.items ?? [];
  const sectionOf = new Map(items.map((i) => [i.path, i.originalId]));
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t("movedPhotos.reviewDialog.title")}
      description={t("movedPhotos.reviewDialog.description")}
      footer={<Button onClick={onClose}>{t("common.done")}</Button>}
    >
      {data && items.length === 0 ? (
        <p className="text-callout text-muted">{t("movedPhotos.reviewDialog.empty")}</p>
      ) : (
        <>
          {data && data.total > items.length && (
            <p className="mb-2 text-subheadline text-muted">
              {t("movedPhotos.reviewDialog.showingFirst", {
                shown: formatNumber(items.length),
                total: formatNumber(data.total),
              })}
            </p>
          )}
          <ManageList
            label={t("movedPhotos.reviewDialog.title")}
            sectionMenu={(section) => [
              { label: t("movedPhotos.reviewDialog.skip"), onSelect: () => void skip(sectionOf.get(section)!) },
            ]}
            rows={items.flatMap((item) =>
              item.candidates.map((c) => ({
                key: `${item.originalId}:${c.path}`,
                // Grouped under where the photo was.
                section: item.path,
                thumb: <RowThumb src={item.photoId ? `/api/photos/${item.photoId}/thumb` : null} alt="" />,
                primary: <FolderPath path={c.path} />,
                secondary: [
                  t(
                    item.reason === "probably"
                      ? "movedPhotos.reviewDialog.probably"
                      : "movedPhotos.reviewDialog.several",
                  ),
                  item.scientificName &&
                    speciesName({ commonName: item.commonName, scientificName: item.scientificName }),
                ]
                  .filter(Boolean)
                  .join(" · "),
                trailing: (
                  <Button size="sm" variant="secondary" onClick={() => void pick(item.originalId, c.path)}>
                    {t("movedPhotos.reviewDialog.use")}
                  </Button>
                ),
                menu: [
                  { label: t("movedPhotos.reviewDialog.use"), onSelect: () => void pick(item.originalId, c.path) },
                  { label: t("movedPhotos.reviewDialog.skip"), onSelect: () => void skip(item.originalId) },
                ],
              })),
            )}
          />
        </>
      )}
    </Modal>
  );
}
