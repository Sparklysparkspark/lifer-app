import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../../api/client";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import Checkbox from "../../components/Checkbox";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import { TRIP_FILE_MOVE_STARTED, TripFileDetailList } from "../../components/TripFileMoveTray";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes } from "../../lib/format";
import { Field, FolderField } from "./TripFormParts";

type MoveCheck = ApiResponse<"/trips/{id}/move-files/check", "post">;
type RelinkCheck = ApiResponse<"/trips/{id}/relink", "post">;

/** "move": Lifer moves the trip's files. "relink": the user moved them and points Lifer at them.
 *  "wildlife": only where new photos for the trip are saved; nothing moves. */
export type TripFilesMode = "move" | "relink" | "wildlife";

const TITLE = {
  move: "trips.files.moveTitle",
  relink: "trips.files.relinkTitle",
  wildlife: "trips.files.wildlifeTitle",
} as const;
const DESCRIPTION = {
  move: "trips.files.moveDescription",
  relink: "trips.files.relinkDescription",
  wildlife: "trips.files.wildlifeDescription",
} as const;
const FIELD_LABEL = {
  move: "trips.files.moveTo",
  relink: "trips.files.movedTo",
  wildlife: "trips.files.saveNewTo",
} as const;

// Pick a folder, see in plain words what will happen, then confirm. A move then runs in the
// background (TripFileMoveTray), so the dialog closes at once.
export default function TripFilesDialog({
  tripId,
  mode,
  onClose,
  onRelinked,
}: {
  tripId: string;
  mode: TripFilesMode;
  onClose: () => void;
  onRelinked: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [folder, setFolder] = useState<string | null>(null);
  const [move, setMove] = useState<MoveCheck | null>(null);
  const [relink, setRelink] = useState<RelinkCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // The user's own files linked where they are: they move only when this is ticked.
  const [includeLinked, setIncludeLinked] = useState(false);
  // Kept while a new check runs, so the tickbox doesn't blink away.
  const [linkedCount, setLinkedCount] = useState(0);
  // Only the last folder picked gets its answer shown.
  const latest = useRef<string | null>(null);

  async function choose(path: string, linked = includeLinked) {
    latest.current = path;
    setFolder(path);
    setMove(null);
    setRelink(null);
    setError(null);
    setShowDetails(false);
    if (mode === "wildlife") return;
    setChecking(true);
    try {
      if (mode === "move") {
        const res = await api.post(apiPath("/trips/{id}/move-files/check", { id: tripId }), {
          folder: path,
          includeLinked: linked,
        });
        if (latest.current === path) {
          setMove(res);
          setLinkedCount(res.notManaged);
        }
      } else {
        const res = await api.post(apiPath("/trips/{id}/relink", { id: tripId }), { folder: path });
        if (latest.current === path) setRelink(res);
      }
    } catch (err) {
      if (latest.current === path) setError(errorMessage(err, t("trips.files.checkFailed")));
    } finally {
      if (latest.current === path) setChecking(false);
    }
  }

  async function confirm() {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "move") {
        await api.post(apiPath("/trips/{id}/move-files", { id: tripId }), { folder, includeLinked });
        window.dispatchEvent(new Event(TRIP_FILE_MOVE_STARTED));
      } else if (mode === "relink") {
        const res = await api.post(apiPath("/trips/{id}/relink", { id: tripId }), { folder, apply: true });
        toast.success(`${t("trips.files.relinked", { count: res.found })} ${t("trips.files.savedTo", { folder })}`);
        onRelinked();
      } else {
        await api.patch(apiPath("/trips/{id}", { id: tripId }), { destinationFolder: folder });
        toast.success(t("trips.files.savedTo", { folder }));
        onRelinked();
      }
      onClose();
    } catch (err) {
      setError(
        errorMessage(
          err,
          t(
            mode === "move"
              ? "trips.files.moveFailed"
              : mode === "relink"
                ? "trips.files.relinkFailed"
                : "trips.files.wildlifeFailed",
          ),
        ),
      );
      setBusy(false);
    }
  }

  const ready =
    mode === "move"
      ? !!move && !move.problem && move.files + move.alreadyThere > 0
      : mode === "relink"
        ? !!relink && relink.found > 0
        : !!folder;
  const left = relink ? relink.missing + relink.sizeDiffers : 0;
  const note = "text-callout text-muted";

  return (
    <Modal
      open
      onClose={onClose}
      title={t(TITLE[mode])}
      description={t(DESCRIPTION[mode])}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void confirm();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!ready} loading={busy}>
            {mode === "move"
              ? t("trips.files.moveButton", { count: move?.files ?? 0 })
              : mode === "wildlife"
                ? t("common.save")
                : relink
                  ? t("trips.files.relinkButtonFound", { found: relink.found, total: relink.total })
                  : t("trips.files.relinkButton")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t(FIELD_LABEL[mode])}>
          <FolderField folder={folder} chooseLabel={t("trips.files.chooseFolder")} onChoose={(p) => void choose(p)} />
        </Field>
        {/* The whole path, so a folder inside the trip's folder can't be mistaken for it. */}
        {folder && (
          <p className="break-all text-footnote text-muted" data-testid="chosen-folder">
            {move?.folder ?? folder}
          </p>
        )}
        {mode === "wildlife" && <p className={note}>{t("trips.files.wildlifeNote")}</p>}
        {checking && (
          <p className={`flex items-center gap-2 ${note}`}>
            <InlineSpinner tone="ink" />
            {t("trips.files.checking")}
          </p>
        )}
        {move &&
          (move.problem ? (
            <FormMessage error={move.message} />
          ) : (
            <div className="space-y-1">
              <p className="text-callout text-ink">
                {move.files > 0
                  ? t("trips.files.willMove", { count: move.files, size: formatBytes(move.bytes) })
                  : move.alreadyThere > 0
                    ? t("trips.files.finishMove")
                    : t("trips.files.nothingToMove")}
              </p>
              <p className={note}>{t("trips.files.willSaveHere")}</p>
              {move.neededBytes > 0 && (
                <p className={note}>{t("trips.files.copySpace", { size: formatBytes(move.neededBytes) })}</p>
              )}
              {move.alreadyThere > 0 && (
                <p className={note}>{t("trips.files.alreadyThere", { count: move.alreadyThere })}</p>
              )}
              {move.outside > 0 && <p className={note}>{t("trips.files.outside", { count: move.outside })}</p>}
              {move.missing > 0 && <p className={note}>{t("trips.files.missing", { count: move.missing })}</p>}
            </div>
          ))}
        {mode === "move" && folder && linkedCount > 0 && (
          <div className="space-y-2">
            <p className={note}>{t("trips.files.linked", { count: linkedCount })}</p>
            <Checkbox
              checked={includeLinked}
              onChange={(checked) => {
                setIncludeLinked(checked);
                void choose(folder, checked);
              }}
              description={t("trips.files.includeLinkedHelp")}
            >
              {t("trips.files.includeLinked")}
            </Checkbox>
          </div>
        )}
        {relink && (
          <div className="space-y-1">
            <p className="text-callout text-ink">
              {t("trips.files.found", { found: relink.found, total: relink.total })}
            </p>
            {relink.found > 0 && <p className={note}>{t("trips.files.willSaveHere")}</p>}
            {relink.outside > 0 && <p className={note}>{t("trips.files.outside", { count: relink.outside })}</p>}
            {left > 0 && (
              <p className={note}>
                {t("trips.files.notThere", { count: left })}{" "}
                <Button variant="link" size="sm" onClick={() => setShowDetails((v) => !v)}>
                  {t(showDetails ? "trips.files.hideDetails" : "trips.files.showDetails")}
                </Button>
              </p>
            )}
            {showDetails && <TripFileDetailList details={relink.details} more={relink.moreDetails} />}
          </div>
        )}
        <FormMessage error={error} />
      </div>
    </Modal>
  );
}
