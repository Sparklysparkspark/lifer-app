// Monkey testing (T-03): a seeded random walk of clicks, keys and page jumps over the main pages of
// the extreme, sparse and empty seeds, checking invariants after every step. The seed makes a run
// repeatable: a failure prints it, and MONKEY_SEED=<seed> replays the same walk.
//   MONKEY_STEPS (default 150 per seed library) sets the length; pre-release runs use 2000.
// Each project reseeds its library before the walk, so whatever the walk changes is thrown away.
import { expect, test, type Page } from "@playwright/test";
import { errorToasts } from "../support/test.js";
import { seedForProject, SWEEP_PAGES } from "../support/sweep.js";

const SEED = Number(process.env.MONKEY_SEED ?? 20261104);
const STEPS = Number(process.env.MONKEY_STEPS ?? 150);
const PAGES = [...SWEEP_PAGES, "/albums?view=trips", "/trash", "/tags"];
// Controls the walker never presses: they delete, sign out, leave the app or open a file picker.
const OFF_LIMITS =
  /delete|remove|empty|trash|sign out|log out|reset|erase|uninstall|unlink|revoke|disconnect|forget|quit|restart|choose|browse|download|export|import|update|install|move library|stop tracking/i;
const KEYS = [
  "Escape",
  "Tab",
  "Shift+Tab",
  "Enter",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "j",
  "k",
  "s",
  "g",
];
// Words that mean a developer's message reached the page.
const RAW_ERROR =
  /TypeError|ReferenceError|Cannot read propert|is not a function|undefined is not|\[object Object\]|Internal Server Error|Unexpected token/;
// Missing thumbnails on the seed are not the walker's concern.
const BENIGN_CONSOLE = /Failed to load resource: the server responded with a status of 404/;

// mulberry32: small, fast and the same on every system.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Marks every visible control the walker may press and returns their labels, by index. */
function markTargets(page: Page): Promise<string[]> {
  return page.evaluate((offLimits) => {
    const banned = new RegExp(offLimits, "i");
    const sel =
      'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], input[type="checkbox"], summary';
    const labels: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      el.removeAttribute("data-monkey");
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (banned.test(label)) continue;
      const href = el.getAttribute("href");
      if (href && (/^(https?:|mailto:)/.test(href) || el.getAttribute("target") === "_blank")) continue;
      if (el.closest("[data-monkey-skip]")) continue;
      el.setAttribute("data-monkey", String(labels.length));
      labels.push(`${el.tagName.toLowerCase()} "${label}"`);
    }
    return labels;
  }, OFF_LIMITS.source);
}

async function invariants(page: Page, problems: string[]): Promise<string[]> {
  // A full page load (a jump, or back across one) takes a moment to render the app.
  await page
    .locator("nav")
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => {});
  const found = [...problems];
  problems.length = 0;
  const state = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    nav: !!document.querySelector("nav"),
    text: document.body.innerText,
  }));
  if (state.overflow > 1) found.push(`the page scrolls sideways by ${state.overflow}px`);
  if (!state.nav && !/\/login/.test(page.url())) found.push("the sidebar is gone");
  const raw = state.text.match(RAW_ERROR);
  if (raw) found.push(`raw error text on the page: "${raw[0]}"`);
  if ((await errorToasts(page).count()) > 0) found.push(`error toast: ${await errorToasts(page).first().innerText()}`);
  return found;
}

seedForProject();

test("a random walk keeps every invariant", async ({ page }) => {
  test.setTimeout(60_000 + STEPS * 2_000);
  const seed = SEED + ["extreme", "sparse", "empty"].indexOf(test.info().project.name);
  const rand = random(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const problems: string[] = [];
  // The update check asks GitHub from the page; offline like the server, and never its rate limit.
  await page.route("https://api.github.com/**", (route) => route.fulfill({ json: {} }));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !BENIGN_CONSOLE.test(msg.text())) problems.push(`console.error: ${msg.text()}`);
  });
  page.on("dialog", (dialog) => void dialog.dismiss());

  const log: string[] = [];
  await page.goto(pick(PAGES));
  for (let step = 1; step <= STEPS; step++) {
    const roll = rand();
    const before = new URL(page.url());
    // Chromium's Navigation API: a push moves the index on, a redirect (replace) does not.
    const entryIndex = () =>
      page.evaluate(
        () => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index,
      );
    const depth = await entryIndex();
    let action: string;
    if (roll < 0.08) {
      action = `go to ${pick(PAGES)}`;
      await page.goto(action.slice(6));
    } else if (roll < 0.3) {
      const key = pick(KEYS);
      action = `press ${key}`;
      await page.keyboard.press(key);
    } else {
      const targets = await markTargets(page);
      if (targets.length === 0) {
        action = "press Escape (nothing to press)";
        await page.keyboard.press("Escape");
      } else {
        const i = Math.floor(rand() * targets.length);
        action = `click ${targets[i]}`;
        // A control that moved or got covered since it was marked is skipped, not a failure.
        await page
          .locator(`[data-monkey="${i}"]`)
          .click({ timeout: 1_500 })
          .catch(() => (action += " (missed)"));
      }
    }
    await page.waitForTimeout(150);
    log.push(`${step}: ${action}`);

    // Back works: a step that opened another page goes back to where it was, now and then.
    const after = new URL(page.url());
    if (after.origin !== before.origin) {
      log.push(`${step}: left the app for ${after.origin}`);
      await page.goBack();
    } else if (after.pathname !== before.pathname && (await entryIndex()) === depth + 1 && rand() < 0.3) {
      await page.goBack();
      await page.waitForTimeout(150);
      log.push(`${step}: back`);
      expect(new URL(page.url()).pathname, `back after step ${step} (seed ${seed})\n${log.slice(-15).join("\n")}`).toBe(
        before.pathname,
      );
    }

    const broken = await invariants(page, problems);
    expect(broken, `step ${step} on ${page.url()} (seed ${seed})\n${log.slice(-15).join("\n")}`).toEqual([]);
  }
});
