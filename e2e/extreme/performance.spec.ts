// Speed and no-flash budgets on the extreme seed (ux-rules P1, P2, P3, P5, P6): click to the page's
// ready marker (lib/readyMarker.ts) for page switches, species open and Back, click to a decoded
// photo in the lightbox, blank or black frames while those open, and long tasks while scrolling.
// Budgets and the per-OS baseline live in e2e/perf-baseline.json. A median over failFactor times the
// budget fails (1: at budget); a 20% drift from this OS's baseline warns. Known misses are listed in
// e2e/known-failures.json.
// PERF_RECORD=1 writes this run's numbers as the baseline for this OS.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import sharp from "sharp";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, SEED_COLLECTION, seedExtreme } from "../support/extremeLibrary.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { HEADERS } from "../support/library.js";

type Kind = "navigation" | "photo" | "longTask";
interface Sample {
  median: number;
  min: number;
  max: number;
}
interface PerfFile {
  budgets: Record<Kind, number>;
  failFactor: number;
  baseline: Record<string, Record<string, Sample>>;
}

const FILE = fileURLToPath(new URL("../perf-baseline.json", import.meta.url));
const perf = JSON.parse(readFileSync(FILE, "utf8")) as PerfFile;
const RUNS = 5;
const results: Record<string, Sample> = {};

test.beforeAll(async () => {
  test.skip(test.info().project.name !== "extreme", "budgets are measured on the extreme seed only");
  // Shared runners are several times slower than the baseline machine; only the perf job records them.
  test.skip(
    !!process.env.CI && !process.env.PERF_RECORD,
    "speed budgets gate locally, CI records them in the perf job",
  );
  test.setTimeout(300_000);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    await seedExtreme(db);
  } finally {
    await db.end();
  }
});

test.beforeEach(async ({ page }, info) => {
  markKnownFailure(info);
  const res = await page.context().request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT });
  expect(res.ok()).toBe(true);
});

test.afterAll(() => {
  const keys = Object.keys(results);
  if (!keys.length) return;
  const rows = keys.map(
    (k) => `${k.padEnd(44)} ${String(results[k].median).padStart(6)} ${results[k].min}-${results[k].max}`,
  );
  console.log(`\nPerformance on ${process.platform} (ms: median, min-max over ${RUNS} runs)\n${rows.join("\n")}`);
  if (process.env.PERF_RECORD) {
    perf.baseline[process.platform] = { ...perf.baseline[process.platform], ...results };
    writeFileSync(FILE, `${JSON.stringify(perf, null, 2)}\n`);
  }
});

function warn(message: string): void {
  test.info().annotations.push({ type: "warning", description: message });
  console.warn(message);
}

/** Fails on a regression past failFactor times the budget; anything over budget only warns. */
function check(key: string, kind: Kind, values: number[]): void {
  const sorted = [...values].sort((a, b) => a - b);
  const sample = {
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
  results[key] = sample;
  const budget = perf.budgets[kind];
  const previous = perf.baseline[process.platform]?.[key];
  if (previous && Math.abs(sample.median - previous.median) > previous.median * 0.2) {
    warn(`${key}: median ${sample.median} ms is over 20% from the baseline's ${previous.median} ms`);
  }
  if (sample.median > budget) warn(`${key}: median ${sample.median} ms is over the ${budget} ms budget`);
  // Soft, so every measurement in the test is still taken and reported.
  expect.soft(sample.median, `${key} median (budget ${budget} ms)`).toBeLessThanOrEqual(budget * perf.failFactor);
}

/** For things that must never happen (a blank frame, a spinner on Back). */
function checkNone(key: string, count: number): void {
  if (count) console.warn(`${key}: ${count}`);
  expect.soft(count, key).toBe(0);
}

interface Timing {
  ms: number;
  spinnerFrames: number;
}

/** Click (or Back) to done, timed in the page: from the pointerdown, or from history.back(), to the
 *  first frame where the new path's ready marker is set or the lightbox photo has decoded. */
async function timed(page: Page, done: "ready" | "photo", act: "back" | (() => Promise<void>)): Promise<Timing> {
  await page.evaluate(
    ({ done, back }) => {
      const startPath = location.pathname;
      const state = { t0: 0, t1: 0, spinnerFrames: 0 };
      (window as unknown as { __perf: typeof state }).__perf = state;
      const isDone = () => {
        if (done === "ready") {
          return location.pathname !== startPath && document.documentElement.dataset.ready === location.pathname;
        }
        const img = document.querySelector<HTMLImageElement>('[role="dialog"] img');
        return !!img && img.complete && img.naturalWidth > 0;
      };
      const tick = () => {
        if (state.t0) {
          if (document.querySelector(".animate-spin")) state.spinnerFrames++;
          if (isDone()) {
            state.t1 = performance.now();
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      if (back) {
        state.t0 = performance.now();
        history.back();
      } else {
        addEventListener("pointerdown", (e) => (state.t0 = e.timeStamp), { capture: true, once: true });
      }
    },
    { done, back: act === "back" },
  );
  if (act !== "back") await act();
  await page.waitForFunction(() => (window as unknown as { __perf: { t1: number } }).__perf.t1 > 0, null, {
    timeout: 30_000,
  });
  const result = await page.evaluate(() => {
    const state = (window as unknown as { __perf: { t0: number; t1: number; spinnerFrames: number } }).__perf;
    return { ms: state.t1 - state.t0, spinnerFrames: state.spinnerFrames };
  });
  // Lets images and late requests finish so the next run starts from a settled page.
  await page.waitForTimeout(300);
  return result;
}

/** Records every painted frame while `act` runs and counts the mostly black or blank ones. */
async function blankFrames(page: Page, act: () => Promise<unknown>): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Buffer[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    frames.push(Buffer.from(frame.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 640, maxHeight: 400 });
  await act();
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  let blank = 0;
  for (const jpeg of frames) {
    const pixels = await sharp(jpeg).greyscale().resize(64, 40, { fit: "fill" }).raw().toBuffer();
    let dark = 0;
    let sum = 0;
    let squares = 0;
    for (const v of pixels) {
      if (v < 40) dark++;
      sum += v;
      squares += v * v;
    }
    const mean = sum / pixels.length;
    const spread = Math.sqrt(Math.max(0, squares / pixels.length - mean * mean));
    // Mostly black (the lightbox backdrop with no photo yet), or one flat colour (an empty page).
    if (dark / pixels.length > 0.92 || spread < 4) {
      blank++;
      await test.info().attach(`blank frame ${blank}`, { body: jpeg, contentType: "image/jpeg" });
    }
  }
  return blank;
}

const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true });

async function openReady(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(
    (path) => document.documentElement.dataset.ready === path,
    new URL(url, "http://x").pathname,
    {
      timeout: 60_000,
    },
  );
  await page.waitForLoadState("networkidle");
}

const counted = (timings: Timing[]) => timings.slice(1).map((t) => t.ms);

for (const [name, route] of [
  ["Gallery", "/gallery"],
  ["Albums", "/albums"],
  ["Stats", "/stats"],
] as const) {
  test(`switching between Collection and ${name}`, async ({ page }) => {
    await openReady(page, SEED_COLLECTION);
    const there: Timing[] = [];
    const back: Timing[] = [];
    // The first round trip loads the page's code and warms the API, so it isn't counted.
    for (let i = 0; i <= RUNS; i++) {
      there.push(await timed(page, "ready", () => nav(page, name).click()));
      back.push(await timed(page, "ready", () => nav(page, "Collection").click()));
    }
    check(`/ to ${route}`, "navigation", counted(there));
    check(`${route} to /`, "navigation", counted(back));
    checkNone(
      `/ to ${route} blank frames`,
      await blankFrames(page, () => timed(page, "ready", () => nav(page, name).click())),
    );
    checkNone(
      `${route} to / blank frames`,
      await blankFrames(page, () => timed(page, "ready", () => nav(page, "Collection").click())),
    );
  });
}

test("opening a species and going back", async ({ page }) => {
  await openReady(page, SEED_COLLECTION);
  const cards = page.locator('main a[href^="/species/"]');
  const open: Timing[] = [];
  const back: Timing[] = [];
  for (let i = 0; i <= RUNS; i++) {
    open.push(await timed(page, "ready", () => cards.nth(i).click()));
    back.push(await timed(page, "ready", "back"));
  }
  check("species open", "navigation", counted(open));
  check("species back", "navigation", counted(back));
  checkNone(
    "species back loading spinner frames",
    back.slice(1).reduce((n, t) => n + t.spinnerFrames, 0),
  );
  checkNone(
    "species open blank frames",
    await blankFrames(page, () => timed(page, "ready", () => cards.nth(RUNS + 1).click())),
  );
  checkNone("species back blank frames", await blankFrames(page, () => timed(page, "ready", "back")));
});

test("opening a photo in the Gallery", async ({ page }) => {
  await openReady(page, "/gallery");
  const tiles = page.getByTestId("photo-tile");
  const dialog = page.getByRole("dialog");
  const open = async (i: number) => {
    const timing = await timed(page, "photo", () => tiles.nth(i).getByRole("img").first().click());
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    return timing;
  };
  const timings: Timing[] = [];
  for (let i = 0; i <= RUNS; i++) timings.push(await open(i));
  check("photo open", "photo", counted(timings));
  checkNone("photo open blank frames", await blankFrames(page, () => open(RUNS + 1)));
});

for (const [name, route] of [
  ["Collection", "/"],
  ["Gallery", "/gallery"],
] as const) {
  test(`scrolling the ${name} keeps the main thread free`, async ({ page }) => {
    // The baseline keeps "/" as the Collection's name.
    await openReady(page, route === "/" ? SEED_COLLECTION : route);
    await page.mouse.move(640, 400);
    const longest: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await page.evaluate(() => {
        const w = window as unknown as { __longest: number; __observer?: PerformanceObserver };
        w.__observer?.disconnect();
        w.__longest = 0;
        w.__observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__longest = Math.max(w.__longest, entry.duration);
        });
        w.__observer.observe({ type: "longtask" });
        scrollTo(0, 0);
      });
      for (let step = 0; step < 30; step++) {
        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(500);
      // A scroll that never moved would measure nothing.
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(5000);
      longest.push(await page.evaluate(() => (window as unknown as { __longest: number }).__longest));
    }
    // Every scroll is counted: unlike page code, scrolling has no first-time cost to discard.
    check(`${route} longest task while scrolling`, "longTask", longest);
  });
}
