// Captures the site's app screenshots (static/img/<name>.jpg and <name>-dark.jpg) from the running
// desktop app. Start the dev app, then from docs/: node scripts/capture-screenshots.mjs [name ...]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const APP = "http://localhost:4310";
const OUT = fileURLToPath(new URL("../static/img/", import.meta.url));

// The desktop shell passes a per-launch token to its backend; read it from that process.
const pid = execFileSync("lsof", ["-tiTCP:4310", "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
const token = execFileSync("ps", ["eww", "-o", "command=", "-p", pid], { encoding: "utf8" }).match(
  /LIFER_LAUNCH_TOKEN=(\S+)/,
)?.[1];
if (!token) throw new Error("Lifer isn't running: start the desktop app first.");

const BELIZE = "/?region=90e9899d-3af8-469f-8d51-fbda1c2cb3a3";
const search = async (page, text) => {
  await page.getByPlaceholder(/^Search/).first().fill(text);
  await page.keyboard.press("Enter");
};

// Each shot opens a page, then clicks through like a person. "after" puts back anything it toggled.
const shots = [
  {
    name: "collection",
    path: BELIZE,
    act: (page) => page.getByRole("button", { name: "Hide map" }).click(),
    after: (page) => page.getByRole("button", { name: "Show map" }).click(),
  },
  {
    name: "species-detail",
    path: BELIZE,
    act: async (page) => {
      await search(page, "kingfisher");
      await page.waitForTimeout(1500);
      await page.locator('a[href*="/species/"]').first().click();
    },
  },
  {
    name: "map",
    path: "/gallery?view=map",
    act: (page) => page.getByText("Belize", { exact: true }).last().click(),
  },
  {
    name: "photo-viewer",
    path: "/gallery",
    act: async (page) => {
      await search(page, "kingfisher");
      await page.waitForTimeout(1500);
      await page.locator("main img").nth(1).click();
    },
  },
  { name: "stats", path: "/stats" },
  { name: "gallery", path: "/gallery", act: (page) => search(page, "kingfisher") },
  { name: "tree-circle", path: "/explore", act: (page) => page.getByRole("button", { name: "Circle" }).click() },
];

// Notices about this machine's drives and tips, not part of what the page shows.
const NOTICES = [/isn't connected/, /Each counts as one photo/];
const hideNotices = (page) =>
  page.evaluate((sources) => {
    const res = sources.map((s) => new RegExp(s));
    for (const el of document.querySelectorAll("p, span, div")) {
      if (el.children.length || !res.some((r) => r.test(el.textContent ?? ""))) continue;
      const box = el.closest('[role="status"], [role="note"], [role="alert"]') ?? el.parentElement;
      box.style.display = "none";
    }
  }, NOTICES.map((r) => r.source));

const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const s of shots.filter((s) => !only.length || only.includes(s.name))) {
  for (const scheme of ["light", "dark"]) {
    // 1280 x 800 at 1.25x makes the 1600 x 1000 images the landing page expects.
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1.25,
      colorScheme: scheme,
      extraHTTPHeaders: { "x-lifer-launch-token": token },
    });
    await ctx.addInitScript((kv) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, JSON.stringify(v));
    }, s.storage ?? {});
    const page = await ctx.newPage();
    await page.goto(APP + s.path, { waitUntil: "networkidle" });
    await s.act?.(page);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2500);
    await hideNotices(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const file = `${OUT}${s.name}${scheme === "dark" ? "-dark" : ""}.jpg`;
    await page.screenshot({ path: file, type: "jpeg", quality: 82 });
    console.log(file);
    await s.after?.(page);
    await ctx.close();
  }
}
await browser.close();
