import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api, apiPath } from "../api/client";
import CaptureEditModal, { type CaptureEdit, type EditedCapture } from "../components/CaptureEditModal";
import CoordinatesModal from "../components/CoordinatesModal";
import type { SpeciesResult } from "../components/SpeciesPicker";
import { errorMessage } from "../lib/errorMessage";
import { ignore } from "../lib/ignore";
import { useSpeciesName } from "../lib/speciesName";
import { useToast } from "./useToast";

/** The fields an edit changes, for the page to apply to its own copy at once. */
export type PhotoEditPatch = {
  tags?: string[];
  locationLabel?: string | null;
  regionId?: string | null;
  isFeatured?: boolean | null;
  lat?: number | null;
  lon?: number | null;
};

/** What the dialogs read from a photo. */
export type EditablePhoto = Omit<EditedCapture, "tags"> & {
  tags?: string[];
  speciesId?: string | null;
  lat?: number | string | null;
  lon?: number | string | null;
};

// A photo menu's longer edits (tags, ID, second species, location) and Hide, for pages whose
// photos aren't the species page's or the Gallery's. Each change shows at once through `update`,
// then `reload` picks up what the server works out (names, covers, counts).
export function usePhotoEdits({
  reload,
  update,
}: {
  reload: () => void;
  update?: (captureId: string, patch: PhotoEditPatch) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const speciesName = useSpeciesName();
  const [editing, setEditing] = useState<{ captureId: string; edit: CaptureEdit } | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [tagOptions, setTagOptions] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get("/captures/tags", { signal: controller.signal })
      .then((res) => setTagOptions(res.tags))
      .catch(ignore("Couldn't load tags"));
    return () => controller.abort();
  }, []);

  const tagCapture = useCallback(
    async (captureId: string, tags: string[]) => {
      setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
      update?.(captureId, { tags });
      try {
        await api.patch(apiPath("/captures/{id}/tags", { id: captureId }), { tags });
      } catch (err) {
        toast.error(errorMessage(err, t("species.edits.tagsFailed")));
        reload();
      }
    },
    [update, reload, toast, t],
  );

  /** Makes the photo its species' featured photo, or goes back to the automatic one. */
  async function toggleFeatured(captureId: string, speciesId: string, photoId: string, featured: boolean) {
    update?.(captureId, { isFeatured: !featured });
    try {
      await api.patch(apiPath("/species/{id}/cover", { id: speciesId }), { photoId: featured ? null : photoId });
    } catch (err) {
      toast.error(errorMessage(err, t("species.edits.featuredFailed")));
    }
    reload();
  }

  async function tagSpecies(captureId: string, otherSpeciesId: string) {
    try {
      await api.post(apiPath("/captures/{id}/species", { id: captureId }), { speciesId: otherSpeciesId });
      reload();
    } catch (err) {
      toast.error(errorMessage(err, t("species.edits.tagSpeciesFailed")));
    }
  }

  /** `from` is the photo's species now, so the move can be undone. */
  async function reassign(captureId: string, from: string | null | undefined, to: SpeciesResult) {
    try {
      await api.patch(apiPath("/captures/{id}/reassign", { id: captureId }), { speciesId: to.id });
    } catch (err) {
      toast.error(errorMessage(err, t("species.edits.reassignFailed")));
      return;
    }
    reload();
    const undo = from
      ? [
          {
            label: t("species.edits.undo"),
            onClick: () =>
              void api
                .patch(apiPath("/captures/{id}/reassign", { id: captureId }), { speciesId: from })
                .catch(() => toast.error(t("species.edits.moveBackFailed")))
                .then(reload),
          },
        ]
      : [];
    toast.show(t("species.edits.movedTo", { species: speciesName(to) }), {
      tone: "success",
      actions: [{ label: t("species.edits.view"), onClick: () => navigate(`/species/${to.id}`) }, ...undo],
    });
  }

  async function hide(captureIds: string[]) {
    try {
      const res = await api.post("/captures/hide", { captureIds });
      reload();
      const undo = () =>
        void api
          .post("/captures/unhide", { captureIds })
          // Put back the featured photos the hide moved off.
          .then(() =>
            Promise.allSettled(
              res.covers.map((c) =>
                api.patch(apiPath("/species/{id}/cover", { id: c.speciesId }), { photoId: c.photoId }),
              ),
            ),
          )
          .then(reload)
          .catch((err) => toast.error(errorMessage(err, t("species.edits.unhideFailed"))));
      toast.show(
        captureIds.length === 1 ? t("species.edits.hidden") : t("species.edits.hiddenMany", { count: res.hidden }),
        { tone: "success", actions: [{ label: t("species.edits.undo"), onClick: undo }] },
      );
    } catch (err) {
      toast.error(errorMessage(err, t("species.edits.hideFailed")));
    }
  }

  /** The dialog in progress, given a way to find the photo it's for (gone: no dialog). */
  function dialog(find: (captureId: string) => EditablePhoto | undefined) {
    const placingPhoto = placing ? find(placing) : undefined;
    if (placing && placingPhoto) {
      const captureId = placing;
      const num = (v: number | string | null | undefined) => (v == null ? null : Number(v));
      return (
        <CoordinatesModal
          captureIds={[captureId]}
          lat={num(placingPhoto.lat)}
          lon={num(placingPhoto.lon)}
          suggestRegion={!placingPhoto.regionId}
          place={{ label: placingPhoto.locationLabel ?? null, regionId: placingPhoto.regionId ?? null }}
          onSaved={(point, region) => {
            update?.(captureId, {
              lat: point?.lat ?? null,
              lon: point?.lon ?? null,
              ...(region ? { regionId: region.id } : {}),
            });
            reload();
          }}
          onUndone={reload}
          onClose={() => setPlacing(null)}
        />
      );
    }
    const capture = editing ? find(editing.captureId) : undefined;
    if (!editing || !capture) return null;
    const { captureId, edit } = editing;
    return (
      <CaptureEditModal
        edit={edit}
        capture={{ ...capture, tags: capture.tags ?? [], captureId }}
        onClose={() => setEditing(null)}
        tagOptions={tagOptions}
        onTagsChange={(tags) => void tagCapture(captureId, tags)}
        onReassign={(species) => void reassign(captureId, capture.speciesId, species)}
        onTagSpecies={(speciesId) => void tagSpecies(captureId, speciesId)}
      />
    );
  }

  /** PhotoMenu handlers for one photo. */
  function menuActions(captureId: string) {
    const open = (edit: CaptureEdit) => () => setEditing({ captureId, edit });
    return {
      onEditTags: open("tags"),
      onCorrectId: open("reassign"),
      onTagSpecies: open("tagSpecies"),
      // Coordinates, places, and the place name and region: the map's dialog.
      onSetLocation: () => setPlacing(captureId),
      onHide: () => void hide([captureId]),
    };
  }

  return {
    editing,
    setEditing,
    tagOptions,
    tagCapture,
    reassign,
    tagSpecies,
    toggleFeatured,
    hide,
    dialog,
    menuActions,
  };
}
