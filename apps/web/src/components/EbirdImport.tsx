import { useRef, useState } from "react";
import type { EbirdImportSummary } from "@lifer/shared";
import { api, ApiError } from "../api/client";

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
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="text-sm font-medium text-stone-700">Import eBird checklist data</h2>
      <p className="mt-1 text-xs text-stone-500">
        Export "MyEBirdData.csv" from eBird's{" "}
        <a href="https://ebird.org/downloadMyData" target="_blank" rel="noreferrer" className="underline">
          Download My Data
        </a>{" "}
        page — species you've seen but haven't photographed will show as <em>seen</em> instead of{" "}
        <em>unseen</em>. Already-photographed species are never downgraded.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        id="ebird-csv-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <label
        htmlFor="ebird-csv-input"
        className="mt-2 inline-block cursor-pointer text-sm text-stone-600 hover:underline"
      >
        {importing ? "Importing…" : "Choose CSV file…"}
      </label>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {summary && (
        <p className="mt-2 text-xs text-stone-500">
          {summary.uniqueSpecies} species in file · {summary.matched} matched · newly seen:{" "}
          {summary.matched - summary.alreadySeenOrCollected} · already seen/collected: {summary.alreadySeenOrCollected}{" "}
          · unmatched: {summary.unmatched}
        </p>
      )}
    </div>
  );
}
