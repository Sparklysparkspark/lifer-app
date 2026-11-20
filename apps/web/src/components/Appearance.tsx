import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  APPEARANCE_TEXT_MAX,
  LIFE_STAGES,
  PLUMAGE_SUGGESTIONS,
  SEXES,
  appearanceText,
  type Appearance,
  type LifeStage,
  type Sex,
} from "@lifer/shared";
import { PLUMAGE_KEYS, appearanceValues, useAppearanceLabels } from "../lib/appearance";
import { api, ApiError } from "../api/client";
import { useToast } from "../hooks/useToast";
import Button from "./Button";
import Modal from "./Modal";
import Select from "./Select";
import TextField from "./TextField";

/** The values set on a photo, as small badges. Nothing when none is set. */
export function AppearanceBadges({
  appearance,
  dark = false,
  className,
}: {
  appearance: Appearance | null | undefined;
  /** For the viewer's fixed black backdrop. */
  dark?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const labels = useAppearanceLabels();
  if (!appearance) return null;
  const badges = [
    appearance.lifeStage && {
      key: "stage",
      text: labels.stage(appearance.lifeStage),
      title: t("appearance.lifeStage"),
    },
    appearance.sex && { key: "sex", text: labels.sex(appearance.sex), title: t("appearance.sexLabel") },
    appearance.plumage && { key: "plumage", text: appearance.plumage, title: t("appearance.plumageLabel") },
    appearance.morph && { key: "morph", text: appearance.morph, title: t("appearance.morph") },
  ].filter((b): b is { key: string; text: string; title: string } => !!b);
  if (badges.length === 0) return null;
  return (
    <ul className={`flex min-w-0 flex-wrap items-center gap-1 ${className ?? ""}`} aria-label={t("appearance.title")}>
      {badges.map((b) => (
        <li
          key={b.key}
          title={`${b.title}: ${b.text}`}
          // Long morph names wrap inside the badge rather than run off or get cut.
          className={`max-w-full rounded-full border px-2 py-0.5 text-footnote wrap-anywhere ${
            // design-token: the viewer's caption sits on a fixed black backdrop, as TagEditor's dark chips
            dark ? "border-white/30 bg-white/10 text-white" : "border-line bg-surface-muted text-ink"
          }`}
        >
          {b.text}
        </li>
      ))}
    </ul>
  );
}

const SUMMARY_MAX = 8;

/** A quiet line on a species page: the life stages, sexes and morphs among your photos of it. */
export function AppearanceSummary({ items, className }: { items: Appearance[]; className?: string }) {
  const { t } = useTranslation();
  const labels = useAppearanceLabels();
  const values = appearanceValues(items);
  if (values.length === 0) return null;
  const words = values
    .slice(0, SUMMARY_MAX)
    .map((v) =>
      v.kind === "lifeStage"
        ? labels.stage(v.value as LifeStage)
        : v.kind === "sex"
          ? labels.sex(v.value as Sex)
          : v.value,
    );
  const more = values.length - SUMMARY_MAX;
  return (
    <p className={`min-w-0 text-footnote text-muted wrap-anywhere ${className ?? ""}`}>
      {t("appearance.photographedAs")}: {words.join(", ")}
      {more > 0 && ` ${t("appearance.more", { count: more })}`}
    </p>
  );
}

const KEEP = "keep";

/** Sets how the animal looks on one photo (`initial` is its values) or a selection (no `initial`:
 *  every field starts as "Leave as is"). Saves in the background; `onSaved` gets what changed. */
export function AppearanceModal({
  captureIds,
  initial,
  morphOptions = [],
  onSaved,
  onFailed,
  onClose,
}: {
  captureIds: string[];
  initial?: Appearance;
  /** Morphs already used, offered while typing. */
  morphOptions?: string[];
  onSaved: (changes: Partial<Appearance>) => void;
  /** After a save that didn't go through, to put the page back. */
  onFailed?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const labels = useAppearanceLabels();
  const listId = useId();
  const bulk = !initial;
  const [lifeStage, setLifeStage] = useState<string>(bulk ? KEEP : (initial?.lifeStage ?? ""));
  const [sex, setSex] = useState<string>(bulk ? KEEP : (initial?.sex ?? ""));
  const [plumage, setPlumage] = useState<string | null>(bulk ? null : (initial?.plumage ?? ""));
  const [morph, setMorph] = useState<string | null>(bulk ? null : (initial?.morph ?? ""));

  function save(e: React.FormEvent) {
    e.preventDefault();
    const changes: Partial<Appearance> = {};
    const pick = <T,>(value: string): T | null => (value ? (value as T) : null);
    if (lifeStage !== KEEP && pick(lifeStage) !== (initial?.lifeStage ?? null))
      changes.lifeStage = pick<LifeStage>(lifeStage);
    if (sex !== KEEP && pick(sex) !== (initial?.sex ?? null)) changes.sex = pick<Sex>(sex);
    // A text field is null until typed in, so a selection's untouched field stays as it is.
    if (plumage !== null && appearanceText(plumage) !== (initial?.plumage ?? null))
      changes.plumage = appearanceText(plumage);
    if (morph !== null && appearanceText(morph) !== (initial?.morph ?? null)) changes.morph = appearanceText(morph);
    onClose();
    if (Object.keys(changes).length === 0) return;
    onSaved(changes);
    // The API takes up to 5,000 photos a request; a whole-library selection goes in parts.
    const send = async () => {
      for (let i = 0; i < captureIds.length; i += 5000)
        await api.post("/captures/appearance", { captureIds: captureIds.slice(i, i + 5000), ...changes });
    };
    send().catch((err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : t("appearance.saveFailed"));
      // One photo: put its values back. A selection: the page reloads.
      if (initial) {
        const before = initial;
        onSaved(Object.fromEntries(Object.keys(changes).map((k) => [k, before[k as keyof Appearance]])));
      }
      onFailed?.();
    });
  }

  const keepOption = bulk && <option value={KEEP}>{t("appearance.leaveAsIs")}</option>;
  const textPlaceholder = bulk ? t("appearance.leaveAsIs") : t("appearance.notSet");
  const morphs = [...new Set(morphOptions)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <Modal
      open
      onClose={onClose}
      title={bulk ? t("appearance.titleMany", { count: captureIds.length }) : t("appearance.title")}
      onSubmit={save}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit">{t("common.save")}</Button>
        </>
      }
    >
      <div className="grid gap-3 text-callout">
        <Select
          variant="form"
          label={t("appearance.lifeStage")}
          labelClassName="grid gap-1 text-muted"
          value={lifeStage}
          onChange={(e) => setLifeStage(e.target.value)}
        >
          {keepOption}
          <option value="">{t("appearance.notSet")}</option>
          {LIFE_STAGES.map((v) => (
            <option key={v} value={v}>
              {labels.stage(v)}
            </option>
          ))}
        </Select>
        <Select
          variant="form"
          label={t("appearance.sexLabel")}
          labelClassName="grid gap-1 text-muted"
          value={sex}
          onChange={(e) => setSex(e.target.value)}
        >
          {keepOption}
          <option value="">{t("appearance.notSet")}</option>
          {SEXES.map((v) => (
            <option key={v} value={v}>
              {labels.sex(v)}
            </option>
          ))}
        </Select>
        <label className="grid gap-1 text-muted">
          {t("appearance.plumageLabel")}
          <TextField
            value={plumage ?? ""}
            onChange={(e) => setPlumage(e.target.value)}
            placeholder={textPlaceholder}
            maxLength={APPEARANCE_TEXT_MAX}
            list={`${listId}-plumage`}
          />
        </label>
        <div className="grid gap-1 text-muted">
          <label className="grid gap-1">
            {t("appearance.morph")}
            <TextField
              value={morph ?? ""}
              onChange={(e) => setMorph(e.target.value)}
              placeholder={textPlaceholder}
              maxLength={APPEARANCE_TEXT_MAX}
              list={`${listId}-morph`}
              aria-describedby={`${listId}-morph-hint`}
            />
          </label>
          <p id={`${listId}-morph-hint`} className="text-footnote">
            {t("appearance.morphHint")}
          </p>
        </div>
        {/* The browser's own suggestion list under each field: filters as you type, any length. */}
        <datalist id={`${listId}-plumage`}>
          {PLUMAGE_SUGGESTIONS.map((v) => (
            <option key={v} value={t(PLUMAGE_KEYS[v])} />
          ))}
        </datalist>
        <datalist id={`${listId}-morph`}>
          {morphs.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </div>
    </Modal>
  );
}
