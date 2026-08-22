import { Link } from "react-router-dom";
import type { CollectionItem } from "@lifer/shared";
import { cropToImageStyle } from "../lib/crop";
import ProgressiveImg from "./ProgressiveImg";

const TIER_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
  unrated: "Unrated",
};

export default function SpeciesCard({ item, regionId }: { item: CollectionItem; regionId?: string }) {
  const isUnseen = item.state === "unseen";
  const isSeen = item.state === "seen";

  return (
    <Link
      to={regionId ? `/species/${item.speciesId}?regionId=${regionId}` : `/species/${item.speciesId}`}
      className={`group block overflow-hidden rounded-lg border border-stone-200 bg-white transition hover:shadow-md ${
        isUnseen ? "opacity-60" : ""
      }`}
    >
      <div className={`relative aspect-square overflow-hidden bg-stone-100 ${isSeen ? "grayscale" : ""}`}>
        {item.coverPhotoUrl ? (
          // Only a captured photo (served from /api/photos/.../thumb) has a matching
          // /display derivative to upgrade to; an external reference-photo thumbnail has no
          // such counterpart to swap in, so it's left as-is.
          item.coverPhotoUrl.startsWith("/api/photos/") ? (
            <ProgressiveImg
              thumbSrc={item.coverPhotoUrl}
              fullSrc={item.coverPhotoUrl.replace(/\/thumb$/, "/display")}
              alt={item.commonName ?? item.scientificName}
              className="h-full w-full"
              style={cropToImageStyle(item.cardCropX, item.cardCropY, item.cardCropSize)}
            />
          ) : (
            <img
              src={item.coverPhotoUrl}
              alt={item.commonName ?? item.scientificName}
              className="h-full w-full"
              style={cropToImageStyle(item.cardCropX, item.cardCropY, item.cardCropSize)}
            />
          )
        ) : (
          <div className="flex h-full w-full items-center justify-center text-stone-300">?</div>
        )}
        {isSeen && (
          <span
            className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-xs font-bold text-stone-600 shadow"
            title="Seen, not yet photographed"
          >
            ✓
          </span>
        )}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-medium text-stone-900">{item.commonName ?? item.scientificName}</p>
        <p className="truncate text-xs italic text-stone-500">{item.scientificName}</p>
        {(item.tier || item.localTier || item.endemic || item.vagrant) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {item.tier && (
              <span
                className={
                  item.tier === "unrated"
                    ? "inline-block rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-stone-400"
                    : "inline-block rounded-full bg-stone-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-stone-600"
                }
                title={item.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : undefined}
              >
                {TIER_LABEL[item.tier] ?? item.tier}
              </span>
            )}
            {/* Region-scoped rarity — only present when viewing a region's checklist,
               ranked against species actually found there instead of the global,
               effort-weighted score. */}
            {item.localTier && (
              <span
                className="inline-block rounded-full border border-stone-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-stone-500"
                title="Rarity ranked against other species in this region specifically"
              >
                {TIER_LABEL[item.localTier] ?? item.localTier} here
              </span>
            )}
            {item.endemic && (
              <span
                className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700"
                title="Only ever recorded in one country"
              >
                Endemic
              </span>
            )}
            {/* Region-scoped, same as localTier above — records here cluster in very few
               years rather than spreading out, a real vagrancy signature explaining why
               localTier reads rarer than raw record count alone would suggest. */}
            {item.vagrant && (
              <span
                className="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-700"
                title="Records here are concentrated in very few years — likely a vagrant, not an established local presence"
              >
                Vagrant
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
