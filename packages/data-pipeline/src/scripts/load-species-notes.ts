// Loads the offline-written field-guide notes (see pipeline/speciesNotes.ts) into
// species.habitat_notes, species.identification_notes and species.summary_notes. Safe to rerun:
// unchanged rows are skipped.
//
// Usage: npm run load-species-notes -w data-pipeline -- [--habitat=FILE] [--identification=FILE]
//   [--summary=FILE] [--dry-run]
//   Defaults read data/habitat-notes-cache/final/habitat_notes.json, identification_notes.json and
//   summary_notes.json; a missing file is skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { loadNotes, type NotesColumn, type NotesInput } from "../pipeline/speciesNotes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const finalDir = path.resolve(here, "../../data/habitat-notes-cache/final");

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const files: [NotesColumn, string][] = [
    ["habitat_notes", arg("habitat") ?? path.join(finalDir, "habitat_notes.json")],
    ["identification_notes", arg("identification") ?? path.join(finalDir, "identification_notes.json")],
    ["summary_notes", arg("summary") ?? path.join(finalDir, "summary_notes.json")],
  ];
  for (const [column, file] of files) {
    if (!fs.existsSync(file)) {
      console.log(`[load-species-notes] ${column}: no ${file}, skipped`);
      continue;
    }
    const notes = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, NotesInput>;
    const r = await loadNotes(pool, column, notes, { dryRun });
    console.log(
      `[load-species-notes] ${dryRun ? "dry run: " : ""}${column}: ${r.read} read, ${r.written} written, ` +
        `${r.unknownSpecies} not in the species table, ${r.empty} with nothing usable`,
    );
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
