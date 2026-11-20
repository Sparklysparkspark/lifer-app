// A photo's versions: the original, edits and exports grouped into one capture
// (apps/api/src/uploads/versionGrouping.ts). Every change applies at once with an Undo toast.
import { useEffect, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useApiRoute } from "../lib/resource";
import {
  notifyVersionChange,
  openPhotoVersions,
  photoVersionsPanel,
  versionChanges,
  versionName,
  type PhotoVersion,
} from "../lib/photoVersions";
import { formatBytes } from "../lib/format";
import { errorMessage } from "../lib/errorMessage";
import { useToast } from "../hooks/useToast";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { matches } from "../lib/keymap";
import Modal from "./Modal";
import Button from "./Button";
import Menu, { MenuItem, MenuPanel } from "./Menu";
import PhotoMenu from "./PhotoMenu";

type Group = ApiResponse<"/captures/{id}/versions">;
type VersionFile = Group["files"][number];

/** Mounted once beside the app's other global dialogs. */
export function PhotoVersionsHost() {
  const current = photoVersionsPanel.use();
  if (!current) return null;
  return (
    <PhotoVersionsPanel
      key={current.captureId}
      captureId={current.captureId}
      onChange={current.onChange}
      onClose={() => photoVersionsPanel.set(null)}
    />
  );
}

function PhotoVersionsPanel({
  captureId,
  onChange,
  onClose,
}: {
  captureId: string;
  onChange?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const group = useApiRoute(apiPath("/captures/{id}/versions", { id: captureId }));
  const menu = useDropdownMenu<string>();
  const [linking, setLinking] = useState(false);
  const files = group.data?.files ?? [];
  const groupId = group.data?.groupCaptureId ?? captureId;
  const grouped = new Set(files.map((f) => f.captureId)).size > 1;

  const changed = async () => {
    await group.reload();
    notifyVersionChange();
    onChange?.();
  };
  // Runs a change, then offers its opposite as Undo.
  const run = async (action: () => Promise<unknown>, message: string, undo: () => Promise<unknown>) => {
    try {
      await action();
      await changed();
      toast.show(message, {
        actions: [
          {
            label: t("versions.undo"),
            onClick: () =>
              void undo()
                .then(changed)
                .catch((err) => toast.error(errorMessage(err, t("versions.failed")))),
          },
        ],
      });
    } catch (err) {
      toast.error(errorMessage(err, t("versions.failed")));
    }
  };

  const showAsPhoto = (f: VersionFile) => {
    const before = files.find((x) => x.shown)?.captureId ?? groupId;
    void run(
      () => api.post(apiPath("/captures/{id}/versions/show", { id: groupId }), { captureId: f.captureId }),
      t("versions.shownToast", { name: f.fileName }),
      () => api.post(apiPath("/captures/{id}/versions/show", { id: groupId }), { captureId: before }),
    );
  };
  const splitOut = (f: VersionFile) =>
    void run(
      () => api.post(apiPath("/captures/{id}/versions/split", { id: f.captureId })),
      t("versions.splitToast", { name: f.fileName }),
      () => api.post(apiPath("/captures/{id}/versions/link", { id: f.captureId }), { groupCaptureId: groupId }),
    );
  const linkTo = (target: string) => {
    setLinking(false);
    void run(
      () => api.post(apiPath("/captures/{id}/versions/link", { id: captureId }), { groupCaptureId: target }),
      t("versions.linkedToast"),
      () => api.post(apiPath("/captures/{id}/versions/split", { id: captureId })),
    );
  };

  // Registered so a shortcut can be bound later; the open row's actions, else the shown file's.
  const focused = files.find((f) => f.originalId === menu.openKey) ?? files[0];
  useKeyboardShortcuts(
    {
      versionUseAsPhoto: () => focused && !focused.shown && showAsPhoto(focused),
      versionSplitOut: () => focused && !focused.isGroup && splitOut(focused),
      versionLinkTo: () => !grouped && setLinking(true),
    },
    { enabled: !linking && files.length > 0 },
  );

  const roleLabel = (f: VersionFile) =>
    f.role === "edit"
      ? t("versions.role.edit")
      : f.role === "export"
        ? t("versions.role.export")
        : t("versions.role.original");
  const evidenceLabel = (f: VersionFile) =>
    f.evidence === "document_id"
      ? t("versions.evidence.documentId")
      : f.evidence === "time_serial_suffix"
        ? t("versions.evidence.timeSerialSuffix")
        : f.evidence === "suggested"
          ? t("versions.evidence.suggested")
          : f.evidence === "manual"
            ? t("versions.evidence.manual")
            : f.evidence === "version_folder"
              ? t("versions.evidence.versionFolder")
              : null;

  return (
    <>
      <Modal
        open={!linking}
        onClose={onClose}
        size="lg"
        title={t("versions.title")}
        description={grouped ? t("versions.description") : t("versions.single")}
        footerStart={
          // A group's own photo can't join another group; split its versions out first.
          !grouped && (group.data?.nearby.length ?? 0) > 0 ? (
            <Button variant="secondary" onClick={() => setLinking(true)}>
              {t("versions.linkTo")}
            </Button>
          ) : undefined
        }
        footer={<Button onClick={onClose}>{t("common.done")}</Button>}
      >
        <ul className="divide-y divide-line">
          {files.map((f) => (
            <li key={f.originalId} className="group flex items-center gap-3 py-3">
              {f.photoId ? (
                <img
                  src={`/api/photos/${f.photoId}/thumb`}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-control bg-surface-muted object-cover"
                />
              ) : (
                <span className="h-14 w-14 shrink-0 rounded-control bg-surface-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-callout text-ink wrap-anywhere" title={f.ref}>
                  {f.fileName}
                </p>
                <p className="text-footnote text-muted">
                  {[
                    f.shown ? t("versions.shown") : null,
                    roleLabel(f),
                    f.format,
                    f.width && f.height ? `${f.width} × ${f.height}` : null,
                    formatBytes(f.fileSize),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {evidenceLabel(f) && <p className="text-footnote text-muted">{evidenceLabel(f)}</p>}
              </div>
              <Menu
                trigger="plain"
                open={menu.openKey === f.originalId}
                onToggle={() => menu.setOpenKey(menu.openKey === f.originalId ? null : f.originalId)}
                menuRef={menu.ref}
                className="relative shrink-0"
              >
                <PhotoMenu
                  photo={{
                    captureId: f.captureId,
                    photoId: f.photoId ?? "",
                    originalRef: f.ref,
                    originalKind: f.kind,
                    originalManaged: f.managed,
                  }}
                  onClose={menu.close}
                  coverItems={
                    !f.shown && (
                      <MenuItem
                        onSelect={() => {
                          menu.close();
                          showAsPhoto(f);
                        }}
                      >
                        {t("versions.useAsPhoto")}
                      </MenuItem>
                    )
                  }
                  endItems={
                    !f.isGroup && (
                      <MenuItem
                        onSelect={() => {
                          menu.close();
                          splitOut(f);
                        }}
                      >
                        {t("versions.splitOut")}
                      </MenuItem>
                    )
                  }
                />
              </Menu>
            </li>
          ))}
        </ul>
      </Modal>
      <Modal
        open={linking}
        onClose={() => setLinking(false)}
        size="lg"
        title={t("versions.linkTitle")}
        description={t("versions.linkDescription")}
        footer={
          <Button variant="secondary" onClick={() => setLinking(false)}>
            {t("common.cancel")}
          </Button>
        }
      >
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
          {group.data?.nearby.map((n) => (
            <li key={n.captureId}>
              {/* raw-control: a whole thumbnail is the choice, as on a photo tile. */}
              <button
                type="button"
                onClick={() => linkTo(n.captureId)}
                aria-label={t("versions.linkToPhoto")}
                className="block aspect-square w-full overflow-hidden rounded-control bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {n.photoId && (
                  <img src={`/api/photos/${n.photoId}/thumb`} alt="" className="h-full w-full object-cover" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}

/** A photo's versions, one per photo of its group; empty for a photo on its own. Reloads after
 *  any change to versions anywhere. */
export function usePhotoVersions(captureId: string | null): {
  versions: PhotoVersion[];
  groupCaptureId: string | null;
} {
  const res = useApiRoute(captureId ? apiPath("/captures/{id}/versions", { id: captureId }) : null);
  const revision = versionChanges.use();
  const reload = res.reload;
  useEffect(() => {
    if (revision > 0) void reload();
  }, [revision, reload]);
  const versions = res.data?.versions ?? [];
  return {
    versions: versions.length > 1 ? versions : [],
    groupCaptureId: res.data?.groupCaptureId ?? null,
  };
}

// design-token: light on the viewer's dark surround, as its caption and links.
const CHIP_ON = "bg-white text-black";
// design-token: as above
const CHIP_OFF = "bg-white/10 text-white/80 hover:bg-white/20";
// design-token: as above
const CAPTION = "text-white/50";
// design-token: as above
const CAPTION_LINK = "text-white/70 underline hover:text-white";

/** The viewer's version switcher: one choice per version, by its label. Renaming happens in
 *  place; "Use as photo" shows the chosen one everywhere. Light on the viewer's dark backdrop. */
export function VersionStrip({
  versions,
  groupCaptureId,
  activeId,
  onSelect,
  onChange,
}: {
  versions: PhotoVersion[];
  groupCaptureId: string;
  /** The version on screen. */
  activeId: string;
  onSelect: (version: PhotoVersion) => void;
  /** After "Use as photo", e.g. to reload the page behind. */
  onChange?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const actions = useVersionActions(onChange);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const active = versions.find((v) => v.captureId === activeId);

  const saveLabel = async (v: PhotoVersion, label: string | null) => {
    try {
      await api.put(apiPath("/captures/{id}/versions/label", { id: v.captureId }), { label });
      notifyVersionChange();
    } catch (err) {
      toast.error(errorMessage(err, t("versions.failed")));
    }
  };
  const finishRename = (v: PhotoVersion) => {
    setRenaming(null);
    const next = draft.trim() || null;
    // The auto name typed back in, or nothing changed: nothing to save.
    if (next === v.label || (!v.label && next === versionName(t, { ...v, label: null }))) return;
    const before = v.label;
    void saveLabel(v, next).then(() =>
      toast.show(t("versions.renamedToast"), {
        actions: [{ label: t("versions.undo"), onClick: () => void saveLabel(v, before) }],
      }),
    );
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>, v: PhotoVersion) => {
    if (matches(e, "confirm")) {
      e.preventDefault();
      finishRename(v);
    } else if (matches(e, "close")) {
      // Cancels the rename only; the viewer stays open.
      e.preventDefault();
      e.stopPropagation();
      setRenaming(null);
    }
  };

  const chip = "max-w-full break-words rounded-full px-2.5 py-0.5 text-left text-footnote transition-colors";
  return (
    <div className="mt-1.5 space-y-1">
      <div role="radiogroup" aria-label={t("versions.title")} className="flex flex-wrap justify-center gap-1.5">
        {versions.map((v) =>
          renaming === v.captureId ? (
            // raw-control: an inline rename on the viewer's dark backdrop, where TextField's light field doesn't fit.
            <input
              key={v.captureId}
              autoFocus
              value={draft}
              maxLength={80}
              aria-label={t("versions.renameLabel")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => onRenameKey(e, v)}
              onBlur={() => finishRename(v)}
              // design-token: as the chips
              className="w-48 rounded-full border border-white/40 bg-white/10 px-2.5 py-0.5 text-footnote text-white outline-none focus-visible:border-white"
            />
          ) : (
            // raw-control: a switcher chip, light on the viewer's dark backdrop.
            <button
              key={v.captureId}
              type="button"
              role="radio"
              aria-checked={v.captureId === activeId}
              title={v.fileName}
              onClick={() => onSelect(v)}
              onDoubleClick={() => {
                setDraft(versionName(t, v));
                setRenaming(v.captureId);
              }}
              className={`${chip} ${v.captureId === activeId ? CHIP_ON : CHIP_OFF}`}
            >
              {versionName(t, v)}
            </button>
          ),
        )}
      </div>
      {active && renaming === null && (
        <p className={`text-footnote ${CAPTION}`}>
          {active.shown ? (
            t("versions.shownEverywhere")
          ) : (
            // raw-control: a link in the caption, light on the dark backdrop. design-token: as the viewer's links
            <button
              type="button"
              onClick={() => void actions.show(groupCaptureId, active.captureId, versionName(t, active))}
              className={CAPTION_LINK}
            >
              {t("versions.useAsPhoto")}
            </button>
          )}
          {/* design-token: caption separator on the dark surround */}
          <span className="text-white/40"> · </span>
          {/* raw-control: a link in the caption, light on the dark backdrop. design-token: as above */}
          <button
            type="button"
            onClick={() => {
              setDraft(versionName(t, active));
              setRenaming(active.captureId);
            }}
            className={CAPTION_LINK}
          >
            {t("versions.rename")}
          </button>
        </p>
      )}
    </div>
  );
}

/** "Use as photo" and "Split out", applied at once with an Undo toast. */
function useVersionActions(onChange?: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const done = () => {
    notifyVersionChange();
    onChange?.();
  };
  const fail = (err: unknown) => toast.error(errorMessage(err, t("versions.failed")));
  // `action` answers with its own undo.
  const withUndo = async (action: () => Promise<() => Promise<unknown>>, message: string) => {
    try {
      const undo = await action();
      done();
      toast.show(message, {
        actions: [{ label: t("versions.undo"), onClick: () => void undo().then(done).catch(fail) }],
      });
    } catch (err) {
      fail(err);
    }
  };
  const showPath = (groupId: string) => apiPath("/captures/{id}/versions/show", { id: groupId });
  return {
    show: (groupId: string, captureId: string, name: string) =>
      withUndo(
        async () => {
          const { shownCaptureId } = await api.post(showPath(groupId), { captureId });
          return () => api.post(showPath(groupId), { captureId: shownCaptureId });
        },
        t("versions.shownToast", { name }),
      ),
    split: (groupId: string, captureId: string, name: string) =>
      withUndo(
        async () => {
          await api.post(apiPath("/captures/{id}/versions/split", { id: captureId }));
          return () =>
            api.post(apiPath("/captures/{id}/versions/link", { id: captureId }), { groupCaptureId: groupId });
        },
        t("versions.splitToast", { name }),
      ),
  };
}

/** The menu of a version listed as its own photo (the Gallery's "Show every version"): only
 *  what can't be mistaken for an action on the whole photo. */
export function VersionTileMenu({
  ref,
  style,
  groupCaptureId,
  captureId,
  name,
  onShowPhoto,
  onChange,
  onClose,
}: {
  groupCaptureId: string;
  captureId: string;
  /** The version's label. */
  name: string;
  onShowPhoto: () => void;
  onChange?: () => void;
  onClose: () => void;
  /** From Menu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const actions = useVersionActions(onChange);
  const act = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <MenuPanel ref={ref} style={style} className="w-52">
      <MenuItem onSelect={act(onShowPhoto)}>{t("versions.showPhoto")}</MenuItem>
      <MenuItem onSelect={act(() => void actions.show(groupCaptureId, captureId, name))}>
        {t("versions.useAsPhoto")}
      </MenuItem>
      <MenuItem onSelect={act(() => void actions.split(groupCaptureId, captureId, name))}>
        {t("versions.splitOut")}
      </MenuItem>
      <MenuItem onSelect={act(() => openPhotoVersions(groupCaptureId, onChange))}>{t("photoMenu.versions")}</MenuItem>
    </MenuPanel>
  );
}
