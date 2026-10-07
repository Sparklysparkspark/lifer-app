#!/usr/bin/env node
// Prints the line, branch and function coverage of each workspace from the json-summary that
// `npm run test:coverage` writes, and adds the same table to the GitHub Actions job summary.
// Report only: it never fails on a low number.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["packages/core", "apps/api", "packages/data-pipeline"];

const rows = [];
for (const pkg of PACKAGES) {
  const file = join(root, pkg, "coverage", "coverage-summary.json");
  if (!existsSync(file)) {
    rows.push([pkg, "no report", "", "", ""]);
    continue;
  }
  const { total } = JSON.parse(readFileSync(file, "utf8"));
  rows.push([pkg, ...["lines", "statements", "branches", "functions"].map((k) => `${total[k].pct}%`)]);
}

const header = ["Package", "Lines", "Statements", "Branches", "Functions"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(["", line(header), ...rows.map(line), ""].join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = (cells) => `| ${cells.join(" | ")} |`;
  const table = [md(header), md(header.map(() => "---")), ...rows.map(md)].join("\n");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Test coverage\n\n${table}\n\nThe HTML reports are in this run's coverage artifact.\n`,
  );
}
