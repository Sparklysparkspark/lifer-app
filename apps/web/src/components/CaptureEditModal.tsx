import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import { formatPercent } from "../lib/format";
import { ignore } from "../lib/ignore";
import { useSpeciesName } from "../lib/speciesName";
import Button from "./Button";
import Modal from "./Modal";
import ProbableGroupText from "./ProbableGroupText";
import TagEditor from "./TagEditor";
import SpeciesPicker, { type SpeciesResult, type SuggestedSpecies } from "./SpeciesPicker";

/** What the dialogs read from the photo; pages map their own row shape to this. */
export interface EditedCapture {
  /** Lets "Correct the ID" offer the photo's likeliest other species. */
  captureId?: string;
  tags: string[];
  locationLabel?: string | null;
  regionId?: string | null;
}

export type CaptureEdit = "reassign" | "tagSpecies" | "tags";

// A photo menu's longer edits, each in its own dialog so the menu stays a plain list of actions. A
// page passes the handlers for the edits its menu offers.
export default function CaptureEditModal({
  edit,
  capture,
  onClose,
  onReassign,
  onTagSpecies,
  tagOptions,
  onTagsChange,
  scope,
}: {
  edit: CaptureEdit;
  /** The viewer's "Apply to all photos in this burst" checkbox, for Correct the ID. */
  scope?: ReactNode;
  capture: EditedCapture;
  tagOptions: string[];
  /** Tags save as they're added or removed, like everywhere else tags are edited. */
  onTagsChange: (tags: string[]) => void;
  onClose: () => void;
  onReassign: (species: SpeciesResult) => void;
  onTagSpecies?: (speciesId: string) => void;
}) {
  const { t } = useTranslation();
  if (edit === "tags")
    return (
      <Modal
        open
        onClose={onClose}
        title={t("captureEdit.tags")}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t("common.done")}
          </Button>
        }
      >
        <TagEditor compact tags={capture.tags} existingTags={tagOptions} onChange={onTagsChange} />
      </Modal>
    );
  const reassign = edit === "reassign";
  return (
    <Modal
      open
      onClose={onClose}
      title={reassign ? t("captureEdit.reassign.title") : t("captureEdit.tagSpecies.title")}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      }
    >
      <p className="mb-3 text-callout text-muted">
        {reassign ? t("captureEdit.reassign.description") : t("captureEdit.tagSpecies.description")}
      </p>
      {reassign && scope && <div className="mb-3">{scope}</div>}
      {reassign && capture.captureId && (
        <LikelySpecies
          captureId={capture.captureId}
          onSelect={(s) => {
            onReassign(s);
            onClose();
          }}
        />
      )}
      <SpeciesPicker
        autoFocus
        inline
        placeholder={t("captureEdit.searchSpecies")}
        onSelect={(s) => {
          if (reassign) onReassign(s);
          else onTagSpecies?.(s.id);
          onClose();
        }}
      />
    </Modal>
  );
}

// The photo's next-best matches, from the vector stored at import. Nothing shows without one.
function LikelySpecies({ captureId, onSelect }: { captureId: string; onSelect: (s: SpeciesResult) => void }) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [suggestions, setSuggestions] = useState<SuggestedSpecies[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api
      .get(apiPath("/captures/{id}/suggestions", { id: captureId }), { signal: controller.signal })
      .then((res) => setSuggestions(res.suggestions))
      // Optional: the search below still works.
      .catch(ignore("Couldn't load species suggestions"));
    return () => controller.abort();
  }, [captureId]);
  if (suggestions.length === 0) return null;
  return (
    <div className="mb-3">
      <p className="mb-1 text-footnote font-medium text-muted">{t("captureEdit.couldAlsoBe")}</p>
      {suggestions[0].probably && (
        <p className="mb-1 text-footnote text-muted wrap-anywhere">
          <ProbableGroupText group={suggestions[0].probably} />
        </p>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line">
        {suggestions.map((s) => (
          <li key={s.id}>
            {/* raw-control: a row of the suggestion list. */}
            <button
              type="button"
              onClick={() => onSelect(s)}
              className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-callout hover:bg-surface-muted focus-visible:outline-offset-[-2px]"
            >
              <span className="truncate text-ink">
                {speciesName({ commonName: s.common_name, scientificName: s.scientific_name })}
              </span>
              {s.matchPercent != null && (
                <span className="shrink-0 text-footnote text-muted">
                  {t("species.suggestion.match", { percent: formatPercent(s.matchPercent / 100) })}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
