// A brand-new server: the one-time account creation, onboarding (which downloads the country's packs
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

  // Onboarding: the country, then its animal groups (every one, for the later specs), then done.
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Where do you photograph wildlife?" })).toBeVisible();
  await page.getByPlaceholder("Search for a country…").fill(COUNTRY.name.slice(0, 4));
  await page.getByRole("button", { name: COUNTRY.name, exact: true }).first().click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Which animals do you photograph?" })).toBeVisible();
  // Nothing starts chosen. Birds and mammals are groups on their own; "Add all" is the amphibian's group.
  await page.getByRole("button", { name: "Birds", exact: true }).click();
  await page.getByRole("button", { name: "Mammals", exact: true }).click();
  await page.getByRole("button", { name: "Add all" }).click();
  await page.getByRole("button", { name: "Download 1 country" }).click();

  await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Import your first photos" })).toBeVisible();
  await page.getByRole("button", { name: "Go to my collection" }).click();

  // The collection opens on the only downloaded country, with the packs' species in it.
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByText(SPECIES.chickadee.commonName).first()).toBeVisible();
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await expect(page.getByText("0 of 3 photographed")).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
