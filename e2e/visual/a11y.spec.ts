// Accessibility: axe-core over the main pages of the realistic library, including colour contrast
// (which jsdom can't judge, see components/a11y.test.tsx). A page with a known violation is listed
// in e2e/known-failures.json and fails as expected until it is fixed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { markKnownFailure } from "../support/knownFailures.js";
import { HEADERS } from "../support/library.js";
import { REAL_SPECIES } from "../support/realisticCatalog.js";
import { MARKS } from "../support/realisticLibrary.js";
import { expect, settle, test } from "./visual.js";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

interface AxeResult {
  violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown[] }> }>;
}

async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() =>
    (window as unknown as { axe: { run: (c: Element, o: object) => Promise<AxeResult> } }).axe.run(document.body, {}),
  );
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const PAGES: Array<[string, string]> = [
  ["collection", "/"],
  ["gallery", "/gallery"],
  ["albums", "/albums"],
  ["import", "/import"],
  ["settings", "/settings"],
];

test.describe("axe", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  for (const [name, url] of PAGES) {
    test(`a11y: ${name}`, async ({ page }, info) => {
      markKnownFailure(info);
      await page.goto(url);
      await settle(page);
      expect(await violations(page)).toEqual([]);
    });
  }

  test("a11y: a species page", async ({ page }, info) => {
    markKnownFailure(info);
    const name = REAL_SPECIES[MARKS.cardCrops[0]].scientificName;
    const res = await page.request.get(`/api/species?q=${encodeURIComponent(name)}`, { headers: HEADERS });
    const { results } = (await res.json()) as { results: Array<{ id: string; scientific_name: string }> };
    await page.goto(`/species/${results.find((r) => r.scientific_name === name)!.id}`);
    await settle(page);
    expect(await violations(page)).toEqual([]);
  });
});
