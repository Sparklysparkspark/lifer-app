// Captures the site's app screenshots (static/img/<name>.jpg and <name>-dark.jpg) from the running
// desktop app. Start the dev app, then from docs/: node scripts/capture-screenshots.mjs [name ...]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const APP = "http://localhost:4310";
const OUT = fileURLToPath(new URL("../static/img/", import.meta.url));

// The desktop shell passes a per-launch token to its backend; read it from that process.
let pid = "";
try {
  pid = execFileSync("lsof", ["-tiTCP:4310", "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
} catch {
  throw new Error("Lifer isn't running: start the desktop app first.");
}
const token = execFileSync("ps", ["eww", "-o", "command=", "-p", pid], { encoding: "utf8" }).match(
  /LIFER_LAUNCH_TOKEN=(\S+)/,
)?.[1];
if (!token) throw new Error("Lifer isn't running: start the desktop app first.");

const BELIZE = "/?region=90e9899d-3af8-469f-8d51-fbda1c2cb3a3";
const search = async (page, text) => {
  await page
    .getByPlaceholder(/^Search/)
    .first()
    .fill(text);
  await page.keyboard.press("Enter");
};

// Flips one View menu checkbox and closes the menu.
const toggleView = async (page, label) => {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByLabel(label).click();
  await page.keyboard.press("Escape");
};

// Each shot opens a page, then clicks through like a person. "after" puts back anything it toggled.
const shots = [
  {
    name: "collection",
    path: BELIZE,
    act: async (page) => {
      await page.getByRole("button", { name: "Hide map" }).click();
      await toggleView(page, "Show progress by group");
    },
    after: async (page) => {
      await page.getByRole("button", { name: "Show map" }).click();
      await toggleView(page, "Show progress by group");
    },
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
  // Species ID during an import: needs a photo not in the library yet, IDENTIFY_PHOTO=<path>.
  // Nothing is imported; the page closes before Import, and abandoned uploads are swept.
  {
    name: "identify",
    path: "/import",
    // The browser's file picker (the desktop shell opens its own); Compare covers the layout anyway.
    web: true,
    skip: !process.env.IDENTIFY_PHOTO && "set IDENTIFY_PHOTO to a photo not in the library",
    act: async (page) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Choose files" }).click();
      await (await chooser).setFiles(process.env.IDENTIFY_PHOTO);
      await page.getByText("% match").first().waitFor({ timeout: 60000 });
      await page.getByText("Compare", { exact: true }).first().click();
    },
  },
  { name: "inaturalist", path: "/inaturalist" },
  { name: "stats", path: "/stats" },
  // Just the scatter chart's card; it sits further down the page.
  {
    name: "stats-scatter",
    path: "/stats",
    element: (page) =>
      page.getByText("Your photo distribution").locator("xpath=ancestor::*[contains(@class,'rounded')][1]"),
  },
  { name: "trip", path: "/trips", act: (page) => page.getByText("Belize 2026").first().click() },
  { name: "gallery", path: "/gallery", act: (page) => search(page, "bird in flight against blue sky") },
  {
    name: "metadata",
    path: "/settings/metadata",
    // Example templates typed in to fill the preview; never saved, the page closes without Save.
    act: async (page) => {
      await page
        .getByPlaceholder("Optional, for example a photo of a species")
        .fill("{species} ({scientific}), {longdate}. {camera}, {focal}");
      await page.getByPlaceholder("Optional, for example wildlife, birding").fill("wildlife, {family}, {trip}");
      await page.getByRole("heading", { name: "Titles, captions and keywords" }).click();
    },
    // From the caption field down to the preview.
    clip: async (page) => {
      const top = await page.getByText("Description or caption", { exact: true }).first().boundingBox();
      const end = await page.getByRole("button", { name: "Try another photo" }).boundingBox();
      const preview = await page.getByText("Extra keywords", { exact: true }).last().boundingBox();
      const panel = await page
        .getByRole("heading", { name: "Titles, captions and keywords" })
        .locator("xpath=following-sibling::*[1]")
        .boundingBox();
      const y = top.y - 24;
      return {
        x: panel.x,
        y,
        width: panel.width,
        height: Math.max(end.y + end.height, preview.y + preview.height) + 12 - y,
      };
    },
  },
  { name: "tree-circle", path: "/explore", act: (page) => page.getByRole("button", { name: "Circle" }).click() },
  // A species page from its About section down: the field-guide paragraph, then your photos.
  {
    name: "species-about",
    path: "/species/bb873dc2-084b-45a3-8c88-68e97a78d254", // Osprey, 17 photos from the Belize trip
    act: (page) => page.getByRole("button", { name: /^All \(/ }).click(),
    // From the About card down, without the empty strip beside it.
    clip: async (page) => {
      const card = await page
        .getByRole("button", { name: /About$/ })
        .first()
        .locator("xpath=ancestor::*[contains(@class,'rounded')][1]")
        .boundingBox();
      return { x: card.x - 24, y: card.y - 24, width: card.width + 48, height: 800 };
    },
  },
  { name: "offline-packs", path: "/settings/regions" },
];

// Notices about this machine's drives, tips and account names, not part of what the page shows.
// "own" hides just the line; otherwise its banner goes too.
const NOTICES = [
  { text: /isn't connected/ },
  { text: /Each counts as one photo/ },
  { text: /^Connected as/, own: true },
];
// Folder paths name the user's own drives and folders; keep only the last two folders.
const hidePaths = (page) =>
  page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      n.nodeValue = n.nodeValue.replace(/(?:\/Volumes|\/Users|[A-Z]:\\)[^·\n]*/g, (p) => {
        const parts = p.trim().split(/[\\/]/).filter(Boolean);
        return `~/Pictures/${parts.slice(-2).join("/")} `;
      });
    }
  });

const hideNotices = (page) =>
  page.evaluate(
    (notices) => {
      for (const { source, own } of notices) {
        const hit = (e) => new RegExp(source).test(e.textContent?.trim() ?? "");
        for (const el of document.querySelectorAll("p, span, div")) {
          // The innermost element holding the whole notice, which may contain links.
          if (!hit(el) || [...el.children].some(hit)) continue;
          const box = own ? el : (el.closest('[role="status"], [role="note"], [role="alert"]') ?? el.parentElement);
          box.style.display = "none";
        }
      }
    },
    NOTICES.map((n) => ({ source: n.text.source, own: !!n.own })),
  );

const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const s of shots.filter((s) => !only.length || only.includes(s.name))) {
  if (s.skip) {
    console.log(`skipped ${s.name}: ${s.skip}`);
    continue;
  }
  for (const scheme of ["light", "dark"]) {
    // 1280 x 800 at 1.25x makes the 1600 x 1000 images the landing page expects.
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1.25,
      colorScheme: scheme,
      extraHTTPHeaders: { "x-lifer-launch-token": token },
    });
    // A stand-in desktop shell, so pages draw the desktop app's sidebar layout rather than the
    // web version's top bar. Every desktop-only call answers nothing, except the installed apps
    // list: an empty one, so the sidebar shows the suggested apps a new install does.
    if (!s.web)
      await ctx.addInitScript(() => {
        window.__TAURI__ = { core: { invoke: async (cmd) => (cmd === "plugins_list" ? [] : null) } };
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
    await hidePaths(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const file = `${OUT}${s.name}${scheme === "dark" ? "-dark" : ""}.jpg`;
    if (s.clip)
      await page.screenshot({ path: file, type: "jpeg", quality: 82, clip: await s.clip(page), fullPage: true });
    else if (s.element) await s.element(page).screenshot({ path: file, type: "jpeg", quality: 82 });
    else await page.screenshot({ path: file, type: "jpeg", quality: 82 });
    console.log(file);
    await s.after?.(page);
    await ctx.close();
  }
}
await browser.close();
