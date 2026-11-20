import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import type { EbirdImportSummary } from "@lifer/shared";
import { api } from "../../api/client";
import { errorMessage } from "../../lib/errorMessage";
import { buttonClasses } from "../../lib/buttonClasses";
import { formatList } from "../../lib/format";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import { SettingRow } from "./shared";

// Species already photographed are never downgraded to seen.
export default function EbirdImportRow() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<EbirdImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoneCount, setUndoneCount] = useState<number | null>(null);
  const [checklists, setChecklists] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();

  // The add-species dialog links here with #ebird-import; the row sits low on the page.
  useEffect(() => {
    if (hash === "#ebird-import") rowRef.current?.scrollIntoView({ block: "center" });
  }, [hash]);

  async function handleFile(file: File) {
    setError(null);
    setSummary(null);
    setUndoneCount(null);
    setChecklists(null);
    setImporting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await api.post("/imports/ebird-csv", form);
      setSummary(result);
      // The same file also holds the user's checklists, kept to match photos to trips.
      const again = new FormData();
      again.append("file", file);
      const lists = await api.post("/ebird/import", again).catch(() => null);
      setChecklists(lists?.checklists ?? null);
    } catch (err) {
      setError(errorMessage(err, t("settings.ebirdImport.failed")));
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // Takes back only the species this import newly marked seen.
  async function undoImport() {
    if (!summary) return;
    setError(null);
    setUndoing(true);
    try {
      const result = await api.post("/imports/ebird-csv/undo", { speciesIds: summary.addedSpeciesIds });
      setSummary(null);
      setUndoneCount(result.removed);
    } catch (err) {
      setError(errorMessage(err, t("settings.ebirdImport.undoFailed")));
    } finally {
      setUndoing(false);
    }
  }

  return (
    <div id="ebird-import" ref={rowRef}>
      <SettingRow
        label={t("settings.ebirdImport.label")}
        description={
          <Trans
            i18nKey="settings.ebirdImport.description"
            components={{
              a: (
                // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
                <a href="https://ebird.org/downloadMyData" target="_blank" rel="noreferrer" className="underline" />
              ),
            }}
          />
        }
        control={
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              id="ebird-csv-input"
              disabled={importing}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <label
              htmlFor="ebird-csv-input"
              aria-disabled={importing || undefined}
              className={buttonClasses(
                "secondary",
                "sm",
                `cursor-pointer ${importing ? "pointer-events-none opacity-50" : ""}`,
              )}
            >
              {importing && <InlineSpinner />}
              {importing ? t("settings.ebirdImport.importing") : t("settings.ebirdImport.chooseFile")}
            </label>
          </>
        }
      >
        {(error || summary || undoneCount !== null) && (
          <>
            <FormMessage error={error} />
            {summary && (
              <>
                <p className="text-footnote text-muted">
                  {t("settings.ebirdImport.summary", {
                    total: summary.uniqueSpecies,
                    added: summary.addedSpeciesIds.length,
                    already: summary.alreadySeenOrCollected,
                    unmatched: summary.unmatched,
                  })}
                </p>
                {summary.unmatchedNames.length > 0 && (
                  <p className="text-footnote text-muted">
                    <Trans
                      i18nKey="settings.ebirdImport.notMatched"
                      values={{ names: formatList(summary.unmatchedNames, "unit") }}
                      components={{ names: <span className="italic" /> }}
                    />
                  </p>
                )}
                {checklists !== null && checklists > 0 && (
                  <p className="text-footnote text-muted">
                    {t("settings.ebirdImport.checklists", { count: checklists })}
                  </p>
                )}
                {summary.addedSpeciesIds.length > 0 && (
                  <Button variant="secondary" size="sm" onClick={() => void undoImport()} loading={undoing}>
                    {t("settings.ebirdImport.undo")}
                  </Button>
                )}
              </>
            )}
            {undoneCount !== null && (
              <p className="text-footnote text-muted">{t("settings.ebirdImport.undone", { count: undoneCount })}</p>
            )}
          </>
        )}
      </SettingRow>
    </div>
  );
}
