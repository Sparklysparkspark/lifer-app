import { useRef, useState } from "react";
import type { EbirdImportSummary } from "@lifer/shared";
import { api } from "../api/client";
import { docsUrl } from "../lib/docs";
import { errorMessage } from "../lib/errorMessage";
import { buttonClasses } from "../lib/buttonClasses";
import FormMessage from "./FormMessage";
import InlineSpinner from "./InlineSpinner";

export default function EbirdImport({ onImported }: { onImported: () => void }) {
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
      const result = await api.post<EbirdImportSummary>("/imports/ebird-csv", form);
      setSummary(result);
      onImported();
    } catch (err) {
      setError(errorMessage(err, "Import failed"));
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Import eBird checklist data</h2>
        <a
          href={docsUrl("/settings#ebird")}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-muted underline hover:text-ink"
        >
          Learn more
        </a>
      </div>
      <p className="mt-1 text-xs text-muted">
        Export "MyEBirdData.csv" from eBird's{" "}
        <a href="https://ebird.org/downloadMyData" target="_blank" rel="noreferrer" className="underline">
          Download My Data
        </a>{" "}
        page. Species you've seen but haven't photographed will show as <em>seen</em> instead of <em>unseen</em>.
        Already-photographed species are never downgraded.
      </p>
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
          `mt-4 cursor-pointer ${importing ? "pointer-events-none opacity-50" : ""}`,
        )}
      >
        {importing && <InlineSpinner />}
        {importing ? "Importing…" : "Choose CSV file…"}
      </label>
      <FormMessage error={error} className="mt-3" />
      {summary && (
        <p className="mt-3 text-xs text-muted">
          {summary.uniqueSpecies} species in file · {summary.matched} matched · newly seen:{" "}
          {summary.matched - summary.alreadySeenOrCollected} · already seen/collected: {summary.alreadySeenOrCollected}{" "}
          · unmatched: {summary.unmatched}
        </p>
      )}
    </section>
  );
}
