import { useEffect, useRef, useState } from "react";
import { matches } from "../../lib/keymap";
import { useTranslation } from "react-i18next";
import {
  FILE_NAME_PRESETS,
  FILE_NAME_VARIABLES,
  TEMPLATE_VARIABLES,
  fileNamePreset,
  renderTemplate,
  unknownTemplateVariables,
  type FileNamePreset,
  type MetadataTemplate,
  type TemplateValues,
} from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InfoTip from "../../components/InfoTip";
import Select from "../../components/Select";
import Switch from "../../components/Switch";
import TextField, { TextArea } from "../../components/TextField";
import { errorMessage } from "../../lib/errorMessage";
import { ignore } from "../../lib/ignore";
import { SettingLinkRow, SettingRow, SettingsGroup } from "./shared";
import FileWritingSettings from "./FileWritingSettings";
import MetadataTemplatesGroup from "./MetadataTemplatesGroup";

interface MetadataSettingsData {
  template: MetadataTemplate;
  fileNameTemplate: string;
  sensitiveSpecies: { enabled: boolean };
}

interface Example {
  values: TemplateValues;
  fileName: string;
  sample: boolean;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

// What Lifer writes into photo files, and which species' places stay off share links. File names
// live in Library beside the folder layout, since together they make a photo's path. Templates
// fill per photo (packages/shared/src/metadataTemplate.ts), so the preview renders what the API writes.
export default function MetadataSettings() {
  const [data, setData] = useState<MetadataSettingsData | null>(null);
  const [creditsDirty, setCreditsDirty] = useState(false);
  // The caption template is edited with the other templates but stored with the credits.
  const [caption, setCaption] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    api
      .get("/settings/metadata")
      .then((res) => {
        setCaption(res.template.caption);
        setData(res);
      })
      .catch((err: unknown) => setLoadError(errorMessage(err, t("settings.loadFailed"))));
  }, [t]);

  if (loadError) return <FormMessage error={loadError} />;
  if (!data) return null;
  return (
    <>
      <CreditsGroup initial={data.template} caption={caption} onDirtyChange={setCreditsDirty} />
      <MetadataTemplatesGroup blocked={creditsDirty} onCaptionSaved={setCaption} />
      <FileWritingSettings />
      <SensitiveGroup initial={data.sensitiveSpecies.enabled} />
    </>
  );
}

const CREDIT_FIELDS = ["creator", "copyright", "credit", "usageTerms"] as const;
type CreditField = (typeof CREDIT_FIELDS)[number];
// Free text that can run long gets room to wrap.
const LONG_FIELDS: readonly CreditField[] = ["usageTerms"];

const FIELD_LABEL: Record<CreditField, string> = {
  creator: "settings.metadata.credits.creator",
  copyright: "settings.metadata.credits.copyright",
  credit: "settings.metadata.credits.credit",
  usageTerms: "settings.metadata.credits.usageTerms",
};

/** Buttons that insert a {variable} where the cursor is in a field. */
function VariableChips({ variables, onInsert }: { variables: readonly string[]; onInsert: (token: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-footnote text-muted">{t("settings.metadata.insert")}</span>
      {variables.map((v) => (
        <Button
          key={v}
          variant="secondary"
          size="sm"
          className="font-mono"
          aria-label={t("settings.metadata.credits.insertVariable", { variable: v })}
          // Keeps focus in the field, so the cursor position is still known.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(`{${v}}`)}
        >
          {`{${v}}`}
        </Button>
      ))}
    </div>
  );
}

/** Inserts text at the field's cursor, or at the end when it never had focus. */
function insertAt(input: Field | null, value: string, token: string): string {
  const start = input?.selectionStart ?? value.length;
  const end = input?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + token + value.slice(end);
  requestAnimationFrame(() => {
    input?.focus();
    input?.setSelectionRange(start + token.length, start + token.length);
  });
  return next;
}

/** "Unknown variable {x}" for the first variable a template can't fill, or null. */
function useUnknownVariable(templates: string[], allowed: readonly string[]): string | null {
  const { t } = useTranslation();
  const unknown = templates.flatMap((tpl) => unknownTemplateVariables(tpl, allowed))[0];
  return unknown ? t("settings.metadata.unknownVariable", { variable: `{${unknown}}` }) : null;
}

function CreditsGroup({
  initial,
  caption,
  onDirtyChange,
}: {
  initial: MetadataTemplate;
  /** The saved caption template, sent back unchanged since it shares the stored record. */
  caption: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savingReplace, setSavingReplace] = useState(false);
  const [message, setMessage] = useState<{ error?: string | null; success?: string | null }>({});
  const [example, setExample] = useState<Example | null>(null);
  const fieldRefs = useRef<Partial<Record<CreditField, Field | null>>>({});
  const [focused, setFocused] = useState<CreditField>("copyright");

  useEffect(() => {
    api.get("/settings/template-example").then(setExample).catch(ignore("Couldn't load a template example"));
  }, []);

  const dirty = CREDIT_FIELDS.some((f) => draft[f] !== saved[f]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const invalid = useUnknownVariable(
    CREDIT_FIELDS.map((f) => draft[f]),
    TEMPLATE_VARIABLES,
  );
  const preview = example
    ? CREDIT_FIELDS.map((f) => [f, renderTemplate(draft[f], example.values)] as const).filter(([, v]) => v)
    : [];

  async function save() {
    setSaving(true);
    setMessage({});
    try {
      const res = await api.put("/settings/metadata-template", {
        ...draft,
        caption,
        replaceExisting: saved.replaceExisting,
      });
      setSaved(res.template);
      setDraft(res.template);
      setMessage({ success: t("settings.metadata.credits.saved") });
    } catch (err) {
      setMessage({ error: errorMessage(err, t("settings.metadata.credits.saveFailed")) });
    } finally {
      setSaving(false);
    }
  }

  // A switch takes effect at once, like every other switch in Settings; unsaved text stays a draft.
  async function setReplaceExisting(replaceExisting: boolean) {
    setSavingReplace(true);
    setMessage({});
    try {
      const res = await api.put("/settings/metadata-template", { ...saved, caption, replaceExisting });
      setSaved(res.template);
      setDraft((d) => ({ ...d, replaceExisting: res.template.replaceExisting }));
    } catch (err) {
      setMessage({ error: errorMessage(err, t("settings.metadata.credits.saveFailed")) });
    } finally {
      setSavingReplace(false);
    }
  }

  const placeholders: Partial<Record<CreditField, string>> = {
    creator: t("settings.metadata.credits.creatorPlaceholder"),
    copyright: `© {year} ${draft.creator || t("settings.metadata.credits.creatorPlaceholder")}`,
    usageTerms: t("settings.metadata.credits.usageTermsPlaceholder"),
  };

  return (
    <SettingsGroup title={t("settings.metadata.credits.title")}>
      <SettingRow
        label={t("settings.metadata.credits.fieldsLabel")}
        description={t("settings.metadata.credits.description")}
        control={
          <InfoTip
            align="right"
            paragraphs={[
              t("settings.metadata.credits.help.where"),
              t("settings.metadata.credits.help.empty"),
              t("settings.metadata.credits.help.kept"),
            ]}
          />
        }
      >
        <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-baseline">
          {CREDIT_FIELDS.map((field) => {
            const common = {
              id: `credit-${field}`,
              value: draft[field],
              maxLength: LONG_FIELDS.includes(field) ? 2000 : 500,
              placeholder: placeholders[field],
              onFocus: () => setFocused(field),
            };
            return (
              <div key={field} className="contents">
                <label htmlFor={common.id} className="text-subheadline text-ink sm:pt-1">
                  {t(FIELD_LABEL[field])}
                </label>
                {LONG_FIELDS.includes(field) ? (
                  <TextArea
                    {...common}
                    ref={(el) => {
                      fieldRefs.current[field] = el;
                    }}
                    rows={2}
                    className="w-full resize-y"
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  />
                ) : (
                  <TextField
                    {...common}
                    ref={(el) => {
                      fieldRefs.current[field] = el;
                    }}
                    className="w-full"
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  />
                )}
              </div>
            );
          })}
        </div>
        <VariableChips
          variables={TEMPLATE_VARIABLES}
          onInsert={(token) =>
            setDraft({ ...draft, [focused]: insertAt(fieldRefs.current[focused] ?? null, draft[focused], token) })
          }
        />
        {example && (
          <div className="rounded-panel bg-surface-muted px-3 py-2 text-footnote">
            <p className="text-muted">
              {example.sample
                ? t("settings.metadata.credits.samplePreview")
                : t("settings.metadata.credits.preview", { name: example.values.original ?? "" })}
            </p>
            {preview.length === 0 ? (
              <p className="text-muted">{t("settings.metadata.credits.noPreview")}</p>
            ) : (
              <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
                {preview.map(([field, value]) => (
                  <div key={field} className="contents">
                    <dt className="text-muted">{t(FIELD_LABEL[field])}</dt>
                    <dd className="break-words text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty || !!invalid}>
            {t("settings.metadata.credits.save")}
          </Button>
          <FormMessage error={invalid ?? message.error} success={dirty ? null : message.success} />
        </div>
      </SettingRow>
      <SettingRow
        label={t("settings.metadata.credits.replaceExisting")}
        description={t("settings.metadata.credits.replaceExistingDescription")}
        control={
          <Switch
            label={t("settings.metadata.credits.replaceExisting")}
            checked={saved.replaceExisting}
            disabled={savingReplace}
            onChange={(next) => void setReplaceExisting(next)}
          />
        }
      />
    </SettingsGroup>
  );
}

const PRESET_LABEL: Record<FileNamePreset | "custom", string> = {
  original: "settings.metadata.fileNames.presets.original",
  dateSpecies: "settings.metadata.fileNames.presets.dateSpecies",
  speciesDate: "settings.metadata.fileNames.presets.speciesDate",
  custom: "settings.metadata.fileNames.presets.custom",
};

/** The "Name new photos" row, shown in Library beside the folder layout. */
export function FileNameRow() {
  const [initial, setInitial] = useState<string | null>(null);
  useEffect(() => {
    api
      .get("/settings/metadata")
      .then((res) => setInitial(res.fileNameTemplate))
      .catch(ignore("Couldn't load the file name template"));
  }, []);
  return initial === null ? null : <FileNameEditor initial={initial} />;
}

function FileNameEditor({ initial }: { initial: string }) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [example, setExample] = useState<Example | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const preset = fileNamePreset(template);
  const custom = preset === "custom" || editing;
  const invalid = useUnknownVariable([draft], FILE_NAME_VARIABLES);

  // The example follows what's typed, a moment after typing stops.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api
        .get(apiPath("/settings/template-example", {}, { fileName: draft || FILE_NAME_PRESETS.original }))
        .then((res) => live && setExample(res))
        .catch(() => live && setExample(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft]);

  async function save(next: string) {
    if (next === template || unknownTemplateVariables(next, FILE_NAME_VARIABLES).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.put("/settings/file-name-template", { template: next });
      setTemplate(res.fileNameTemplate);
      setDraft(res.fileNameTemplate);
    } catch (err) {
      setError(errorMessage(err, t("settings.metadata.fileNames.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  function choose(value: FileNamePreset | "custom") {
    if (value === "custom") {
      setEditing(true);
      return;
    }
    setEditing(false);
    setDraft(FILE_NAME_PRESETS[value]);
    void save(FILE_NAME_PRESETS[value]);
  }

  return (
    <SettingRow
      label={t("settings.metadata.fileNames.label")}
      description={t("settings.metadata.fileNames.description")}
      control={
        <div className="flex items-center gap-2">
          <InfoTip
            align="right"
            paragraphs={[t("settings.metadata.fileNames.help.seq"), t("settings.metadata.fileNames.help.companions")]}
          />
          <Select
            aria-label={t("settings.metadata.fileNames.label")}
            value={custom ? "custom" : preset}
            disabled={saving}
            onChange={(e) => choose(e.target.value as FileNamePreset | "custom")}
          >
            {(Object.keys(PRESET_LABEL) as Array<FileNamePreset | "custom">).map((p) => (
              <option key={p} value={p}>
                {t(PRESET_LABEL[p])}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {custom && (
        <>
          <TextField
            ref={inputRef}
            aria-label={t("settings.metadata.fileNames.template")}
            className="w-full font-mono"
            value={draft}
            maxLength={300}
            placeholder={FILE_NAME_PRESETS.dateSpecies}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save(draft)}
            onKeyDown={(e) => matches(e, "confirm") && void save(draft)}
          />
          <VariableChips
            variables={FILE_NAME_VARIABLES}
            onInsert={(token) => setDraft(insertAt(inputRef.current, draft, token))}
          />
        </>
      )}
      {example && !invalid && (
        <p className="text-footnote text-muted">
          {t(example.sample ? "settings.metadata.fileNames.sampleExample" : "settings.metadata.fileNames.example")}{" "}
          <span className="break-all font-medium text-ink">{example.fileName}</span>
        </p>
      )}
      <FormMessage error={invalid ?? error} />
    </SettingRow>
  );
}

function SensitiveGroup({ initial }: { initial: boolean }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      setEnabled((await api.put("/settings/sensitive-species", { enabled: next })).enabled);
    } catch (err) {
      setError(errorMessage(err, t("settings.metadata.sensitive.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup title={t("settings.metadata.sensitive.title")}>
      <SettingRow
        label={t("settings.metadata.sensitive.label")}
        description={t("settings.metadata.sensitive.description")}
        control={
          <div className="flex items-center gap-2">
            <InfoTip
              align="right"
              paragraphs={[t("settings.metadata.sensitive.help.which"), t("settings.metadata.sensitive.help.where")]}
            />
            <Switch
              label={t("settings.metadata.sensitive.label")}
              checked={enabled}
              disabled={saving}
              onChange={(next) => void toggle(next)}
            />
          </div>
        }
      >
        {error && <FormMessage error={error} />}
      </SettingRow>
      <SettingLinkRow to="/sensitive-species" label={t("settings.metadata.sensitive.manage")} />
    </SettingsGroup>
  );
}
