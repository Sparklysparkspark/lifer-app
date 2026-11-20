import type { QuadSlot } from "@lifer/shared";
import { cropToImageStyle } from "../../lib/crop";
import ProgressiveImg from "../../components/ProgressiveImg";
import Panel from "../../components/Panel";
import Button from "../../components/Button";
import { useTranslation } from "react-i18next";
import SegmentedControl from "../../components/SegmentedControl";

// The album's cover while editing: single photo or quad grid, and which photo (and crop) it shows.
// Picking a tile's photo happens in the grid below, so the page owns `pickingSlot`.
export default function AlbumCoverEditor({
  coverLayout,
  coverPhotoId,
  coverCrop,
  quadSlots,
  pickingSlot,
  replacingWith,
  onReplaceSlot,
  onCancelReplace,
  onSetCoverLayout,
  onCropCover,
  onPickSlot,
  onCropSlot,
}: {
  coverLayout: "single" | "quad";
  coverPhotoId: string | null;
  coverCrop: { x: number | null; y: number | null; size: number | null };
  quadSlots: Array<QuadSlot | null>;
  pickingSlot: number | null;
  /** A photo waiting to replace one of the quad tiles, picked by clicking the tile. */
  replacingWith?: string | null;
  onReplaceSlot?: (slot: number) => void;
  onCancelReplace?: () => void;
  onSetCoverLayout: (layout: "single" | "quad") => void;
  onCropCover: () => void;
  onPickSlot: (slot: number | null) => void;
  onCropSlot: (slot: number) => void;
}) {
  const { t } = useTranslation();
  const coverLayouts = [
    { value: "single", label: t("albums.cover.single") },
    { value: "quad", label: t("albums.cover.quad") },
  ] as const;
  return (
    // Only as wide as its content.
    <Panel className="w-fit max-w-full space-y-3">
      <div className="flex items-center gap-2 text-callout text-muted">
        {t("albums.cover.style")}
        <SegmentedControl value={coverLayout} onChange={onSetCoverLayout} options={coverLayouts} />
      </div>
      {coverLayout === "single" && (
        <div>
          <p className="mb-2 text-footnote text-muted">{t("albums.cover.singleHint")}</p>
          <div className="group relative aspect-square w-48 overflow-hidden rounded-control bg-surface-muted">
            {coverPhotoId && (
              <>
                <ProgressiveImg
                  thumbSrc={`/api/photos/${coverPhotoId}/thumb`}
                  fullSrc={`/api/photos/${coverPhotoId}/thumb`}
                  alt=""
                  className="h-full w-full"
                  style={cropToImageStyle(coverCrop.x, coverCrop.y, coverCrop.size)}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button variant="secondary" size="sm" onClick={onCropCover}>
                    {t("albums.cover.crop")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {coverLayout === "quad" && (
        <div>
          {replacingWith ? (
            <p className="mb-2 text-footnote text-muted">
              {t("albums.cover.replaceHint")}{" "}
              <Button variant="link" size="sm" onClick={onCancelReplace}>
                {t("common.cancel")}
              </Button>
            </p>
          ) : pickingSlot != null ? (
            <p className="mb-2 text-footnote text-muted">
              {t("albums.cover.pickHint")}{" "}
              <Button variant="link" size="sm" onClick={() => onPickSlot(null)}>
                {t("common.cancel")}
              </Button>
            </p>
          ) : (
            <p className="mb-2 text-footnote text-muted">{t("albums.cover.hoverHint")}</p>
          )}
          <div className="grid w-48 grid-cols-2 grid-rows-2 gap-1">
            {quadSlots.map((slot, i) => (
              <div key={i} className="group relative aspect-square overflow-hidden rounded-control bg-surface">
                {slot ? (
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${slot.photoId}/thumb`}
                    fullSrc={`/api/photos/${slot.photoId}/thumb`}
                    alt=""
                    className="h-full w-full"
                    style={cropToImageStyle(slot.cropX, slot.cropY, slot.cropSize)}
                  />
                ) : (
                  <div className="h-full w-full bg-surface-muted" />
                )}
                {replacingWith ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Button variant="secondary" size="sm" className="h-6 px-1.5" onClick={() => onReplaceSlot?.(i)}>
                      {t("albums.cover.replace")}
                    </Button>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button variant="secondary" size="sm" className="h-6 px-1.5" onClick={() => onPickSlot(i)}>
                      {t("albums.cover.change")}
                    </Button>
                    {slot && (
                      <Button variant="secondary" size="sm" className="h-6 px-1.5" onClick={() => onCropSlot(i)}>
                        {t("albums.cover.crop")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
