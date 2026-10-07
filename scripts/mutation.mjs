#!/usr/bin/env node
// Mutation testing (StrykerJS) for the modules where a weak test would hurt most: path and
// ownership checks, license decisions, migrations, anything that moves or deletes files. Runs each
// workspace's stryker.config.mjs, then its stryker.integration.config.mjs when TEST_DATABASE_URL is
// set, and prints the mutation score per file. Reports land in reports/mutation/.
//
//   npm run test:mutation                 every package
//   npm run test:mutation -- core api     only these (core, api, data-pipeline)
//   npm run test:mutation -- --unit       skip the integration-backed configs
//
// The integration configs write to TEST_DATABASE_URL, so it must be a scratch database.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = [
  { name: "core", dir: "packages/core" },
  { name: "api", dir: "apps/api" },
  { name: "data-pipeline", dir: "packages/data-pipeline" },
];

const args = process.argv.slice(2);
const unitOnly = args.includes("--unit");
const only = args.filter((a) => !a.startsWith("--"));
const unknown = only.filter((n) => !PACKAGES.some((p) => p.name === n));
if (unknown.length > 0) {
  console.error(`Unknown package: ${unknown.join(", ")}. Choose from ${PACKAGES.map((p) => p.name).join(", ")}.`);
  process.exit(2);
}
const selected = PACKAGES.filter((p) => only.length === 0 || only.includes(p.name));

const testDb = process.env.TEST_DATABASE_URL;
if (!unitOnly && !testDb) {
  console.log("TEST_DATABASE_URL isn't set, so the integration-backed configs are skipped.\n");
}

const runs = [];
for (const pkg of selected) {
  runs.push({ pkg, config: "stryker.config.mjs", report: pkg.name, env: { TEST_DATABASE_URL: "" } });
  if (!unitOnly && testDb && existsSync(join(root, pkg.dir, "stryker.integration.config.mjs"))) {
    // Point DATABASE_URL at the scratch database too, so nothing falls back to the default one.
    const env = { TEST_DATABASE_URL: testDb, DATABASE_URL: testDb };
    runs.push({ pkg, config: "stryker.integration.config.mjs", report: `${pkg.name}-integration`, env });
  }
}

const started = Date.now();
let failed = false;
const rows = [];
for (const run of runs) {
  console.log(`\nStryker: ${run.pkg.dir}/${run.config}`);
  const res = spawnSync("npx", ["stryker", "run", run.config], {
    cwd: join(root, run.pkg.dir),
    stdio: "inherit",
    env: { ...process.env, ...run.env },
  });
  if (res.status !== 0) {
    failed = true;
    continue;
  }
  rows.push(...scores(join(root, "reports", "mutation", `${run.report}.json`), run.pkg.dir));
}

if (rows.length > 0) {
  console.log("\nMutation score per file (killed + timeout) / (all mutants that ran):");
  const width = Math.max(...rows.map((r) => r.file.length));
  for (const r of rows) {
    const score = r.total === 0 ? "n/a" : `${((100 * r.detected) / r.total).toFixed(1)}%`;
    console.log(
      `  ${r.file.padEnd(width)}  ${score.padStart(6)}  (${r.detected}/${r.total}, ${r.survived} survived, ${r.noCoverage} no coverage)`,
    );
  }
}
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\nDone in ${seconds}s. HTML reports are in reports/mutation/.`);

if (process.env.GITHUB_STEP_SUMMARY && rows.length > 0) {
  const md = rows.map((r) => {
    const score = r.total === 0 ? "n/a" : `${((100 * r.detected) / r.total).toFixed(1)}%`;
    return `| ${r.file} | ${score} | ${r.survived} | ${r.noCoverage} |`;
  });
  const table = ["| File | Score | Survived | No coverage |", "| --- | --- | --- | --- |", ...md].join("\n");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Mutation score\n\n${table}\n\nRan in ${seconds}s. The HTML reports are in this run's mutation-report artifact.\n`,
  );
}
process.exit(failed ? 1 : 0);

function scores(reportPath, pkgDir) {
  if (!existsSync(reportPath)) return [];
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return Object.entries(report.files).map(([file, { mutants }]) => {
    const count = (...statuses) => mutants.filter((m) => statuses.includes(m.status)).length;
    const detected = count("Killed", "Timeout");
    const survived = count("Survived");
    const noCoverage = count("NoCoverage");
    return { file: `${pkgDir}/${file}`, detected, survived, noCoverage, total: detected + survived + noCoverage };
  });
}
