// Real assertions for bugs that only show with a big library and real interaction: the region
// map remounting, blinking or framing the wrong place, a continent's outline missing countries,
// cards staying blank while scrolling, a menu jumping between positions, cards sharing a photo.
import type { ElementHandle, Locator, Page } from "@playwright/test";
import { markKnownFailure } from "../support/knownFailures.js";
import { HEADERS } from "../support/library.js";
import { REAL_SPECIES, realCountry } from "../support/realisticCatalog.js";
import { CARD_SIZES, expect, regionId, setCardSize, settle, test } from "./visual.js";

type Bounds = [number, number, number, number]; // west, south, east, north

const bounds = (value: string | null | undefined): Bounds => {
  const n = (value ?? "").split(",").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) throw new Error(`Not a bounds: ${value}`);
  return n as Bounds;
};

function outlineOf(names: string[]): { polygons: number; bounds: Bounds } {
  let polygons = 0;
  const b: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const name of names) {
    const { geometry } = realCountry(name).boundary;
    const shapes = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
    polygons += shapes.length;
    for (const [lon, lat] of shapes.flat(2) as unknown as Array<[number, number]>) {
      b[0] = Math.min(b[0], lon);
      b[1] = Math.min(b[1], lat);
      b[2] = Math.max(b[2], lon);
      b[3] = Math.max(b[3], lat);
    }
  }
  return { polygons, bounds: b };
}

const map = (page: Page) => page.getByTestId("region-map");

/** Waits for the map to draw `expected` and settle, then checks the camera holds all of it, centred. */
async function expectFramed(page: Page, expected: Bounds): Promise<void> {
  await expect
    .poll(async () => bounds(await map(page).getAttribute("data-outline-bounds")).map((x) => x.toFixed(2)))
    .toEqual(expected.map((x) => x.toFixed(2)));
  await expect(map(page)).toHaveAttribute("data-view-bounds", /./);
  const view = bounds(await map(page).getAttribute("data-view-bounds"));
  const slack = 0.5; // degrees, for MapLibre's rounding at the padding edge
  expect(view[0], "view's west edge").toBeLessThanOrEqual(expected[0] + slack);
  expect(view[1], "view's south edge").toBeLessThanOrEqual(expected[1] + slack);
  expect(view[2], "view's east edge").toBeGreaterThanOrEqual(expected[2] - slack);
  expect(view[3], "view's north edge").toBeGreaterThanOrEqual(expected[3] - slack);
  const centre = (b: Bounds) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const [vx, vy] = centre(view);
  const [ex, ey] = centre(expected);
  // Mercator puts a latitude span's centre off its midpoint, so latitude gets more room.
  expect(Math.abs(vx - ex), "view's centre longitude").toBeLessThan((view[2] - view[0]) * 0.1);
  expect(Math.abs(vy - ey), "view's centre latitude").toBeLessThan((view[3] - view[1]) * 0.25);
}

test.describe("region map", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("keeps one map and frames each region when moving between regions", async ({ page }) => {
    const northAmerica = outlineOf(["Canada", "Belize", "Costa Rica"]);
    await page.goto(`/?region=${await regionId(page, "North America")}`);
    await settle(page);
    await expectFramed(page, northAmerica.bounds);

    // Mark the canvas, and count every frame the map is missing or a canvas is removed.
    await page.evaluate(() => {
      const w = window as unknown as { __map: { missingFrames: number; removedCanvases: number } };
      w.__map = { missingFrames: 0, removedCanvases: 0 };
      document.querySelector("[data-testid=region-map] canvas")!.setAttribute("data-e2e-first", "");
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of Array.from(r.removedNodes)) {
            if (n instanceof Element && (n.matches("canvas") || n.querySelector("canvas"))) w.__map.removedCanvases++;
          }
      }).observe(document.body, { childList: true, subtree: true });
      const tick = () => {
        if (!document.querySelector("[data-testid=region-map] canvas")) w.__map.missingFrames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.getByRole("button", { name: "Canada", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`region=${await regionId(page, "Canada")}`));
    await expectFramed(page, outlineOf(["Canada"]).bounds);

    await page.getByRole("navigation", { name: "Region" }).getByRole("button", { name: "North America" }).click();
    await expect(page).toHaveURL(new RegExp(`region=${await regionId(page, "North America")}`));
    await expectFramed(page, northAmerica.bounds);

    const stats = await page.evaluate(() => (window as unknown as { __map: object }).__map);
    expect(stats, "the map never blinked out or was rebuilt").toEqual({ missingFrames: 0, removedCanvases: 0 });
    await expect(map(page).locator("canvas[data-e2e-first]"), "the same canvas is still mounted").toHaveCount(1);
  });

  test("North America's outline includes the Central America countries", async ({ page }) => {
    await page.goto(`/?region=${await regionId(page, "North America")}`);
    await settle(page);
    const expected = outlineOf(["Canada", "Belize", "Costa Rica"]);
    await expect(map(page)).toHaveAttribute("data-outline-polygons", String(expected.polygons));
    // Costa Rica is the southern edge: without it the outline would stop at Canada's border.
    expect(bounds(await map(page).getAttribute("data-outline-bounds"))[1]).toBeCloseTo(expected.bounds[1], 1);
  });
});

test.describe("collection grid", () => {
  test("cards fill in within two frames while fast-scrolling the smallest size on a wide window", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await setCardSize(page, CARD_SIZES.smallest);
    await page.goto(`/?region=${await regionId(page, "World")}`);
    await settle(page);

    // Scrolls 120px a frame (a fast flick) for 4 seconds, and for each card in view counts the
    // frames in a row it shows no picture, plus frames where a band of the grid has no cards.
    const result = await page.evaluate(
      () =>
        new Promise<{ worstBlankRun: number; worstCard: string; holeFrames: number; holes: string[]; frames: number }>(
          (resolve) => {
            const blankRuns = new Map<string, number>();
            let worstBlankRun = 0;
            let worstCard = "";
            let holeFrames = 0;
            const holes: string[] = [];
            let frames = 0;
            const loaded = (card: Element) =>
              Array.from(card.querySelectorAll("img")).some((img) => img.complete && img.naturalWidth > 0) ||
              !!card.querySelector("svg circle");
            const tick = () => {
              frames++;
              const cards = Array.from(document.querySelectorAll("a[data-scroll-anchor]")).filter((c) => {
                const r = c.getBoundingClientRect();
                return r.bottom > 0 && r.top < innerHeight;
              });
              const seen = new Set<string>();
              for (const card of cards) {
                const id = card.getAttribute("data-scroll-anchor")!;
                seen.add(id);
                const run = loaded(card) ? 0 : (blankRuns.get(id) ?? 0) + 1;
                blankRuns.set(id, run);
                if (run > worstBlankRun) [worstBlankRun, worstCard] = [run, card.textContent ?? id];
              }
              for (const id of blankRuns.keys()) if (!seen.has(id)) blankRuns.delete(id);
              // A hole: a gap between rows, or below the last one before the grid ends, taller than a card.
              const tops = cards.map((c) => c.getBoundingClientRect()).sort((a, b) => a.top - b.top);
              if (tops.length > 0) {
                const height = tops[0].height;
                let covered = Math.max(tops[0].top, 0);
                let hole = false;
                for (const r of tops) {
                  if (r.top - covered > height * 1.5) hole = true;
                  covered = Math.max(covered, r.bottom);
                }
                const pageEnd = document.documentElement.scrollHeight - window.scrollY;
                if (innerHeight - covered > height * 1.5 && pageEnd - covered > height * 3) hole = true;
                if (hole) {
                  holeFrames++;
                  holes.push(
                    `frame ${frames} y=${Math.round(window.scrollY)} cards=${cards.length} covered=${Math.round(covered)}`,
                  );
                }
              } else if (window.scrollY > 0) holeFrames++;
              if (frames < 240) {
                window.scrollBy(0, 120);
                requestAnimationFrame(tick);
              } else resolve({ worstBlankRun, worstCard, holeFrames, holes, frames });
            };
            requestAnimationFrame(tick);
          },
        ),
    );
    expect(result.holeFrames, `frames with a band of the grid missing: ${result.holes.join("; ")}`).toBe(0);
    expect(result.worstBlankRun, `longest run of frames a card stayed blank (${result.worstCard})`).toBeLessThanOrEqual(
      2,
    );
  });

  test("a card's dot menu near the window bottom holds its position", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?region=${await regionId(page, "Costa Rica")}`);
    await settle(page);
    // A card with its bottom edge 20px above the window's.
    const card = page.locator("a[data-scroll-anchor]").nth(20);
    await card.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - (innerHeight - 20)));
    await page.waitForLoadState("networkidle");
    await card.hover();
    const button = card.getByRole("button", { name: "More options" });
    await button.click();
    const panel = button.locator("xpath=following-sibling::*[1]");
    await expect(panel).toBeVisible();

    const rects = await panel.evaluate(
      (el) =>
        new Promise<string[]>((resolve) => {
          const out: string[] = [];
          const tick = () => {
            const r = el.getBoundingClientRect();
            out.push(`${r.left},${r.top},${r.width},${r.height}`);
            if (out.length < 10) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(new Set(rects).size, `the menu moved between frames: ${rects.join(" | ")}`).toBe(1);
    const [, top, , height] = rects[0].split(",").map(Number);
    expect(top + height, "the menu fits in the window").toBeLessThanOrEqual(800);
  });

  test("no two species cards in a region show the same picture", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setCardSize(page, CARD_SIZES.default);
    await page.goto(`/?region=${await regionId(page, "Costa Rica")}`);
    await settle(page);
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    // Every card in the region, a screen at a time.
    for (let atEnd = false; !atEnd;) {
      const pairs = await page
        .locator("a[data-scroll-anchor]")
        .evaluateAll((cards) =>
          cards.flatMap((c) =>
            Array.from(c.querySelectorAll("img[src]")).map((img) => [
              c.getAttribute("data-scroll-anchor")!,
              img.getAttribute("src")!,
            ]),
          ),
        );
      for (const [species, src] of pairs) {
        const key = src.replace(/[?&]retry=\d+/, "");
        const first = owner.get(key);
        if (!first) owner.set(key, species);
        else if (first !== species) clashes.push(`${key} on ${first} and ${species}`);
      }
      atEnd = await page.evaluate(() => {
        const before = scrollY;
        scrollBy(0, innerHeight);
        return scrollY === before;
      });
      await settle(page);
    }
    expect(owner.size, "pictures checked").toBeGreaterThan(1000);
    expect([...new Set(clashes)]).toEqual([]);
  });
});

test("lists a continent in field-guide order, like its countries", async ({ page }) => {
  // The fixture's catalog order is its index, so a list in taxonomic order has rising indexes.
  const order = new Map(REAL_SPECIES.map((s) => [s.scientificName, s.index]));
  const outOfOrder = async (url: string) => {
    const res = await page.request.get(url, { headers: HEADERS });
    expect(res.ok(), url).toBe(true);
    const { items } = (await res.json()) as { items: Array<{ scientificName: string }> };
    const indexes = items.map((i) => order.get(i.scientificName)!);
    return { count: indexes.length, outOfOrder: indexes.filter((x, k) => k > 0 && x < indexes[k - 1]).length };
  };
  const country = await outOfOrder(`/api/regions/${await regionId(page, "Costa Rica")}/species?filter=all`);
  expect(country.count).toBeGreaterThan(1000);
  expect(country.outOfOrder, "Costa Rica's list").toBe(0);
  const continent = await outOfOrder(`/api/regions/${await regionId(page, "North America")}/aggregate-species`);
  expect(continent.count).toBeGreaterThan(1000);
  expect(continent.outOfOrder, "North America's list").toBe(0);
});

test("card names fit in two lines at the smallest size on a wide window", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await setCardSize(page, CARD_SIZES.smallest);
  await page.goto(`/?region=${await regionId(page, "Canada")}`);
  await settle(page);
  // The name is the card's first paragraph and the second name the one after it; useFitText
  // shrinks each until it fits two lines, and the second line never ends in an ellipsis.
  const overflowing = await page.locator("a[data-scroll-anchor]").evaluateAll((cards) =>
    cards.flatMap((card) => {
      const name = card.querySelector("p");
      if (!name) return [];
      const second = name.nextElementSibling?.tagName === "P" ? (name.nextElementSibling as HTMLElement) : null;
      return [name, second].flatMap((el) => {
        if (!el) return [];
        const style = getComputedStyle(el);
        const lines = el.scrollHeight / parseFloat(style.lineHeight);
        const cut = style.textOverflow === "ellipsis" || el.scrollWidth > el.clientWidth + 1;
        return lines > 2.1 || cut
          ? [`${el.textContent} (${lines.toFixed(1)} lines at ${style.fontSize}${cut ? ", cut off" : ""})`]
          : [];
      });
    }),
  );
  expect(overflowing).toEqual([]);
});

// M1, M2: every menu and popover trigger nearest each window edge, at the smallest window.
test.describe("menus and popovers", () => {
  test.use({ viewport: { width: 800, height: 600 } });
  test.beforeEach(() => markKnownFailure(test.info()));

  const TRIGGERS = 'button[aria-haspopup="menu"], button:text-matches("^(Filters|View)( \\\\(\\\\d+\\\\))?$")';
  const PAGES: Array<{ name: string; url: (page: Page) => Promise<string> }> = [
    { name: "collection", url: async (page) => `/?region=${await regionId(page, "Costa Rica")}` },
    { name: "gallery", url: async () => "/gallery" },
    { name: "albums", url: async () => "/albums" },
    { name: "trips list", url: async () => "/albums?section=trips" },
    { name: "stats", url: async () => "/stats" },
    { name: "album detail", url: async (page) => firstLink(page, "/albums") },
    { name: "trip detail", url: async (page) => firstLink(page, "/trips") },
  ];

  async function firstLink(page: Page, list: string): Promise<string> {
    await page.goto(list);
    await settle(page);
    const href = await page.locator(`a[href^="${list}/"]`).first().getAttribute("href");
    if (!href) throw new Error(`${list} has no item to open`);
    return href;
  }

  /** The panel a trigger opened: a menu next to it, or the popover in the same wrapper. */
  const panelOf = async (trigger: Locator) =>
    (
      await trigger.evaluateHandle((el) => {
        const wrap = el.parentElement!;
        return wrap.querySelector<HTMLElement>('[role="menu"]') ?? wrap.querySelector<HTMLElement>(".shadow-lg");
      })
    ).asElement();

  /** One trigger nearest each window edge, so every edge is covered by something real. */
  async function edgeTriggers(page: Page): Promise<number[]> {
    return page.locator(TRIGGERS).evaluateAll((els) => {
      const seen = els.flatMap((el, i) => {
        const r = el.getBoundingClientRect();
        const inside = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0;
        return inside && r.bottom <= innerHeight && r.right <= innerWidth ? [{ i, r }] : [];
      });
      const best = (score: (r: DOMRect) => number) =>
        seen.reduce<{ i: number; r: DOMRect } | null>((a, b) => (!a || score(b.r) < score(a.r) ? b : a), null)?.i;
      const picks = [best((r) => r.top), best((r) => -r.bottom), best((r) => r.left), best((r) => -r.right)];
      return [...new Set(picks.filter((i): i is number => i !== undefined))];
    });
  }

  for (const entry of PAGES) {
    test(`${entry.name}: menus stay in the window, one at a time`, async ({ page }) => {
      await page.goto(await entry.url(page));
      await settle(page);
      const failures: string[] = [];
      const triggers = page.locator(TRIGGERS);
      let previous: { label: string; panel: ElementHandle<HTMLElement> } | null = null;

      for (const scrollTo of ["top", "bottom"] as const) {
        await page.evaluate(
          (to) => window.scrollTo(0, to === "top" ? 0 : document.documentElement.scrollHeight),
          scrollTo,
        );
        for (const index of await edgeTriggers(page)) {
          const trigger = triggers.nth(index);
          const label = `${scrollTo} trigger ${index} (${(await trigger.textContent())?.trim() || "dots"})`;
          // Measured after Playwright scrolls the trigger in, so only the panel's own scrolling counts.
          await trigger.scrollIntoViewIfNeeded();
          const [height, top] = await page.evaluate(() => [document.documentElement.scrollHeight, window.scrollY]);
          const clicked = await trigger.click({ timeout: 5_000 }).then(
            () => true,
            () => false,
          );
          if (!clicked) {
            failures.push(`${label}: covered by something still open, can't be clicked`);
            continue;
          }
          const panel = await panelOf(trigger);
          if (!panel) {
            failures.push(`${label}: no panel opened`);
            continue;
          }
          const state = await panel.evaluate((el) => {
            const r = el.getBoundingClientRect();
            let opacity = 1;
            for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
            return {
              inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
              rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
              opacity,
              height: document.documentElement.scrollHeight,
              top: window.scrollY,
            };
          });
          if (!state.inside) failures.push(`${label}: panel leaves the window (${state.rect})`);
          if (state.opacity !== 1) failures.push(`${label}: panel opacity ${state.opacity}`);
          if (state.height !== height)
            failures.push(`${label}: opening it changed the page height ${height} to ${state.height}`);
          if (state.top !== top) failures.push(`${label}: opening it scrolled the page ${top} to ${state.top}`);
          // M2: opening this one closed the previous one.
          if (
            previous &&
            (await previous.panel.evaluate(
              (el) => el.isConnected && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
            ))
          ) {
            failures.push(`${label}: ${previous.label} stayed open`);
          }
          previous = { label, panel };
        }
      }
      // M2: an outside click closes what is open.
      if (previous) {
        await page.mouse.click(2, 2);
        if (
          await previous.panel.evaluate(
            (el) => el.isConnected && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          )
        ) {
          failures.push(`${previous.label}: stayed open after a click outside`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
