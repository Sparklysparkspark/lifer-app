import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { movedPhotosChanged, useUndoRelinks } from "../hooks/useMovedPhotos";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { formatNumber, metaLine } from "../lib/format";
import { ignore } from "../lib/ignore";
import { photoSlide } from "../lib/photoSlide";
import { useSpeciesName } from "../lib/speciesName";
import Button from "./Button";
import FolderPath from "./FolderPath";
import { ManageList, RowThumb } from "./ManageListPage";
import Modal from "./Modal";
import { useLightbox, type LightboxSlide } from "./Lightbox";

type Reviews = ApiResponse<"/moved-photos/reviews">;

const candidatePreview = (originalId: string, index: number) =>
  `/api/moved-photos/reviews/${originalId}/candidates/${index}/preview`;

/** The matches Lifer won't guess: pick the file that is the photo, or skip it. */
export default function MovedPhotosReview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const undo = useUndoRelinks();
  const speciesName = useSpeciesName();
  const [data, setData] = useState<Reviews | null>(null);
  const viewer = useLightbox();

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
    try {
      await api.post(apiPath("/moved-photos/reviews/{id}/dismiss", { id: originalId }));
    } catch (err) {
      toast.error(errorMessage(err, t("movedPhotos.reviewDialog.skipFailed")));
      return;
    }
    movedPhotosChanged();
    load();
    toast.show(t("movedPhotos.reviewDialog.skipped"), {
      tone: "success",
      actions: [{ label: t("common.undo"), onClick: () => void unskip(originalId) }],
    });
  }

  async function unskip(originalId: string) {
    try {
      await api.post(apiPath("/moved-photos/reviews/{id}/restore", { id: originalId }));
    } catch (err) {
      toast.error(errorMessage(err, t("movedPhotos.reviewDialog.unskipFailed")));
      return;
    }
    movedPhotosChanged();
    load();
  }

  // The photo as Lifer has it beside the file offered, so arrows in the viewer flip between them.
  function compareSlides(item: Reviews["items"][number], index: number, candidatePath: string): LightboxSlide[] {
    const preview = candidatePreview(item.originalId, index);
    const candidate = { url: `${preview}?size=full`, thumbUrl: preview, caption: candidatePath };
    return item.photoId
      ? [photoSlide({ photoId: item.photoId }, { caption: t("movedPhotos.reviewDialog.inLifer") }), candidate]
      : [candidate];
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
      {viewer.node}
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
              item.candidates.map((c, index) => ({
                key: `${item.originalId}:${c.path}`,
                // Grouped under where the photo was.
                section: item.path,
                thumb: (
                  <div className="flex gap-1">
                    {item.photoId ? (
                      // raw-control: the photo as Lifer has it, opening full size to compare by eye.
                      <button
                        type="button"
                        aria-label={t("movedPhotos.reviewDialog.inLifer")}
                        onClick={() => viewer.open(compareSlides(item, index, c.path), 0)}
                        className="rounded-badge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <RowThumb src={`/api/photos/${item.photoId}/thumb`} alt="" />
                      </button>
                    ) : (
                      <RowThumb src={null} alt="" />
                    )}
                    {/* raw-control: the file offered, beside the photo, opening full size too. */}
                    <button
                      type="button"
                      aria-label={c.path}
                      onClick={() => viewer.open(compareSlides(item, index, c.path), item.photoId ? 1 : 0)}
                      className="rounded-badge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <RowThumb src={candidatePreview(item.originalId, index)} alt="" />
                    </button>
                  </div>
                ),
                primary: <FolderPath path={c.path} />,
                secondary: metaLine([
                  t(
                    item.reason === "probably"
                      ? "movedPhotos.reviewDialog.probably"
                      : "movedPhotos.reviewDialog.several",
                  ),
                  item.scientificName &&
                    speciesName({ commonName: item.commonName, scientificName: item.scientificName }),
                ]),
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
