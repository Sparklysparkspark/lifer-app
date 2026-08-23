import { useRef, useState } from "react";
import { api } from "../api/client";
import { cropToImageStyle } from "../lib/crop";

const MIN_SIZE_PX = 40;

// A real move+resize square selection over the full photo — drag the box to move it, drag
// the handle at its corner to resize. Box state is tracked in on-screen pixels relative to
// the image's rendered bounding rect; only converted to the stored width-relative fractions
// (see migration 006) at save time, so none of the drag math needs to know the photo's
// natural resolution.
export default function CardCropEditor({
  speciesId,
  photoUrl,
  initialX,
  initialY,
  initialSize,
  onClose,
  onSaved,
}: {
  speciesId: string;
  photoUrl: string;
  initialX: number | null;
  initialY: number | null;
  initialSize: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; size: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; box: typeof box } | null>(null);

  function handleImageLoad() {
    const el = imgRef.current;
    if (!el) return;
    const rect = { width: el.clientWidth, height: el.clientHeight };
    setImgSize(rect);

    const maxSize = Math.min(rect.width, rect.height);
    if (initialX != null && initialY != null && initialSize != null) {
      const size = (initialSize / 100) * rect.width;
      setBox({ left: (initialX / 100) * rect.width, top: (initialY / 100) * rect.width, size });
    } else {
      // Default: the largest centered square that fits inside the photo.
      setBox({ left: (rect.width - maxSize) / 2, top: (rect.height - maxSize) / 2, size: maxSize });
    }
  }

  function clamp(next: { left: number; top: number; size: number }): { left: number; top: number; size: number } {
    if (!imgSize) return next;
    const size = Math.min(Math.max(next.size, MIN_SIZE_PX), Math.min(imgSize.width, imgSize.height));
    const left = Math.min(Math.max(next.left, 0), imgSize.width - size);
    const top = Math.min(Math.max(next.top, 0), imgSize.height - size);
    return { left, top, size };
  }

  function startDrag(mode: "move" | "resize") {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      dragRef.current = { mode, startX: e.clientX, startY: e.clientY, box };
    };
  }

  function handlePointerMove(e: React.PointerEvent) {
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
    try {
      await api.patch(`/species/${speciesId}/card-crop`, {
        x: (box.left / imgSize.width) * 100,
        y: (box.top / imgSize.width) * 100,
        size: (box.size / imgSize.width) * 100,
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function resetCrop() {
    setSaving(true);
    try {
      await api.patch(`/species/${speciesId}/card-crop`, { reset: true });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const previewCrop = box && imgSize
    ? { x: (box.left / imgSize.width) * 100, y: (box.top / imgSize.width) * 100, size: (box.size / imgSize.width) * 100 }
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2 text-sm text-muted">Drag the box to move it, drag the corner handle to resize.</p>
        <div className="flex flex-col gap-4 sm:flex-row">
          <div
            className="relative flex-1 select-none overflow-hidden rounded-md"
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
          >
            <img
              ref={imgRef}
              src={photoUrl}
              alt=""
              className="w-full"
              draggable={false}
              onLoad={handleImageLoad}
            />
            {box && (
              <div
                onPointerDown={startDrag("move")}
                className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
                style={{ left: box.left, top: box.top, width: box.size, height: box.size }}
              >
                <div
                  onPointerDown={startDrag("resize")}
                  className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-stone-900 bg-white"
                />
              </div>
            )}
          </div>
          <div className="w-full shrink-0 sm:w-32">
            <p className="mb-1 text-xs text-muted">Card preview</p>
            <div className="relative aspect-square w-full overflow-hidden rounded-md bg-surface-muted sm:w-32">
              {previewCrop && (
                <img src={photoUrl} alt="" style={cropToImageStyle(previewCrop.x, previewCrop.y, previewCrop.size)} />
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-between">
          <button onClick={resetCrop} disabled={saving} className="text-sm text-muted hover:underline">
            Reset to default
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface-muted">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !box}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
