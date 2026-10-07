#!/usr/bin/env node
// Fails when a migration file is misnamed or two share a number. Migrations run in filename
// order and are tracked by filename (packages/data-pipeline/src/migrate.ts), so a duplicate
// number makes the order ambiguous and a rename re-runs a migration. See the database
// migrations page in the contributor docs.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "data-pipeline", "migrations");
const NAME = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const errors = [];
const byNumber = new Map();
for (const file of readdirSync(dir).sort()) {
  const match = NAME.exec(file);
  if (!match) {
    errors.push(`${file}: expected NNN_snake_case_description.sql`);
    continue;
  }
  byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), file]);
}
for (const [number, files] of byNumber) {
  if (files.length > 1) errors.push(`${number} is used by ${files.join(", ")}: renumber the newer one`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const latest = [...byNumber.keys()].sort().at(-1);
console.log(`${byNumber.size} migrations OK. The next one is ${String(Number(latest) + 1).padStart(3, "0")}.`);
