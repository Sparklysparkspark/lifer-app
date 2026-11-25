import type { CSSProperties, ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import StarRating from "./StarRating";
import { MenuGroup, MenuItem, MenuLink, MenuNote, MenuPanel, MenuSection } from "./Menu";
import RevealOriginalMenuItem from "./RevealOriginalMenuItem";
import OpenInMenuItems from "./OpenInMenuItems";
import SendToInatMenuItem from "./SendToInatMenuItem";
import { downloadWithToast } from "../lib/downloadFile";
import { useToast } from "../hooks/useToast";
import { useRevealOriginal } from "../hooks/useRevealOriginal";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useConnectLocation } from "../lib/libraryLocations";
import { isPhotoVersionsOpen, openPhotoVersions } from "../lib/photoVersions";
import { fileNameOf, photoFilePaths } from "../lib/photoFilePaths";

/** What the menu needs to know about one photo; every page maps its own item to this. */
export interface PhotoMenuPhoto {
  captureId: string;
  photoId: string;
  kind?: "image" | "video" | "audio" | null;
  rating?: number | null;
  speciesId?: string | null;
  originalRef?: string | null;
  /** The RAW beside an edited original, offered in Show in Finder too. */
  rawRef?: string | null;
  originalKind?: string | null;
  /** False for a linked file Lifer didn't copy in; only then is its path worth copying. */
  originalManaged?: boolean | null;
  /** False when the original's drive is disconnected or the file is gone. */
  originalAvailable?: boolean | null;
  originalVolumeLabel?: string | null;
  /** Mount point of the unmounted network share holding the original, when Lifer can connect it. */
  originalSharePath?: string | null;
  hasRaw?: boolean;
  inatObservationId?: string | null;
}

/** The one per-photo menu, in one order everywhere. A page offers an action by passing its
 *  handler; an item without a handler or the data behind it is left out. */
export default function PhotoMenu({
  ref,
  style,
  photo,
  onClose,
  speciesLinkState,
  onRate,
  featured,
  onToggleFeatured,
  coverItems,
  onAddToAlbum,
  onEditTags,
  onCorrectId,
  onTagSpecies,
  location,
  onSetLocation,
  onAdjustTime,
  onInatSent,
  onVersionsChange,
  onHide,
  endItems,
  onDelete,
  onDeleteWithRaw,
}: {
  /** From Menu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  photo: PhotoMenuPhoto;
  onClose: () => void;
  /** Shows "View species", with this back-link state; leave out on the species page itself. */
  speciesLinkState?: object;
  onRate?: (rating: number | null) => void;
  /** It is its species' featured photo. */
  featured?: boolean;
  onToggleFeatured?: () => void;
  /** The page's own cover choices (album or trip cover), after the featured photo. */
  coverItems?: ReactNode;
  onAddToAlbum?: () => void;
  onEditTags?: () => void;
  onCorrectId?: () => void;
  onTagSpecies?: () => void;
  location?: string | null;
  /** Coordinates, places, and the place name and region (CoordinatesModal), as on the map. */
  onSetLocation?: () => void;
  /** Opens the date and time editor for this photo. */
  onAdjustTime?: () => void;
  /** After a send to iNaturalist, e.g. to reload so the badge shows. */
  onInatSent?: () => void;
  /** After a change in the Versions panel, e.g. to reload the shown photo. */
  onVersionsChange?: () => void;
  onHide?: () => void;
  /** The page's own removal (remove from album), before Delete. */
  endItems?: ReactNode;
  onDelete?: () => void;
  /** Shown only when a RAW sits beside an edited original; a RAW-only photo's Delete covers its RAW. */
  onDeleteWithRaw?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reveal = useRevealOriginal()(photo.originalRef);
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const kind = photo.kind ?? "image";
  const files = photoFilePaths(photo.originalRef, photo.rawRef);
  const unavailable = !!photo.originalRef && photo.originalAvailable === false;
  const desktop = useDeploymentMode() === "desktop";
  const connectLocation = useConnectLocation();
  const download = (path: string, name: string) =>
    act(() => void downloadWithToast(toast, `/api/photos/${photo.photoId}/${path}?download=1`, name));
  const copyPath = (path: string) =>
    // navigator.clipboard is missing on plain-http origins, e.g. a server reached over the LAN.
    void (navigator.clipboard?.writeText(path) ?? Promise.reject()).then(
      () => toast.success(t("species.edits.pathCopied")),
      () => toast.error(t("species.edits.copyPathFailed")),
    );

  return (
    <MenuPanel ref={ref} style={style} className="max-h-[70vh] w-max min-w-56 overflow-y-auto overflow-x-hidden">
      {/* Sized to its longest item, as a native menu is; a long place name wraps at the cap. Menu
          sets the panel's own max width to fit the window, so the cap sits on this wrapper. */}
      <div className="max-w-[20rem]">
        {/* Not an item: a rating can be nudged without reopening the menu. */}
        {onRate && (
          <MenuGroup label={t("photoMenu.rate")}>
            <StarRating rating={photo.rating ?? null} onRate={onRate} />
          </MenuGroup>
        )}
        <MenuSection>
          {speciesLinkState && photo.speciesId && (
            <MenuLink to={`/species/${photo.speciesId}`} state={speciesLinkState}>
              {t("photoMenu.viewSpecies")}
            </MenuLink>
          )}
          {onToggleFeatured && (
            <MenuItem onSelect={act(onToggleFeatured)}>
              {featured ? t("photoMenu.unfeature") : t("photoMenu.feature")}
            </MenuItem>
          )}
          {coverItems}
          {onCorrectId && <MenuItem onSelect={act(onCorrectId)}>{t("photoMenu.correctId")}</MenuItem>}
          {onTagSpecies && <MenuItem onSelect={act(onTagSpecies)}>{t("photoMenu.tagSpecies")}</MenuItem>}
        </MenuSection>
        <MenuSection>
          {onAddToAlbum && <MenuItem onSelect={act(onAddToAlbum)}>{t("photoMenu.addToAlbum")}</MenuItem>}
          {onEditTags && <MenuItem onSelect={act(onEditTags)}>{t("photoMenu.editTags")}</MenuItem>}
          {onSetLocation && (
            <MenuItem onSelect={act(onSetLocation)}>
              {t("photoMenu.location")}
              {/* The photo's place, so it reads without opening the dialog. */}
              {location && <span className="block truncate text-caption text-muted">{location}</span>}
            </MenuItem>
          )}
          {onAdjustTime && <MenuItem onSelect={act(onAdjustTime)}>{t("gallery.adjustTime.action")}</MenuItem>}
          <MenuLink to={`/gallery?similarTo=${photo.captureId}`}>{t("photoMenu.similar")}</MenuLink>
          {kind === "image" && !isPhotoVersionsOpen() && (
            <MenuItem onSelect={act(() => openPhotoVersions(photo.captureId, onVersionsChange))}>
              {t("photoMenu.versions")}
            </MenuItem>
          )}
        </MenuSection>
        <MenuSection>
          {unavailable && desktop && photo.originalSharePath && photo.originalVolumeLabel ? (
            <MenuItem onSelect={act(() => void connectLocation(photo.originalSharePath!, photo.originalVolumeLabel!))}>
              {t("libraryLocations.connect", { name: photo.originalVolumeLabel })}
            </MenuItem>
          ) : unavailable ? (
            <MenuNote>
              {photo.originalVolumeLabel
                ? t("photoMenu.connectVolume", { volume: photo.originalVolumeLabel })
                : t("photoMenu.originalUnavailable")}
            </MenuNote>
          ) : (
            <>
              {/* A RAW-only original is already covered by "Download RAW". */}
              {photo.originalRef && photo.originalKind !== "raw" && (
                <MenuItem onSelect={download("original", "original.jpg")}>{t("photoMenu.downloadOriginal")}</MenuItem>
              )}
              {photo.hasRaw && (
                <MenuItem onSelect={download("original-raw", "original.raw")}>{t("photoMenu.downloadRaw")}</MenuItem>
              )}
              <RevealOriginalMenuItem refs={[photo.originalRef, photo.rawRef]} onSelect={onClose} />
              {/* Where Show in Finder works, the path can be copied too; elsewhere that item copies it. */}
              {reveal?.kind === "reveal" &&
                files.map((ref) => (
                  <MenuItem key={ref} onSelect={act(() => copyPath(ref))}>
                    {files.length > 1
                      ? t("photoMenu.fileAction", { action: t("photoMenu.copyPath"), file: fileNameOf(ref) })
                      : t("photoMenu.copyPath")}
                  </MenuItem>
                ))}
              {/* By photo, so a version opens its own file. */}
              <OpenInMenuItems
                targets={photo.photoId ? { photoIds: [photo.photoId] } : { captureIds: [photo.captureId] }}
                hasEdit={!!photo.hasRaw && photo.originalKind !== "raw"}
                onSelect={onClose}
              />
            </>
          )}
        </MenuSection>
        <MenuSection>
          <SendToInatMenuItem
            captureId={photo.captureId}
            observationId={photo.inatObservationId ?? null}
            onSelect={onClose}
            onDone={onInatSent}
          />
        </MenuSection>
        <MenuSection>
          {onHide && <MenuItem onSelect={act(onHide)}>{t("photoMenu.hide", { kind })}</MenuItem>}
          {endItems}
          {onDelete && (
            <MenuItem danger onSelect={act(onDelete)}>
              {t("photoMenu.delete", { kind })}
            </MenuItem>
          )}
          {onDeleteWithRaw && photo.hasRaw && photo.originalKind !== "raw" && (
            <MenuItem danger onSelect={act(onDeleteWithRaw)}>
              {t("gallery.select.deleteWithRaw")}
            </MenuItem>
          )}
        </MenuSection>
      </div>
    </MenuPanel>
  );
}
