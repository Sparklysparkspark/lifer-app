// A brand-new server: the one-time account creation, onboarding (which downloads a region pack
// from the local mirror) and landing on the collection. Saves the session for the later specs.
import { ACCOUNT, AUTH_STATE_PATH } from "../support/constants.js";
import { COUNTRY, SPECIES } from "../support/fixtureCatalog.js";
import { expect, test } from "../support/test.js";

test("creates the account, finishes onboarding and lands on the collection", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Create the first account to get started.")).toBeVisible();

  await page.getByPlaceholder("Email").fill(ACCOUNT.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(ACCOUNT.password);
  await page.getByPlaceholder("Confirm password").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "Make account" }).click();

  // Onboarding: skip the two optional downloads, then the required region pack.
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Offline map" })).toBeVisible();
  await page.getByLabel("Download the offline map (recommended)").uncheck();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Species matching" })).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();

  await expect(page.getByRole("heading", { name: "Download a region" })).toBeVisible();
  await page.getByPlaceholder("Search for a country…").fill(COUNTRY.name.slice(0, 4));
  await page.getByRole("button", { name: COUNTRY.name, exact: true }).first().click();
  await page.getByRole("button", { name: "Download 1 region" }).click();
  await expect(page.getByText("Downloaded, 3 packs applied.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue to Lifer" }).click();

  await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();

  // The collection opens on the only downloaded country, with the packs' species in it.
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByText(SPECIES.chickadee.commonName).first()).toBeVisible();
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await expect(page.getByText("0 / 3 collected")).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
