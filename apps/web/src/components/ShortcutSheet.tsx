import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import Button from "./Button";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { KEYMAP, matches, shortcutLabels, type KeyAction, type KeyScope, type WidgetAction } from "../lib/keymap";
import { isTauri } from "../lib/tauri";

// Widget keys are the platform's own (arrows in a list), so the sheet leaves them out.
const SCOPES: Exclude<KeyScope, "widget">[] = [
  "global",
  "dialog",
  "gallery",
  "photo",
  "video",
  "import",
  "review",
  "map",
];

/** The `?` sheet: every binding in lib/keymap.ts, grouped by where it applies. */
export default function ShortcutSheet() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const actionNames: Record<Exclude<KeyAction, WidgetAction>, string> = {
    next: t("shortcuts.action.next"),
    previous: t("shortcuts.action.previous"),
    nextGroup: t("shortcuts.action.nextGroup"),
    previousGroup: t("shortcuts.action.previousGroup"),
    open: t("shortcuts.action.open"),
    backToGrid: t("shortcuts.action.backToGrid"),
    peek: t("shortcuts.action.peek"),
    compare: t("shortcuts.action.compare"),
    fullScreen: t("shortcuts.action.fullScreen"),
    info: t("shortcuts.action.info"),
    close: t("shortcuts.action.close"),
    palette: t("shortcuts.action.palette"),
    find: t("shortcuts.action.find"),
    settings: t("shortcuts.action.settings"),
    shortcuts: t("shortcuts.action.shortcuts"),
    zoomToggle: t("shortcuts.action.zoomToggle"),
    zoomFit: t("shortcuts.action.zoomFit"),
    zoomIn: t("shortcuts.action.zoomIn"),
    zoomOut: t("shortcuts.action.zoomOut"),
    cardLarger: t("shortcuts.action.cardLarger"),
    cardSmaller: t("shortcuts.action.cardSmaller"),
    rate1: t("shortcuts.action.rate1"),
    rate2: t("shortcuts.action.rate2"),
    rate3: t("shortcuts.action.rate3"),
    rate4: t("shortcuts.action.rate4"),
    rate5: t("shortcuts.action.rate5"),
    rateClear: t("shortcuts.action.rateClear"),
    changeSpecies: t("shortcuts.action.changeSpecies"),
    feature: t("shortcuts.action.feature"),
    selectAll: t("shortcuts.action.selectAll"),
    selectNone: t("shortcuts.action.selectNone"),
    trash: t("shortcuts.action.trash"),
    confirm: t("shortcuts.action.confirm"),
    export: t("shortcuts.action.export"),
    playPause: t("shortcuts.action.playPause"),
    skipBack: t("shortcuts.action.skipBack"),
    skipForward: t("shortcuts.action.skipForward"),
    frameBack: t("shortcuts.action.frameBack"),
    frameForward: t("shortcuts.action.frameForward"),
    import: t("shortcuts.action.import"),
    undoLocation: t("shortcuts.action.undoLocation"),
    regionOut: t("shortcuts.action.regionOut"),
    regionReset: t("shortcuts.action.regionReset"),
    rateClearNext: t("shortcuts.action.rateClearNext"),
    rate1Next: t("shortcuts.action.rate1Next"),
    rate2Next: t("shortcuts.action.rate2Next"),
    rate3Next: t("shortcuts.action.rate3Next"),
    rate4Next: t("shortcuts.action.rate4Next"),
    rate5Next: t("shortcuts.action.rate5Next"),
    toggleSidebar: t("shortcuts.action.toggleSidebar"),
    page1: t("nav.collection"),
    page2: t("nav.gallery"),
    page3: t("nav.map"),
    page4: t("nav.albums"),
    page5: t("nav.stats"),
    reviewConfirm: t("shortcuts.action.reviewConfirm"),
    reviewPick: t("shortcuts.action.reviewPick"),
    reviewNotSure: t("shortcuts.action.reviewNotSure"),
    reviewNext: t("shortcuts.action.reviewNext"),
    reviewPrevious: t("shortcuts.action.reviewPrevious"),
    versionsShow: t("shortcuts.action.versionsShow"),
    versionPrevious: t("shortcuts.action.versionPrevious"),
    versionNext: t("shortcuts.action.versionNext"),
    versionUseAsPhoto: t("shortcuts.action.versionUseAsPhoto"),
    versionSplitOut: t("shortcuts.action.versionSplitOut"),
    versionLinkTo: t("shortcuts.action.versionLinkTo"),
    versionReviewLinkAll: t("shortcuts.action.versionReviewLinkAll"),
    versionReviewLink: t("shortcuts.action.versionReviewLink"),
    versionReviewDismiss: t("shortcuts.action.versionReviewDismiss"),
    compareImport: t("shortcuts.action.compareImport"),
    compareSpecies: t("shortcuts.action.compareSpecies"),
    importUndo: t("shortcuts.action.importUndo"),
    importClear: t("shortcuts.action.importClear"),
    importNoAnimal: t("shortcuts.action.importNoAnimal"),
  };
  const scopeNames: Record<(typeof SCOPES)[number], string> = {
    global: t("shortcuts.scope.global"),
    dialog: t("shortcuts.scope.dialog"),
    gallery: t("shortcuts.scope.gallery"),
    photo: t("shortcuts.scope.photo"),
    video: t("shortcuts.scope.video"),
    import: t("shortcuts.scope.import"),
    map: t("shortcuts.scope.map"),
    review: t("shortcuts.scope.review"),
  };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target) || !matches(e, "shortcuts")) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const actions = (Object.keys(KEYMAP) as (keyof typeof actionNames)[]).filter(
    (a) => KEYMAP[a].scope !== "widget" && KEYMAP[a].chords.length > 0 && (isTauri() || !KEYMAP[a].desktopOnly),
  );
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={t("shortcuts.title")}
      size="lg"
      footer={<Button onClick={() => setOpen(false)}>{t("common.done")}</Button>}
    >
      <p className="mb-4 text-callout text-muted">{t("shortcuts.intro")}</p>
      {SCOPES.map((scope) => (
        <section key={scope} className="mb-4">
          <h3 className="mb-2 text-callout font-semibold text-ink">{scopeNames[scope]}</h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
            {actions
              .filter((a) => KEYMAP[a].scope === scope)
              .map((a) => (
                <div key={a} className="contents">
                  <dt className="text-callout text-ink">{actionNames[a]}</dt>
                  <dd className="text-right text-callout text-muted">
                    {shortcutLabels(a).map((l) => (
                      <kbd key={l} className="ml-1 rounded-control border border-line px-1.5 font-sans">
                        {l}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </Modal>
  );
}
