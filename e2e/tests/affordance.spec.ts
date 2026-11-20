// Every clickable thing reacts to the pointer, and every keyboard-focused thing shows a ring that
// fits its shape (ux-rules M5, Y1). One test per page, so the baseline can name the page.
import type { Locator, Page } from "@playwright/test";
import { markKnownFailure } from "../support/knownFailures.js";
import { expect, test } from "../support/test.js";

const PAGES = ["/", "/gallery", "/albums", "/stats", "/settings", "/import", "/settings/species/downloads"];
const CLICKABLE = "button, a[href], [role=button], [role=link]";
// Controls that look the same share their classes, so one of each kind stands for the rest.
const MAX_KINDS = 80;
const PROPS = [
  "color",
  "backgroundColor",
  "borderTopColor",
  "textDecorationLine",
  "boxShadow",
  "opacity",
  "transform",
  "filter",
  "outlineStyle",
] as const;

test.beforeEach(() => markKnownFailure(test.info()));

/** The control's own look plus its children's, since a hover often restyles only a child. */
// It runs in the browser, so the property list comes in as an argument.
function look(el: Element, props: readonly string[]): string {
  return [el, ...Array.from(el.querySelectorAll("*")).slice(0, 30)]
    .map((n) => {
      const s = getComputedStyle(n);
      return props.map((p) => String(s[p as keyof CSSStyleDeclaration])).join("|");
    })
    .join("\n");
}

async function settledLook(target: Locator): Promise<string> {
  // Transitions run for a few hundred ms; the look is final once two reads agree.
  let prev = "";
  for (let i = 0; i < 12; i++) {
    const cur = await target.evaluate(look, PROPS, { timeout: 2000 });
    if (cur === prev) return cur;
    prev = cur;
    await target.page().waitForTimeout(100);
  }
  return prev;
}

async function open(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

/** A short label for a failure message: the control's name and where it sits. */
function describe(el: Element): string {
  const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `${el.tagName.toLowerCase()} "${name}"`;
}

for (const route of PAGES) {
  test(`every control changes on hover: ${route}`, async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, route);
    const kinds = await page.evaluate(
      ([selector, max]) => {
        const seen = new Map<string, number>();
        const all = Array.from(document.querySelectorAll(selector as string));
        all.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const disabled = el.matches(":disabled, [aria-disabled=true]");
          if (r.width === 0 || r.height === 0 || disabled) return;
          const key = `${el.tagName}|${el.getAttribute("role")}|${el.className}`;
          if (!seen.has(key)) seen.set(key, i);
        });
        return [...seen.values()].slice(0, max as number);
      },
      [CLICKABLE, MAX_KINDS] as const,
    );

    const failures: string[] = [];
    let skipped = 0;
    for (const index of kinds) {
      const control = page.locator(CLICKABLE).nth(index);
      try {
        await page.mouse.move(0, 0);
        const before = await settledLook(control);
        await control.hover({ timeout: 2000 });
        const after = await settledLook(control);
        if (before === after) failures.push(await control.evaluate(describe));
      } catch {
        // Scrolled away, covered or removed while the page settled: not a hover problem.
        skipped++;
      }
    }
    expect(kinds.length, "no clickable controls found").toBeGreaterThan(0);
    expect(skipped, "most controls could not be hovered").toBeLessThan(kinds.length / 2 + 1);
    test
      .info()
      .annotations.push({ type: "hovered", description: `${kinds.length - skipped} of ${kinds.length} kinds` });
    expect(failures, "controls with no visible hover state").toEqual([]);
  });

  test(`keyboard focus shows a ring that fits: ${route}`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, route);
    await page.mouse.move(0, 0);
    // A control's shadow before focus (an elevated button) is not a ring.
    await page.evaluate(() => {
      const rest = new WeakMap<Element, string>();
      document.querySelectorAll("*").forEach((n) => rest.set(n, getComputedStyle(n).boxShadow));
      (window as unknown as { __rest: WeakMap<Element, string> }).__rest = rest;
    });
    const failures = new Set<string>();
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      const problem = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "end";
        const s = getComputedStyle(el);
        const rest = (window as unknown as { __rest: WeakMap<Element, string> }).__rest.get(el);
        const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
        const shadow = s.boxShadow !== "none" && s.boxShadow !== rest;
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        const name = `${el.tagName.toLowerCase()} "${label}"`;
        if (!outline && !shadow) return `${name}: no visible focus ring`;
        if (outline && shadow) return `${name}: double ring`;
        // An outline hugs the element's own corners, so a square element holding a rounded one
        // shows a rectangle.
        const squareOverRound =
          parseFloat(s.borderTopLeftRadius) === 0 &&
          Array.from(el.children).some((c) => parseFloat(getComputedStyle(c).borderTopLeftRadius) > 0);
        return squareOverRound ? `${name}: ring is square around a rounded child` : null;
      });
      if (problem === "end") break;
      if (problem) failures.add(problem);
    }
    expect([...failures], "focused controls with a missing or mismatched ring").toEqual([]);
  });
}
