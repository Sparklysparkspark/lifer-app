import { useRef, useState } from "react";
import type { EbirdImportSummary } from "@lifer/shared";
import { api } from "../../api/client";
import { errorMessage } from "../../lib/errorMessage";
import { buttonClasses } from "../../lib/buttonClasses";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import { SettingRow } from "./shared";

// Species already photographed are never downgraded to seen.
export default function EbirdImportRow() {
  const [summary, setSummary] = useState<EbirdImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setSummary(null);
    setImporting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await api.post("/imports/ebird-csv", form);
      setSummary(result);
    } catch (err) {
      setError(errorMessage(err, "Import failed"));
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <SettingRow
      label="Import from eBird"
      description={
        <>
          Marks species in your eBird data as seen. Use MyEBirdData.csv from eBird's{" "}
          <a href="https://ebird.org/downloadMyData" target="_blank" rel="noreferrer" className="underline">
            Download My Data
          </a>
          .
        </>
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
            {importing ? "Importing…" : "Choose file"}
          </label>
        </>
      }
    >
      {(error || summary) && (
        <>
          <FormMessage error={error} />
          {summary && (
            <p className="text-xs text-muted">
              {summary.uniqueSpecies} species in the file: {summary.matched - summary.alreadySeenOrCollected} newly
              seen, {summary.alreadySeenOrCollected} already seen or collected, {summary.unmatched} not matched.
            </p>
          )}
        </>
      )}
    </SettingRow>
  );
}
