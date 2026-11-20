import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NAME_MAX_LENGTH } from "@lifer/shared";
import { api, apiPath, type ApiResponse } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { formatList, formatNumber } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";
import { regionListsFirst, targetListsChanged, useTargetLists } from "../lib/targetLists";
import { useRegions } from "../hooks/useRegions";
import { useToast } from "../hooks/useToast";
import Button from "./Button";
import Checkbox from "./Checkbox";
import FilePickArea from "./FilePickArea";
import FormMessage from "./FormMessage";
import InlineSpinner from "./InlineSpinner";
import Modal from "./Modal";
import RegionBrowser from "./RegionBrowser";
import Select from "./Select";
import { NameField } from "./TextField";

type Preview = ApiResponse<"/target-lists/preview", "post">;
type Option = Preview["rows"][number]["options"][number];

// Names listed by name when nothing matched them; the count is always complete.
const MAX_UNMATCHED_SHOWN = 30;
const FIELD_LABEL = "block space-y-1 text-callout text-muted";

/** Import a CSV of species into a new or existing target list: pick, review the matches, save.
 *  Shared by the Collection's Add species menu and Settings. Undo is in the toast afterwards. */
export default function TargetListImportModal({
  regionId: viewedRegionId = null,
  onClose,
  onImported,
}: {
  /** The region being browsed: its lists come first and it is the suggested region. */
  regionId?: string | null;
  onClose: () => void;
  /** After an import or its undo changed which species are targets. */
  onImported?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const lists = useTargetLists();
  const { regions } = useRegions();
  const [listId, setListId] = useState("");
  const [name, setName] = useState("");
  const [regionId, setRegionId] = useState<string | null>(viewedRegionId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ambiguous names: the species picked for each, "" while skipped.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [includeOffChecklist, setIncludeOffChecklist] = useState(false);

  const existing = lists?.find((l) => l.id === listId);
  const listRegionId = existing ? existing.regionId : regionId;
  const regionName = listRegionId ? (regions?.find((r) => r.id === listRegionId)?.name ?? existing?.regionName) : null;
  const orderedLists = useMemo(() => regionListsFirst(lists ?? [], viewedRegionId), [lists, viewedRegionId]);

  // Every species the review would import, and the ones it would leave as they are.
  const chosen = useMemo(() => {
    if (!preview) return { importIds: [] as string[], offChecklist: 0, leftAlone: 0 };
    const options = new Map<string, Option>();
    for (const row of preview.rows) {
      const pick = row.status === "matched" ? row.options[0] : row.options.find((o) => o.speciesId === picks[row.name]);
      if (pick) options.set(pick.speciesId, pick);
    }
    const open = [...options.values()].filter((o) => !o.state);
    const offChecklist = open.filter((o) => !o.onChecklist).length;
    return {
      importIds: open.filter((o) => o.onChecklist || includeOffChecklist).map((o) => o.speciesId),
      offChecklist,
      leftAlone: options.size - open.length,
    };
  }, [preview, picks, includeOffChecklist]);

  async function read(file: File) {
    setError(null);
    setReading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const query = listRegionId ? { regionId: listRegionId } : undefined;
      setPreview(await api.post(apiPath("/target-lists/preview", {}, query), form));
      setPicks({});
      setIncludeOffChecklist(false);
      if (!existing && !name.trim()) setName(file.name.replace(/\.[^.]+$/, "").slice(0, NAME_MAX_LENGTH));
    } catch (err) {
      setError(errorMessage(err, t("targetLists.import.readFailed")));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (chosen.importIds.length === 0 || (!existing && !name.trim())) return;
    setError(null);
    setSaving(true);
    try {
      const res = await api.post("/target-lists/import", {
        ...(existing ? { listId: existing.id } : { name: name.trim(), regionId }),
        speciesIds: chosen.importIds,
        addToChecklist: includeOffChecklist,
      });
      targetListsChanged();
      onImported?.();
      onClose();
      const undo = () =>
        api
          .post("/target-lists/import/undo", {
            listId: res.listId,
            createdList: res.createdList,
            addedSpeciesIds: res.addedSpeciesIds,
            checklistSpeciesIds: res.checklistSpeciesIds,
          })
          .then(() => {
            targetListsChanged();
            onImported?.();
            toast.success(t("targetLists.import.undone"));
          })
          .catch(() => toast.error(t("targetLists.import.undoFailed")));
      toast.show(
        t("targetLists.import.done", {
          count: res.addedSpeciesIds.length,
          name: existing?.name ?? name.trim(),
        }),
        { tone: "success", actions: [{ label: t("species.edits.undo"), onClick: () => void undo() }] },
      );
    } catch (err) {
      setError(errorMessage(err, t("targetLists.import.saveFailed")));
      setSaving(false);
    }
  }

  const counts = useMemo(() => {
    const c = { matched: 0, ambiguous: 0, unmatched: 0 };
    for (const row of preview?.rows ?? []) c[row.status]++;
    return c;
  }, [preview]);
  const ambiguous = preview?.rows.filter((r) => r.status === "ambiguous") ?? [];
  const unmatched = preview?.rows.filter((r) => r.status === "unmatched").map((r) => r.name) ?? [];
  const optionLabel = (o: Option) => {
    const shown = speciesName(o);
    return shown === o.scientificName ? shown : `${shown} (${o.scientificName})`;
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("targetLists.import.title")}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      footerStart={
        preview && (
          <Button variant="secondary" onClick={() => setPreview(null)} disabled={saving}>
            {t("targetLists.import.back")}
          </Button>
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {preview && (
            <Button
              type="submit"
              loading={saving}
              disabled={chosen.importIds.length === 0 || (!existing && !name.trim())}
            >
              {t("targetLists.import.confirm", { count: chosen.importIds.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {!preview ? (
          <>
            {orderedLists.length > 0 && (
              <Select
                variant="form"
                label={t("targetLists.import.addTo")}
                labelClassName={FIELD_LABEL}
                value={listId}
                onChange={(e) => setListId(e.target.value)}
                className="w-full"
              >
                <option value="">{t("targetLists.import.newList")}</option>
                {orderedLists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.regionName ? t("targetLists.nameWithRegion", { name: l.name, region: l.regionName }) : l.name}
                  </option>
                ))}
              </Select>
            )}
            {!existing && (
              <div className="space-y-1">
                <p className="text-callout text-muted">{t("targetLists.import.region")}</p>
                <RegionBrowser
                  regionId={regionId}
                  onChange={setRegionId}
                  suggestedRegionIds={[viewedRegionId]}
                  hint={t("targetLists.import.regionHint")}
                  searchOnly
                  size="md"
                />
              </div>
            )}
            {reading ? (
              <p className="flex items-center gap-2 text-callout text-muted">
                <InlineSpinner />
                {t("targetLists.import.reading")}
              </p>
            ) : (
              <FilePickArea
                single
                accept=".csv,.txt,text/csv,text/plain"
                prompt={t("targetLists.import.drop")}
                hint={t("targetLists.import.dropHint")}
                onFiles={(files) => void read(files[0])}
              />
            )}
          </>
        ) : (
          <>
            {existing ? (
              <p className="break-words text-callout text-muted">
                {t("targetLists.import.addingTo", { name: existing.name })}
              </p>
            ) : (
              <label className={FIELD_LABEL}>
                <span>{t("targetLists.import.name")}</span>
                <NameField value={name} onChange={(e) => setName(e.target.value)} required />
              </label>
            )}
            <p className="text-body text-ink">
              {t("targetLists.import.summary", {
                matched: formatNumber(counts.matched),
                ambiguous: counts.ambiguous,
                unmatched: counts.unmatched,
              })}
            </p>
            {chosen.leftAlone > 0 && (
              <p className="text-callout text-muted">
                {t("targetLists.import.leftAlone", { count: chosen.leftAlone })}
              </p>
            )}
            {regionName && chosen.offChecklist > 0 && (
              <Checkbox
                checked={includeOffChecklist}
                onChange={setIncludeOffChecklist}
                description={
                  preview.canAddToChecklist
                    ? t("targetLists.import.offChecklistAdds", { region: regionName })
                    : undefined
                }
              >
                {t("targetLists.import.offChecklist", { count: chosen.offChecklist, region: regionName })}
              </Checkbox>
            )}
            {ambiguous.length > 0 && (
              <div className="space-y-2">
                <p className="text-callout font-semibold text-ink">{t("targetLists.import.choose")}</p>
                {ambiguous.map((row) => (
                  <Select
                    key={row.name}
                    variant="form"
                    label={row.name}
                    labelClassName={`${FIELD_LABEL} break-words`}
                    value={picks[row.name] ?? ""}
                    onChange={(e) => setPicks((p) => ({ ...p, [row.name]: e.target.value }))}
                    className="w-full"
                  >
                    <option value="">{t("targetLists.import.skip")}</option>
                    {row.options.map((o) => (
                      <option key={o.speciesId} value={o.speciesId}>
                        {optionLabel(o)}
                      </option>
                    ))}
                  </Select>
                ))}
              </div>
            )}
            {unmatched.length > 0 && (
              <p className="break-words text-callout text-muted">
                {t("targetLists.import.notFound", {
                  names: formatList(
                    unmatched.length > MAX_UNMATCHED_SHOWN
                      ? [
                          ...unmatched.slice(0, MAX_UNMATCHED_SHOWN),
                          t("targetLists.import.andMore", { count: unmatched.length - MAX_UNMATCHED_SHOWN }),
                        ]
                      : unmatched,
                    "unit",
                  ),
                })}
              </p>
            )}
          </>
        )}
        <FormMessage error={error} />
      </div>
    </Modal>
  );
}
