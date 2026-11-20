// Every row in the remembered-state inventory names a test; this fails if a named file is gone,
// so a renamed or deleted test can't leave a row unproven.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DOC = "docs/docs/contributing/remembered-state.md";
const files = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .map((f) => f.split("/").pop()),
);

const missing = [];
let rows = 0;
for (const line of readFileSync(DOC, "utf8").split("\n")) {
  const cells = line.split("|").slice(1, -1);
  if (cells.length < 4 || /^[\s-]+$/.test(cells[0]) || cells[0].trim() === "Remembered") continue;
  rows++;
  const named = [...cells.at(-1).matchAll(/`([^`]+\.(?:tsx?|rs|mjs))`/g)].map((m) => m[1]);
  if (named.length === 0) missing.push(`${cells[0].trim()}: no test named`);
  for (const name of named) if (!files.has(name)) missing.push(`${cells[0].trim()}: ${name} not found`);
}

if (rows === 0) missing.push(`no rows read from ${DOC}`);
if (missing.length) {
  console.error(`${DOC}:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`remembered-state: ${rows} rows, every named test exists`);
