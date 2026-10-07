import { useTranslation } from "react-i18next";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cropToImageStyle } from "../lib/crop";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { MIN_CARD_CROP_PERCENT } from "@lifer/shared";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";

// Move-and-resize square crop over a photo. The box lives in on-screen pixels and converts to
// the stored width-relative percentages only at save time. Callers persist via onSave/onReset.
export default function CardCropEditor({
  photoUrl,
  initialX,
  initialY,
  initialSize,
  onClose,
  onSave,
  onReset,
}: {
  photoUrl: string;
  initialX: number | null;
  initialY: number | null;
  initialSize: number | null;
  onClose: () => void;
  onSave: (crop: { x: number; y: number; size: number }) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; size: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; box: typeof box } | null>(null);

  function handleImageLoad() {
    const el = imgRef.current;
    if (!el) return;
    const rect = { width: el.clientWidth, height: el.clientHeight };
    setImgSize(rect);

    const maxSize = Math.min(rect.width, rect.height);
    if (initialX != null && initialY != null && initialSize != null) {
      // Clamped so a crop saved before the minimum existed opens at a size Save will accept.
      const size = (initialSize / 100) * rect.width;
      setBox(clamp({ left: (initialX / 100) * rect.width, top: (initialY / 100) * rect.width, size }, rect));
    } else {
      // Default: the largest centered square that fits inside the photo.
      setBox({ left: (rect.width - maxSize) / 2, top: (rect.height - maxSize) / 2, size: maxSize });
    }
  }

  function clamp(
    next: { left: number; top: number; size: number },
    bounds = imgSize,
  ): { left: number; top: number; size: number } {
    if (!bounds) return next;
    // The same floor automatic crops use, relative to the photo so it doesn't depend on screen size.
    const size = Math.min(
      Math.max(next.size, (MIN_CARD_CROP_PERCENT / 100) * bounds.width),
      Math.min(bounds.width, bounds.height),
    );
    const left = Math.min(Math.max(next.left, 0), bounds.width - size);
    const top = Math.min(Math.max(next.top, 0), bounds.height - size);
    return { left, top, size };
  }

  function startDrag(e: ReactPointerEvent, mode: "move" | "resize") {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, box };
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || !drag.box) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.mode === "move") {
      setBox(clamp({ ...drag.box, left: drag.box.left + dx, top: drag.box.top + dy }));
    } else {
      // Resize anchored at the box's top-left corner, dragging the bottom-right handle.
      const delta = Math.max(dx, dy);
      setBox(clamp({ ...drag.box, size: drag.box.size + delta }));
    }
  }

  function endDrag() {
    dragRef.current = null;
  }

  async function save() {
    if (!box || !imgSize) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        x: (box.left / imgSize.width) * 100,
        y: (box.top / imgSize.width) * 100,
        size: (box.size / imgSize.width) * 100,
      });
      onClose();
    } catch {
      setError(t("ui.cropEditor.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function resetCrop() {
    setSaving(true);
    setError(null);
    try {
      await onReset();
      onClose();
    } catch {
      setError(t("ui.cropEditor.resetFailed"));
    } finally {
      setSaving(false);
    }
  }

  useEnterToConfirm(save, !saving && !!box);

  const previewCrop =
    box && imgSize
      ? {
          x: (box.left / imgSize.width) * 100,
          y: (box.top / imgSize.width) * 100,
          size: (box.size / imgSize.width) * 100,
        }
      : null;

  return (
    <Modal open onClose={onClose} size="xl" ariaLabel={t("ui.cropEditor.title")}>
      <p className="mb-2 text-sm text-muted">{t("ui.cropEditor.instructions")}</p>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div
          className="relative flex-1 select-none overflow-hidden rounded-md"
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img ref={imgRef} src={photoUrl} alt="" className="w-full" draggable={false} onLoad={handleImageLoad} />
          {box && (
            <div
              onPointerDown={(e) => startDrag(e, "move")}
              className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
              style={{ left: box.left, top: box.top, width: box.size, height: box.size }}
            >
              <div
                onPointerDown={(e) => startDrag(e, "resize")}
                className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-stone-900 bg-white"
              />
            </div>
          )}
        </div>
        <div className="w-full shrink-0 sm:w-32">
          <p className="mb-1 text-xs text-muted">{t("ui.cropEditor.preview")}</p>
          <div className="relative aspect-square w-full overflow-hidden rounded-md bg-surface-muted sm:w-32">
            {previewCrop && (
              <img src={photoUrl} alt="" style={cropToImageStyle(previewCrop.x, previewCrop.y, previewCrop.size)} />
            )}
          </div>
        </div>
      </div>
      <FormMessage error={error} className="mt-3" />
      <div className="mt-4 flex justify-between">
        <button onClick={resetCrop} disabled={saving} className="text-sm text-muted hover:underline">
          {t("ui.cropEditor.reset")}
        </button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={!box}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
