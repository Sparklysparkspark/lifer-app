// `npm run screens -- --pages=gallery,collection --seeds=extreme --widths=390`
// Output goes to screens/<date>/, not test-results/, which every other Playwright run wipes. Runs the harness, then writes index.html beside the shots. Nothing else about a run is configurable.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PAGES, SEEDS } from "./pages.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = ""] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const dir = path.resolve("screens", new Date().toISOString().slice(0, 10));
mkdirSync(dir, { recursive: true });

const env = {
  ...process.env,
  SCREENS_DIR: dir,
  SCREENS_PAGES: args.pages ?? "",
  SCREENS_SEEDS: args.seeds ?? "",
  SCREENS_WIDTHS: args.widths ?? "",
};
const run = spawnSync("npx", ["playwright", "test", "-c", "e2e/playwright.screens.config.ts"], {
  env,
  stdio: "inherit",
});

// Built from what's on disk, so a partial run still indexes everything already there.
const shots = SEEDS.flatMap((seed) => {
  try {
    return readdirSync(path.join(dir, seed))
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ seed, file: f }));
  } catch {
    return [];
  }
});
const order = Object.keys(PAGES);
const pageOf = (f: string) => f.replace(/-(light|dark)-\d+\.png$/, "");
shots.sort(
  (a, b) =>
    SEEDS.indexOf(a.seed) - SEEDS.indexOf(b.seed) ||
    order.indexOf(pageOf(a.file)) - order.indexOf(pageOf(b.file)) ||
    a.file.localeCompare(b.file),
);
const body = shots
  .map(
    ({ seed, file }) =>
      `<figure><figcaption>${seed} / ${file.replace(".png", "")}</figcaption><a href="${seed}/${file}"><img loading="lazy" src="${seed}/${file}"></a></figure>`,
  )
  .join("\n");
writeFileSync(
  path.join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Lifer screens</title><style>body{font:14px system-ui;margin:16px}figure{display:inline-block;margin:0 12px 24px 0;vertical-align:top}img{max-width:420px;max-height:420px;border:1px solid #888}figcaption{font-weight:600;margin-bottom:4px}</style><h1>Lifer screens (${shots.length})</h1>\n${body}\n`,
);
console.log(`Screens: ${dir}\nIndex: ${path.join(dir, "index.html")}`);
process.exit(run.status ?? 1);
