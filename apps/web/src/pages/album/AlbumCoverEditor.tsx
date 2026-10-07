import type { QuadSlot } from "@lifer/shared";
import { cropToImageStyle } from "../../lib/crop";

const QUAD_TILE_BUTTON = "rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-ink hover:bg-white";

function layoutButtonClass(active: boolean): string {
  return `rounded-md border px-2 py-1 text-xs ${active ? "border-ink bg-surface text-ink" : "border-line hover:bg-surface"}`;
}

// "Edit cover": single photo or quad grid, and for a quad, which photo (and crop) each tile shows.
// Picking a tile's photo happens in the grid below, so the page owns `pickingSlot`.
export default function AlbumCoverEditor({
  coverLayout,
  quadSlots,
  pickingSlot,
  onSetCoverLayout,
  onPickSlot,
  onCropSlot,
}: {
  coverLayout: "single" | "quad";
  quadSlots: Array<QuadSlot | null>;
  pickingSlot: number | null;
  onSetCoverLayout: (layout: "single" | "quad") => void;
  onPickSlot: (slot: number | null) => void;
  onCropSlot: (slot: number) => void;
}) {
  return (
    <div className="mb-4">
      <div className="space-y-3 rounded-md border border-line bg-surface-muted p-3">
        <div className="flex items-center gap-2 text-sm text-muted">
          Cover style
          <button onClick={() => onSetCoverLayout("single")} className={layoutButtonClass(coverLayout === "single")}>
            Single photo
          </button>
          <button onClick={() => onSetCoverLayout("quad")} className={layoutButtonClass(coverLayout === "quad")}>
            Quad grid
          </button>
        </div>
        {coverLayout === "quad" && (
          <div>
            {pickingSlot != null ? (
              <p className="mb-2 text-xs text-muted">
                Click a photo below to use it in this tile.{" "}
                <button onClick={() => onPickSlot(null)} className="underline hover:text-ink">
                  Cancel
                </button>
              </p>
            ) : (
              <p className="mb-2 text-xs text-muted">Hover a tile to change its photo or crop.</p>
            )}
            <div className="grid w-48 grid-cols-2 grid-rows-2 gap-1">
              {quadSlots.map((slot, i) => (
                <div key={i} className="group relative aspect-square overflow-hidden rounded-md bg-surface">
                  {slot ? (
                    <img
                      src={`/api/photos/${slot.photoId}/thumb`}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                      style={cropToImageStyle(slot.cropX, slot.cropY, slot.cropSize)}
                    />
                  ) : (
                    <div className="h-full w-full bg-surface-muted" />
                  )}
                  <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => onPickSlot(i)} className={QUAD_TILE_BUTTON}>
                      Change
                    </button>
                    {slot && (
                      <button onClick={() => onCropSlot(i)} className={QUAD_TILE_BUTTON}>
                        Crop
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
