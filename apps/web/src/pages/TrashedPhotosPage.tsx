import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import i18n from "../i18n";
import ManageListPage from "../components/ManageListPage";
import { docsUrl } from "../lib/docs";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import PhotoGrid, { type PhotoGridTileData } from "../components/PhotoGrid";
import SegmentedControl from "../components/SegmentedControl";
import { useShowLabels } from "../hooks/useShowLabels";
import Button from "../components/Button";
import ConfirmDialog from "../components/ConfirmDialog";
import SelectModeToggle from "../components/SelectModeToggle";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useSelectMode } from "../hooks/useSelectMode";
import { useToast } from "../hooks/useToast";
import { MenuItem, MenuPanel } from "../components/Menu";
import Checkbox from "../components/Checkbox";

type TrashResponse = ApiResponse<"/trash">;
type TrashItem = TrashResponse["items"][number];

const trashId = (item: TrashItem) => item.captureId;
const trashTile = (item: TrashItem): PhotoGridTileData => ({ ...item, alt: item.speciesName });

function daysLeft(purgesAt: string): number {
  const ms = new Date(purgesAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// Gallery-style grid scoped to trashed photos; the only per-photo action is Restore.
export default function TrashedPhotosPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<TrashResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const menu = useDropdownMenu<string>();
  const toast = useToast();
  const [showLabels, setShowLabels] = useShowLabels();
  const [photoFilter, setPhotoFilter] = useState<"all" | "edited" | "raw" | "video">("all");

  function load() {
    api
      .get("/trash")
      .then(setData)
      .catch(() => setError(i18n.t("trash.loadFailed")));
  }

  useEffect(load, []);

  async function restore(captureId: string) {
    setBusyId(captureId);
    try {
      await api.post(apiPath("/trash/{id}/restore", { id: captureId }), {});
      load();
    } catch {
      toast.error(t("trash.restoreFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function restoreSelected() {
    const ids = [...select.selectedIds];
    select.exit();
    const results = await Promise.allSettled(ids.map((id) => api.post(apiPath("/trash/{id}/restore", { id }), {})));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) toast.error(t("trash.restoreManyFailed", { count: failed }));
    load();
  }

  async function emptyTrash() {
    setEmptying(true);
    try {
      await api.post("/trash/empty");
      setConfirmingEmpty(false);
      load();
    } catch {
      toast.error(t("trash.emptyFailed"));
    } finally {
      setEmptying(false);
    }
  }

  const allItems = data?.items ?? [];
  // "Edited" and "RAW" both exclude videos, so a video only shows under All/Video.
  const editedCount = allItems.filter((it) => it.photoId && it.kind !== "video" && it.originalKind !== "raw").length;
  const rawOnlyCount = allItems.filter((it) => it.photoId && it.kind !== "video" && it.originalKind === "raw").length;
  const videoCount = allItems.filter((it) => it.kind === "video").length;
  const visibleItems = useMemo(
    () =>
      (data?.items ?? []).filter((it) => {
        if (photoFilter === "all") return true;
        if (photoFilter === "video") return it.kind === "video";
        if (it.kind === "video") return false;
        return photoFilter === "raw" ? it.originalKind === "raw" : it.originalKind !== "raw";
      }),
    [data, photoFilter],
  );
  const select = useSelectMode(visibleItems, (it) => it.captureId);
  const { selectMode, selectedIds } = select;
  const itemsWithPhoto = visibleItems.filter((it) => it.photoId);
  const slides: LightboxSlide[] = itemsWithPhoto.map((it) => ({
    url: `/api/photos/${it.photoId}/display`,
    videoUrl: it.kind === "video" ? `/api/photos/${it.photoId}/video` : null,
    audioUrl: it.kind === "audio" ? `/api/photos/${it.photoId}/audio` : null,
    caption: it.speciesName,
    info: it.kind === "video" ? { durationSeconds: it.durationSeconds } : null,
  }));

  return (
    <>
      <ManageListPage
        title={t("trash.title")}
        backLabel={t("nav.settings")}
        description={data ? t("trash.retention", { days: data.retentionDays }) : undefined}
        docsHref={docsUrl("/guides/trash")}
        wide
        actions={
          <>
            {(rawOnlyCount > 0 || videoCount > 0) && (
              <SegmentedControl
                size="sm"
                value={photoFilter}
                onChange={setPhotoFilter}
                options={[
                  { value: "all", label: t("trash.filter.all", { count: editedCount + rawOnlyCount + videoCount }) },
                  { value: "edited", label: t("trash.filter.edited", { count: editedCount }) },
                  ...(rawOnlyCount > 0
                    ? [{ value: "raw" as const, label: t("trash.filter.raw", { count: rawOnlyCount }) }]
                    : []),
                  ...(videoCount > 0
                    ? [{ value: "video" as const, label: t("trash.filter.video", { count: videoCount }) }]
                    : []),
                ]}
              />
            )}
            <Checkbox size="sm" checked={showLabels} onChange={setShowLabels} labelClassName="h-8 text-muted">
              {t("trash.labels")}
            </Checkbox>
            <SelectModeToggle active={selectMode} onEnter={() => select.setSelectMode(true)} onExit={select.exit} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingEmpty(true)}
              className="text-red-600 dark:text-red-400"
            >
              {t("trash.empty.confirm")}
            </Button>
          </>
        }
        banner={
          selectMode && (
            <div className="flex items-center justify-between border-b border-line bg-surface-muted px-6 py-2 text-footnote">
              <span className="text-muted">{t("trash.selectedCount", { count: selectedIds.size })}</span>
              <Button size="sm" onClick={restoreSelected} disabled={selectedIds.size === 0}>
                {t("trash.restoreSelected")}
              </Button>
            </div>
          )
        }
        loading={!data}
        error={error}
        onRetry={() => {
          setError(null);
          load();
        }}
        isEmpty={data?.items.length === 0}
        empty={{
          icon: (
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          ),
          title: t("trash.isEmpty.title"),
          description: t("trash.isEmpty.description"),
        }}
        noMatch={visibleItems.length === 0 ? t("trash.noMatch") : null}
      >
        <PhotoGrid
          items={visibleItems}
          idFor={trashId}
          tileFor={trashTile}
          columnWidth={220}
          select={select}
          menu={menu}
          onOpen={(i) => {
            const photoIndex = itemsWithPhoto.indexOf(visibleItems[i]);
            if (photoIndex >= 0) setLightboxIndex(photoIndex);
          }}
          renderMenu={(item) => (
            <MenuPanel className="w-36">
              <MenuItem onSelect={() => restore(item.captureId)} disabled={busyId === item.captureId}>
                {busyId === item.captureId ? t("trash.restoring") : t("trash.restore")}
              </MenuItem>
            </MenuPanel>
          )}
          renderLabel={(item) =>
            showLabels && (
              <>
                <p className="mt-1 truncate text-footnote text-muted">{item.speciesName}</p>
                <p className="truncate text-footnote text-muted">
                  {t("trash.daysLeft", { count: daysLeft(item.purgesAt) })}
                  {item.hasRawOriginal && (item.pendingDeleteRaw ? t("trash.rawDeletedToo") : t("trash.rawKept"))}
                </p>
              </>
            )
          }
        />
      </ManageListPage>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      <ConfirmDialog
        open={confirmingEmpty}
        title={t("trash.empty.title")}
        message={t("trash.empty.message")}
        confirmLabel={t("trash.empty.confirm")}
        danger
        busy={emptying}
        onConfirm={() => void emptyTrash()}
        onCancel={() => setConfirmingEmpty(false)}
      />
    </>
  );
}
