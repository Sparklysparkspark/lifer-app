import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { TFunction } from "i18next";
import { api, apiPath } from "../api/client";
import type { BarAction } from "../components/SelectionActionRow";
import { errorMessage } from "../lib/errorMessage";
import { photosDeleted } from "../lib/resource";
import { useToast } from "./useToast";
import { pruneSelection, type useSelectMode } from "./useSelectMode";

type Select = Pick<ReturnType<typeof useSelectMode<unknown>>, "selectMode" | "selectedIds" | "setSelectedIds" | "exit">;

// Moving photos to Trash, one from its menu or the selection from the bar, the same on every grid.
// Trash keeps them, so deleting needs no confirm: the toast's Undo restores them.
export function useDeleteCaptures({
  select,
  exitSelectMode = select.exit,
  onDeleted,
  reload,
}: {
  select: Select;
  /** The page's own way out of select mode, when it does more than the plain exit. */
  exitSelectMode?: () => void;
  /** Drops the photos from the page's list; the viewer then moves on, closing only once the list is empty. */
  onDeleted: (captureIds: string[]) => void;
  /** Reads the page again once Undo has put photos back. */
  reload: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  // A second click or a held key while a delete is in flight would send it again.
  const busy = useRef(false);

  function showTrashed(captureIds: string[]) {
    toast.show(t("gallery.edits.trashed", { count: captureIds.length }), {
      tone: "success",
      actions: [
        { label: t("common.view"), onClick: () => navigate("/trash") },
        {
          label: t("common.undo"),
          onClick: () =>
            void Promise.allSettled(
              captureIds.map((captureId) => api.post(apiPath("/trash/{id}/restore", { id: captureId }), {})),
            ).then((results) => {
              const failed = results.filter((r) => r.status === "rejected").length;
              if (failed > 0) toast.error(t("trash.restoreManyFailed", { count: failed }));
              photosDeleted();
              reload();
            }),
        },
      ],
    });
  }

  /** `deleteRaw` also deletes each RAW beside an edited original once Trash purges it. */
  async function trash(captureIds: string[], deleteRaw: boolean, then: () => void) {
    if (busy.current || captureIds.length === 0) return;
    busy.current = true;
    try {
      await api.post("/captures/batch-delete", { captureIds, deleteRaw });
    } catch (err) {
      toast.error(
        errorMessage(
          err,
          captureIds.length === 1 ? t("gallery.edits.deleteFailed") : t("gallery.edits.deleteManyFailed"),
        ),
      );
      return;
    } finally {
      busy.current = false;
    }
    photosDeleted();
    then();
    onDeleted(captureIds);
    showTrashed(captureIds);
  }

  return {
    deletePhoto: (captureId: string, deleteRaw = false) =>
      trash([captureId], deleteRaw, () =>
        select.setSelectedIds((prev) =>
          pruneSelection(
            prev,
            [...prev].filter((id) => id !== captureId),
          ),
        ),
      ),
    deleteSelected: async (deleteRaw = false) => {
      if (select.selectMode) await trash([...select.selectedIds], deleteRaw, exitSelectMode);
    },
  };
}

/** The selection bar's Delete, plus "Delete with RAW files" in its More menu when a RAW sits beside an edited original. */
export function deleteBarActions(
  t: TFunction,
  selectedHaveRaw: boolean,
  deleteSelected: (deleteRaw?: boolean) => void,
): BarAction[] {
  return [
    ...(selectedHaveRaw
      ? [
          {
            key: "deleteWithRaw",
            label: t("gallery.select.deleteWithRaw"),
            onClick: () => void deleteSelected(true),
            variant: "danger" as const,
            menuOnly: true,
          },
        ]
      : []),
    {
      key: "delete",
      label: t("gallery.select.deleteSelected"),
      onClick: () => void deleteSelected(),
      variant: "danger",
    },
  ];
}
