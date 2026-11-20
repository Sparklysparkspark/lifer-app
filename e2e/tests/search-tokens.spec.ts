// Long searches (N-07): a search of several parts shows each as a removable token, best guesses
// marked "probably". Light and dark screenshots of the tokens land in test-results/search-tokens.
import path from "node:path";
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const QUERY = "moose at blue hour, rule of thirds, with water in the background";
const SHOTS = path.join("test-results", "search-tokens");

test("shows a long search as removable tokens, in light and dark", async ({ page }) => {
  const trip = await seedTrip(page.request, "E2E Search tokens", [
    { file: "tokens-moose.jpg", species: SPECIES.moose, taken: "2015:10:01 06:30:00", tint: 190 },
    { file: "tokens-chickadee.jpg", species: SPECIES.chickadee, taken: "2015:10:01 12:00:00", tint: 191 },
  ]);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    // Init scripts run in order, so the latest theme wins on each load.
    await page.addInitScript((t) => localStorage.setItem("lifer-theme", t), theme);
    await page.goto(`/gallery?tripId=${trip.id}&q=${encodeURIComponent(QUERY)}`);
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    const tokens = page.getByRole("group", { name: "How your search was read" });
    await expect(tokens).toBeVisible();
    const remove = tokens.getByRole("button", { name: /^Remove filter: / });
    expect(await remove.count()).toBeGreaterThanOrEqual(2);
    await expect(tokens).toContainText("probably");
    await page.screenshot({ path: path.join(SHOTS, `gallery-${theme}.png`) });
    await tokens.screenshot({ path: path.join(SHOTS, `tokens-${theme}.png`) });
  }

  // Removing a token takes its words out of the search.
  const tokens = page.getByRole("group", { name: "How your search was read" });
  const first = tokens.getByRole("button", { name: /^Remove filter: / }).first();
  const label = (await first.getAttribute("aria-label"))!.replace("Remove filter: ", "");
  await first.click();
  await expect(tokens.getByRole("button", { name: `Remove filter: ${label}` })).toHaveCount(0);
  await expect(page.getByLabel("Search your photos by what's in them")).not.toHaveValue(QUERY);
});
