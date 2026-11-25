import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  TEMPLATED_FIELDS,
  WRITE_RULES,
  renderFields,
  unknownTemplateVariables,
  type JobStatus,
  type MetadataFields,
  type TemplateValues,
  type TemplatedField,
  type WriteRule,
} from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import Menu, { MenuItem, MenuPanel } from "../../components/Menu";
import Select from "../../components/Select";
import Switch from "../../components/Switch";
import TemplateField, { type TokenGroup } from "../../components/TemplateField";
import { useConfirm } from "../../hooks/useConfirm";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { ignore } from "../../lib/ignore";
import { SettingRow, SettingsGroup } from "./shared";

interface FieldsData {
  fields: MetadataFields;
  variables: string[];
  captionPresets: Record<string, string>;
}

interface Preview {
  sample: boolean;
  captureId: string | null;
  values: TemplateValues;
}

type ApplyStatus = JobStatus<unknown> & { updated: number; unchanged: number; failed: number; edited: number };

const SPECIES = { all: "all", main: "main" } as const;
const FIELD_LABEL: Record<TemplatedField, string> = {
  title: "settings.metadata.templates.fields.title",
  headline: "settings.metadata.templates.fields.headline",
  caption: "settings.metadata.templates.fields.caption",
  keywords: "settings.metadata.templates.fields.keywords",
};
const FIELD_HINT: Record<TemplatedField, string> = {
  title: "settings.metadata.templates.hints.title",
  headline: "settings.metadata.templates.hints.headline",
  caption: "settings.metadata.templates.hints.caption",
  keywords: "settings.metadata.templates.hints.keywords",
};
const FIELD_PLACEHOLDER: Record<TemplatedField, string> = {
  title: "settings.metadata.templates.placeholders.title",
  headline: "settings.metadata.templates.placeholders.headline",
  caption: "settings.metadata.templates.placeholders.caption",
  keywords: "settings.metadata.templates.placeholders.keywords",
};
const RULE_LABEL: Record<WriteRule, string> = {
  fillEmpty: "settings.metadata.templates.rules.fillEmpty.label",
  replace: "settings.metadata.templates.rules.replace.label",
  append: "settings.metadata.templates.rules.append.label",
  off: "settings.metadata.templates.rules.off.label",
};
const RULE_HINT: Record<WriteRule, string> = {
  fillEmpty: "settings.metadata.templates.rules.fillEmpty.hint",
  replace: "settings.metadata.templates.rules.replace.hint",
  append: "settings.metadata.templates.rules.append.hint",
  off: "settings.metadata.templates.rules.off.hint",
};
const PRESET_LABEL: Record<string, string> = {
  place: "settings.metadata.templates.presets.place",
  imageOf: "settings.metadata.templates.presets.imageOf",
};
const TOKEN_LABEL: Record<string, string> = {
  species: "settings.metadata.tokens.species",
  scientific: "settings.metadata.tokens.scientific",
  group: "settings.metadata.tokens.group",
  genus: "settings.metadata.tokens.genus",
  family: "settings.metadata.tokens.family",
  order: "settings.metadata.tokens.order",
  class: "settings.metadata.tokens.class",
  place: "settings.metadata.tokens.place",
  region: "settings.metadata.tokens.region",
  country: "settings.metadata.tokens.country",
  trip: "settings.metadata.tokens.trip",
  date: "settings.metadata.tokens.date",
  longdate: "settings.metadata.tokens.longdate",
  year: "settings.metadata.tokens.year",
  month: "settings.metadata.tokens.month",
  camera: "settings.metadata.tokens.camera",
  lens: "settings.metadata.tokens.lens",
  focal: "settings.metadata.tokens.focal",
  aperture: "settings.metadata.tokens.aperture",
  shutter: "settings.metadata.tokens.shutter",
  iso: "settings.metadata.tokens.iso",
  rating: "settings.metadata.tokens.rating",
  names: "settings.metadata.tokens.names",
  count: "settings.metadata.tokens.count",
};

/** Title, headline, caption and extra keywords as templates with a write rule each, one preview of
 *  all of them, and the job that writes them into photos already in the library. */
export default function MetadataTemplatesGroup({
  blocked,
  onCaptionSaved,
}: {
  /** Unsaved credits above: applying waits for them too. */
  blocked: boolean;
  onCaptionSaved: (caption: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const presetMenu = useDropdownMenu();
  const [data, setData] = useState<FieldsData | null>(null);
  const [saved, setSaved] = useState<MetadataFields | null>(null);
  const [draft, setDraft] = useState<MetadataFields | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error?: string | null; success?: string | null }>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [captureId, setCaptureId] = useState<string | undefined>();
  const [photoIds, setPhotoIds] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const apply = useJobPoll<ApplyStatus>("/settings/metadata-template/apply/status");
  const applyStatus = apply.status;

  useEffect(() => {
    api
      .get("/settings/metadata-fields")
      .then((res) => {
        setData(res);
        setSaved(res.fields);
        setDraft(res.fields);
      })
      .catch((err: unknown) => setLoadError(errorMessage(err, t("settings.loadFailed"))));
  }, [t]);

  // The values follow the multi-species choice, so the preview names species as the switch says.
  const multiSpecies = draft?.multiSpecies;
  useEffect(() => {
    if (!multiSpecies) return;
    let live = true;
    api
      .get(apiPath("/settings/metadata-preview", {}, captureId ? { captureId, multiSpecies } : { multiSpecies }))
      .then((res) => live && setPreview(res))
      .catch(ignore("Couldn't load a metadata preview"));
    return () => {
      live = false;
    };
  }, [multiSpecies, captureId]);

  const groups = useMemo<TokenGroup[]>(() => {
    const has = new Set(data?.variables);
    const pick = (tokens: string[]) => tokens.filter((x) => has.has(x));
    return [
      {
        label: t("settings.metadata.tokenGroups.taxonomy"),
        tokens: pick(["species", "scientific", "group", "genus", "family", "order", "class"]),
      },
      { label: t("settings.metadata.tokenGroups.place"), tokens: pick(["place", "region", "country", "trip"]) },
      {
        label: t("settings.metadata.tokenGroups.capture"),
        tokens: pick([
          "date",
          "longdate",
          "year",
          "month",
          "camera",
          "lens",
          "focal",
          "aperture",
          "shutter",
          "iso",
          "rating",
        ]),
      },
      { label: t("settings.metadata.tokenGroups.aggregate"), tokens: pick(["names", "count"]) },
    ];
  }, [data, t]);
  const tokenLabel = (token: string) => (TOKEN_LABEL[token] ? t(TOKEN_LABEL[token]) : token);

  if (loadError) return <FormMessage error={loadError} />;
  if (!data || !saved || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const unknown = TEMPLATED_FIELDS.flatMap((f) => unknownTemplateVariables(draft[f].template, data.variables))[0];
  const invalid = unknown ? t("settings.metadata.unknownVariable", { variable: `{${unknown}}` }) : null;
  const rendered = preview ? renderFields(draft, preview.values) : null;
  const setField = (f: TemplatedField, patch: Partial<MetadataFields[TemplatedField]>) =>
    setDraft({ ...draft, [f]: { ...draft[f], ...patch } });

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage({});
    try {
      const res = await api.put("/settings/metadata-fields", draft);
      setSaved(res.fields);
      setDraft(res.fields);
      onCaptionSaved(res.fields.caption.template);
      setMessage({ success: t("settings.metadata.templates.saved") });
    } catch (err) {
      setMessage({ error: errorMessage(err, t("settings.metadata.templates.saveFailed")) });
    } finally {
      setSaving(false);
    }
  }

  // Another of the user's photos: the list is fetched once, on first use.
  async function tryAnother() {
    try {
      let ids = photoIds;
      if (!ids) {
        ids = (await api.get(apiPath("/gallery", {}, { limit: 50 }))).items.map((i) => i.captureId);
        setPhotoIds(ids);
      }
      const others = ids.filter((id) => id !== preview?.captureId);
      if (others.length > 0) setCaptureId(others[Math.floor(Math.random() * others.length)]);
    } catch (err) {
      setMessage({ error: errorMessage(err, t("settings.metadata.templates.anotherFailed")) });
    }
  }

  // The count comes first, so nothing is written before the user has seen how much it touches.
  async function applyToAll() {
    setChecking(true);
    setMessage({});
    try {
      const counts = await api.post(apiPath("/settings/metadata-template/apply", {}, { dryRun: "1" }));
      const updated = counts.updated ?? 0;
      if (updated === 0) {
        setMessage({ success: t("settings.metadata.templates.applyNothing") });
        return;
      }
      const ok = await confirm({
        title: t("settings.metadata.credits.applyConfirm.title"),
        message: t("settings.metadata.credits.applyConfirm.message", { updated, edited: counts.edited ?? 0 }),
        confirmLabel: t("settings.metadata.credits.applyAction"),
      });
      if (ok) await apply.start(apiPath("/settings/metadata-template/apply", {}, { background: "1" }));
    } catch (err) {
      setMessage({ error: errorMessage(err, t("settings.metadata.templates.dryRunFailed")) });
    } finally {
      setChecking(false);
    }
  }

  const previewRows = TEMPLATED_FIELDS.map((f) => {
    const value = rendered ? (f === "keywords" ? rendered.keywords.join(", ") : rendered[f]) : "";
    return { f, value, off: draft[f].rule === "off" };
  });

  return (
    <SettingsGroup title={t("settings.metadata.templates.title")}>
      {TEMPLATED_FIELDS.map((f) => {
        const field = draft[f];
        const hintId = `rule-hint-${f}`;
        return (
          <SettingRow key={f} label={t(FIELD_LABEL[f])} description={t(FIELD_HINT[f])}>
            <TemplateField
              value={field.template}
              onChange={(template) => setField(f, { template })}
              groups={groups}
              tokenLabel={tokenLabel}
              label={t(FIELD_LABEL[f])}
              placeholder={t(FIELD_PLACEHOLDER[f])}
              maxLength={2000}
              help={[
                t("settings.metadata.templates.help.chips", { brace: "{" }),
                t("settings.metadata.templates.help.optional", { example: "[[ taken on {longdate}]]" }),
              ]}
              actions={
                f === "caption" && (
                  <Menu
                    open={presetMenu.openKey !== null}
                    onToggle={() => (presetMenu.openKey ? presetMenu.close() : presetMenu.setOpenKey(true))}
                    menuRef={presetMenu.ref}
                    className="relative inline-block"
                    trigger={(props) => (
                      <Button {...props} variant="secondary" size="sm">
                        {t("settings.metadata.templates.presets.label")}
                      </Button>
                    )}
                  >
                    <MenuPanel align="left" className="max-h-72 w-72 overflow-y-auto!">
                      {Object.entries(data.captionPresets).map(([key, template]) => (
                        <MenuItem key={key} onSelect={() => setField("caption", { template })}>
                          <span className="block">{PRESET_LABEL[key] ? t(PRESET_LABEL[key]) : key}</span>
                          <span className="block break-words font-mono text-muted">{template}</span>
                        </MenuItem>
                      ))}
                    </MenuPanel>
                  </Menu>
                )
              }
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Select
                aria-label={t("settings.metadata.templates.ruleLabel", { field: t(FIELD_LABEL[f]) })}
                aria-describedby={hintId}
                value={field.rule}
                onChange={(e) => setField(f, { rule: e.target.value as WriteRule })}
              >
                {WRITE_RULES.map((r) => (
                  <option key={r} value={r}>
                    {t(RULE_LABEL[r])}
                  </option>
                ))}
              </Select>
              <p id={hintId} className="min-w-0 text-footnote text-muted">
                {t(RULE_HINT[field.rule])}
              </p>
            </div>
          </SettingRow>
        );
      })}
      <SettingRow
        label={t("settings.metadata.templates.multi.label")}
        description={t(
          draft.multiSpecies === "all"
            ? "settings.metadata.templates.multi.allHint"
            : "settings.metadata.templates.multi.mainHint",
        )}
        control={
          <Switch
            label={t("settings.metadata.templates.multi.label")}
            checked={draft.multiSpecies === "all"}
            onChange={(all) => setDraft({ ...draft, multiSpecies: all ? SPECIES.all : SPECIES.main })}
          />
        }
      />
      <SettingRow
        label={t("settings.metadata.templates.preview.label")}
        description={
          preview &&
          (preview.sample
            ? t("settings.metadata.templates.preview.sample")
            : t("settings.metadata.templates.preview.photo", { name: preview.values.original ?? "" }))
        }
        control={
          <Button variant="secondary" size="sm" onClick={() => void tryAnother()} disabled={preview?.sample}>
            {t("settings.metadata.templates.preview.another")}
          </Button>
        }
      >
        <dl className="grid gap-x-3 gap-y-1 rounded-panel bg-surface-muted px-3 py-2 text-footnote sm:grid-cols-[max-content_minmax(0,1fr)]">
          {previewRows.map(({ f, value, off }) => (
            <div key={f} className="contents">
              <dt className="text-muted">{t(FIELD_LABEL[f])}</dt>
              <dd className={`break-words ${value && !off ? "text-ink" : "text-muted"}`}>
                {off
                  ? t("settings.metadata.templates.preview.off")
                  : value || t("settings.metadata.templates.preview.empty")}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty || !!invalid}>
            {t("settings.metadata.credits.save")}
          </Button>
          <FormMessage error={invalid ?? message.error} success={dirty ? null : message.success} />
        </div>
      </SettingRow>
      <SettingRow
        label={t("settings.metadata.credits.apply")}
        description={t(
          dirty || blocked ? "settings.metadata.credits.applySaveFirst" : "settings.metadata.credits.applyDescription",
        )}
        control={
          !applyStatus?.running && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void applyToAll()}
              loading={checking || apply.starting}
              disabled={dirty || blocked}
            >
              {t("settings.metadata.credits.applyAction")}
            </Button>
          )
        }
      >
        {applyStatus?.running && (
          <JobProgress
            compact
            status={applyStatus}
            fallbackLabel={t("settings.metadata.credits.applying")}
            onCancel={() => apply.cancel("/settings/metadata-template/apply/cancel")}
            cancelling={apply.cancelling}
          />
        )}
        {!applyStatus?.running && applyStatus?.finishedAt != null && !applyStatus.error && (
          <>
            <FormMessage
              success={t(
                applyStatus.cancelled
                  ? "settings.metadata.credits.applyStopped"
                  : "settings.metadata.credits.applyResult",
                { updated: applyStatus.updated, unchanged: applyStatus.unchanged },
              )}
            />
            {applyStatus.edited > 0 && (
              <p className="text-footnote text-muted">
                {t("settings.metadata.credits.applyKeptEdits", { count: applyStatus.edited })}
              </p>
            )}
            {applyStatus.failed > 0 && (
              <FormMessage error={t("settings.metadata.credits.applyFailedFiles", { count: applyStatus.failed })} />
            )}
          </>
        )}
        <FormMessage
          error={applyStatus?.error ? t("settings.metadata.credits.applyFailed") : (apply.actionError ?? null)}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
