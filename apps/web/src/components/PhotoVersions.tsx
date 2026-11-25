// A photo's versions: the original, edits and exports grouped into one capture
// (apps/api/src/uploads/versionGrouping.ts). Every change applies at once with an Undo toast.
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useApiRoute } from "../lib/resource";
import {
  notifyVersionChange,
  openPhotoVersions,
  photoVersionsPanel,
  useVersionCounts,
  versionChanges,
  versionNames,
  type PhotoVersion,
} from "../lib/photoVersions";
import { formatBytes, formatDate, formatList } from "../lib/format";
import { errorMessage } from "../lib/errorMessage";
import { docsUrl } from "../lib/docs";
import { openExternal } from "../lib/openExternal";
import { useToast } from "../hooks/useToast";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { usePersistedState } from "../hooks/usePersistedState";
import { matches, shortcutLabel } from "../lib/keymap";
import Modal from "./Modal";
import Button from "./Button";
import Lightbox, { type LightboxSlide } from "./Lightbox";
import Menu, { MenuItem, MenuPanel } from "./Menu";
import PhotoMenu from "./PhotoMenu";
import { VersionStackBadge } from "./PhotoTile";
import SearchInput from "./SearchInput";
import SegmentedControl from "./SegmentedControl";
import { Tooltip } from "./Tooltip";

type Group = ApiResponse<"/captures/{id}/versions">;
type VersionFile = Group["files"][number];
type FilesView = "list" | "grid";

const ROLE_PHRASES = {
  original: "versions.filesRole.original",
  edit: "versions.filesRole.edit",
  export: "versions.filesRole.export",
} as const;
// More files than this open as a grid unless the user chose otherwise.
const LIST_MAX = 4;

const thumbUrl = (f: VersionFile) => `/api/photos/${f.photoId}/thumb`;
const TILE_THUMB = "block aspect-square w-full";
const ROW_THUMB = "block h-14 w-14 shrink-0";

/** Mounted once beside the app's other global dialogs. */
export function PhotoVersionsHost() {
  const current = photoVersionsPanel.use();
  if (!current) return null;
  return (
    <PhotoVersionsPanel
      key={current.captureId}
      captureId={current.captureId}
      link={current.link}
      onChange={current.onChange}
      onClose={() => photoVersionsPanel.set(null)}
    />
  );
}

function PhotoVersionsPanel({
  captureId,
  link = false,
  onChange,
  onClose,
}: {
  captureId: string;
  link?: boolean;
  onChange?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const group = useApiRoute(apiPath("/captures/{id}/versions", { id: captureId }));
  const menu = useDropdownMenu<string>();
  const [linking, setLinking] = useState(link);
  const [savedView, setView] = usePersistedState<FilesView | null>("versions.view", null);
  // The file open full size, as an index into `viewable`.
  const [viewing, setViewing] = useState<number | null>(null);
  const files = useMemo(() => group.data?.files ?? [], [group.data]);
  const groupId = group.data?.groupCaptureId ?? captureId;
  const captureCount = new Set(files.map((f) => f.captureId)).size;
  const grouped = captureCount > 1;
  // A RAW-only capture is one of the photo's files, not a version.
  const versionCount = new Set(files.filter((f) => f.kind !== "raw").map((f) => f.captureId)).size;
  const shownCapture = files.find((f) => f.shown)?.captureId;
  const view: FilesView =
    savedView === "list" || savedView === "grid" ? savedView : files.length > LIST_MAX ? "grid" : "list";
  const viewable = useMemo(() => files.filter((f) => f.photoId), [files]);
  const slides = useMemo<LightboxSlide[]>(
    () =>
      viewable.map((f) => {
        // A RAW beside the JPG that is the photo shows its own preview, not the JPG's picture.
        const ownRender = f.kind === "raw" && files.some((o) => o.captureId === f.captureId && o.kind !== "raw");
        return {
          url: ownRender ? `/api/photos/${f.photoId}/full?original=raw` : `/api/photos/${f.photoId}/display`,
          thumbUrl: thumbUrl(f),
          width: ownRender ? null : f.width,
          height: ownRender ? null : f.height,
          caption: f.fileName,
        };
      }),
    [files, viewable],
  );
  // A group's own photo can't join another group; split its versions out first.
  const picking = linking && !grouped;

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
    const before = shownCapture ?? groupId;
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

  // The open row's actions, else the shown file's. Mod chords are the browser's too (find next).
  const focused = files.find((f) => f.originalId === menu.openKey) ?? files[0];
  useKeyboardShortcuts(
    {
      versionUseAsPhoto: (e) => {
        e.preventDefault();
        if (focused && focused.captureId !== shownCapture) showAsPhoto(focused);
      },
      versionSplitOut: (e) => {
        e.preventDefault();
        if (focused && !focused.isGroup) splitOut(focused);
      },
      versionLinkTo: (e) => {
        e.preventDefault();
        if (!grouped) setLinking(true);
      },
    },
    { enabled: !picking && files.length > 0 && viewing === null },
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

  // What the list holds, said plainly: a RAW and its JPG are one photo's files, not versions.
  const summary = !group.data
    ? undefined
    : versionCount > 1
      ? t("versions.summary", { count: versionCount })
      : files.length > 1
        ? t("versions.filesSummary", {
            count: files.length,
            list: formatList(
              Object.entries(ROLE_PHRASES)
                .map(([r, key]) => [key, files.filter((f) => (f.role ?? "original") === r).length] as const)
                .filter(([, n]) => n > 0)
                .map(([key, n]) => t(key, { count: n })),
            ),
          })
        : t("versions.oneFile");

  const fileMenu = (f: VersionFile) => (
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
          f.captureId !== shownCapture && (
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
  );
  // The thumbnail opens the file full size; focus comes back to it when the viewer closes.
  const thumb = (f: VersionFile, className: string) =>
    f.photoId ? (
      // raw-control: a whole thumbnail opens the file, as on a photo tile.
      <button
        type="button"
        onClick={() => setViewing(viewable.indexOf(f))}
        aria-label={t("versions.viewFile", { name: f.fileName })}
        className={`${className} overflow-hidden rounded-control bg-surface-muted transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      >
        <img src={thumbUrl(f)} alt="" loading="lazy" className="h-full w-full object-cover" />
      </button>
    ) : (
      <span className={`${className} rounded-control bg-surface-muted`} />
    );
  const meta = (f: VersionFile, withSize: boolean) =>
    [
      roleLabel(f),
      f.format,
      withSize && f.width && f.height ? `${f.width} × ${f.height}` : null,
      formatBytes(f.fileSize),
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      <Modal
        open={!picking}
        onClose={onClose}
        size="lg"
        title={t("versions.title")}
        description={summary}
        footerStart={
          group.data && !grouped ? (
            <Button
              variant="secondary"
              tooltip={{ label: t("versions.linkTo"), shortcut: shortcutLabel("versionLinkTo") }}
              onClick={() => setLinking(true)}
            >
              {t("versions.linkTo")}
            </Button>
          ) : undefined
        }
        footer={<Button onClick={onClose}>{t("common.done")}</Button>}
      >
        {files.length > 1 && (
          <div className="mb-2">
            <SegmentedControl
              label={t("versions.view.label")}
              value={view}
              onChange={setView}
              options={[
                { value: "list", label: t("versions.view.list") },
                { value: "grid", label: t("versions.view.grid") },
              ]}
            />
          </div>
        )}
        {view === "grid" ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 py-2">
            {files.map((f) => (
              <li key={f.originalId} className="min-w-0">
                <div className="relative">
                  {thumb(f, TILE_THUMB)}
                  {f.shown && (
                    // design-token: a scrim over the photo, as the version badge on photo tiles.
                    <span className="pointer-events-none absolute top-2 left-2 rounded-badge bg-black/60 px-1.5 py-0.5 text-caption text-white">
                      {t("versions.shownEverywhere")}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <Tooltip content={{ label: f.ref }}>
                      {(tip) => (
                        <p {...tip} className="text-footnote text-ink wrap-anywhere">
                          {f.fileName}
                        </p>
                      )}
                    </Tooltip>
                    <p className="text-caption text-muted">{meta(f, false)}</p>
                  </div>
                  {fileMenu(f)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="divide-y divide-line">
            {files.map((f) => (
              <li key={f.originalId} className="group flex items-center gap-3 py-3">
                {thumb(f, ROW_THUMB)}
                <div className="min-w-0 flex-1">
                  <Tooltip content={{ label: f.ref }}>
                    {(tip) => (
                      <p {...tip} className="text-callout text-ink wrap-anywhere">
                        {f.fileName}
                      </p>
                    )}
                  </Tooltip>
                  {f.shown && <p className="text-footnote text-muted">{t("versions.shownEverywhere")}</p>}
                  <p className="text-footnote text-muted">{meta(f, true)}</p>
                  {evidenceLabel(f) && <p className="text-footnote text-muted">{evidenceLabel(f)}</p>}
                </div>
                {fileMenu(f)}
              </li>
            ))}
          </ul>
        )}
        {group.data && !grouped && (
          <p className="mt-2 text-footnote text-muted">
            {t("versions.singleHint")}{" "}
            <Button variant="link" size="sm" onClick={() => openExternal(docsUrl("/guides/photo-versions"))}>
              {t("versions.notice.howItWorks")}
            </Button>
          </p>
        )}
      </Modal>
      {viewing !== null && (
        <Lightbox slides={slides} index={viewing} onIndexChange={setViewing} onClose={() => setViewing(null)} />
      )}
      <LinkPicker
        open={picking}
        captureId={captureId}
        nearby={group.data?.nearby ?? []}
        onPick={linkTo}
        onClose={() => setLinking(false)}
      />
    </>
  );
}

const SEARCH_DELAY_MS = 250;

/** "Link to another photo": photos taken within two minutes, or any photo a search finds by file
 *  name, species, place or date. */
function LinkPicker({
  open,
  captureId,
  nearby,
  onPick,
  onClose,
}: {
  open: boolean;
  captureId: string;
  nearby: Group["nearby"];
  onPick: (captureId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  // Searched once typing pauses, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const found = useApiRoute(q ? apiPath("/captures/{id}/versions/candidates", { id: captureId }, { q }) : null);
  const items = q ? (found.data?.items ?? []) : nearby;
  // A photo with versions can be picked too; this one joins them.
  const counts = useVersionCounts();
  const status = q
    ? found.data && items.length === 0
      ? t("versions.linkNoMatch")
      : null
    : nearby.length > 0
      ? t("versions.linkNearby")
      : t("versions.linkNoneNearby");

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t("versions.linkTitle")}
      description={t("versions.linkDescription")}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      }
    >
      <SearchInput
        value={query}
        onChange={setQuery}
        autoFocus
        size="md"
        aria-label={t("versions.linkSearch")}
        placeholder={t("versions.linkSearchPlaceholder")}
      />
      {status && (
        <p role="status" className="mt-2 text-footnote text-muted">
          {status}
        </p>
      )}
      <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
        {items.map((n) => (
          <li key={n.captureId} className="min-w-0">
            {/* raw-control: a whole thumbnail is the choice, as on a photo tile. */}
            <button
              type="button"
              onClick={() => onPick(n.captureId)}
              aria-label={t("versions.linkToPhoto", { name: n.fileName ?? n.speciesName ?? "" })}
              className="block w-full min-w-0 rounded-control text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="relative block aspect-square overflow-hidden rounded-control bg-surface-muted">
                {n.photoId && (
                  <img src={`/api/photos/${n.photoId}/thumb`} alt="" className="h-full w-full object-cover" />
                )}
                {(counts.get(n.captureId) ?? 0) > 1 && (
                  <VersionStackBadge label={t("versions.badge", { count: counts.get(n.captureId) })} />
                )}
              </span>
              {n.fileName && (
                <span className="mt-1 line-clamp-2 text-footnote text-ink wrap-anywhere">{n.fileName}</span>
              )}
              <span className="line-clamp-2 text-caption text-muted wrap-anywhere">
                {/* The date first: a long species name is cut at two lines, the date never is. */}
                {[formatDate(n.takenAt), n.speciesName].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
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
  const names = versionNames(t, versions);
  const nameOf = (v: PhotoVersion) => names.get(v.captureId) ?? "";
  // The version on screen; the panel, once open, takes these keys for its own rows.
  const panelOpen = photoVersionsPanel.use() != null;
  useKeyboardShortcuts(
    {
      versionUseAsPhoto: () => {
        if (active && !active.shown) void actions.show(groupCaptureId, active.captureId, nameOf(active));
      },
      versionSplitOut: (e) => {
        e.preventDefault();
        if (active && !active.isGroup) void actions.split(groupCaptureId, active.captureId, nameOf(active));
      },
    },
    { enabled: !panelOpen && renaming === null },
  );

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
    if (next === v.label || (!v.label && next === nameOf(v))) return;
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
            <Tooltip key={v.captureId} content={v.fileName ? { label: v.fileName } : undefined}>
              {(tip) => (
                // raw-control: a switcher chip, light on the viewer's dark backdrop.
                <button
                  {...tip}
                  type="button"
                  role="radio"
                  aria-checked={v.captureId === activeId}
                  onClick={() => onSelect(v)}
                  onDoubleClick={() => {
                    setDraft(nameOf(v));
                    setRenaming(v.captureId);
                  }}
                  className={`${chip} ${v.captureId === activeId ? CHIP_ON : CHIP_OFF}`}
                >
                  {nameOf(v)}
                </button>
              )}
            </Tooltip>
          ),
        )}
      </div>
      {active && renaming === null && (
        <p className={`text-footnote ${CAPTION}`}>
          {active.shown ? (
            t("versions.shownEverywhere")
          ) : (
            <Tooltip content={{ label: t("versions.useAsPhoto"), shortcut: shortcutLabel("versionUseAsPhoto") }}>
              {(tip) => (
                // raw-control: a link in the caption, light on the dark backdrop. design-token: as the viewer's links
                <button
                  {...tip}
                  type="button"
                  onClick={() => void actions.show(groupCaptureId, active.captureId, nameOf(active))}
                  className={CAPTION_LINK}
                >
                  {t("versions.useAsPhoto")}
                </button>
              )}
            </Tooltip>
          )}
          {/* design-token: caption separator on the dark surround */}
          <span className="text-white/40"> · </span>
          {/* raw-control: a link in the caption, light on the dark backdrop. design-token: as above */}
          <button
            type="button"
            onClick={() => {
              setDraft(nameOf(active));
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
