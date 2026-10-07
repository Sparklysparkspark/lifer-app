// A settings change is saved on the server: it survives a reload and changes what the app shows.
// "Hide obscure species" is on by default, and the fixture's Wood Frog has no reference photo or
// records, so it counts as obscure (apps/api/src/species/obscurity.ts).
import { SPECIES } from "../support/fixtureCatalog.js";
import { expect, test } from "../support/test.js";

const LABEL = "Hide obscure/inaccessible species from region checklists";
const hidden = SPECIES.woodFrog.commonName;

test("turning off the obscure-species filter persists across a reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await expect(page.getByText(hidden)).toHaveCount(0);

  await page.goto("/settings/species");
  const toggle = page.getByRole("checkbox", { name: LABEL });
  await expect(toggle).toBeChecked();
  // The box only changes once the server has saved the change (settings/shared.tsx), so this
  // also keeps the reload below from racing the save.
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await page.reload();
  await expect(page.getByRole("checkbox", { name: LABEL })).not.toBeChecked();

  // The checklist now includes the obscure species.
  await page.goto("/");
  await expect(page.getByText(hidden).first()).toBeVisible();

  // Back to the default, so the specs after this one see the usual checklist.
  await page.goto("/settings/species");
  await page.getByRole("checkbox", { name: LABEL }).click();
  await expect(page.getByRole("checkbox", { name: LABEL })).toBeChecked();
});

// An install setting, on by default. The fixture catalog has no withheld photos, so turning it on
// never makes the server reach for iNaturalist.
test("the withheld photos setting is on by default and can be turned off", async ({ page }) => {
  const label = "Fetch withheld photos in the background";
  await page.goto("/settings/offline-data");
  const toggle = page.getByRole("checkbox", { name: label });
  await expect(toggle).toBeChecked();
  await expect(
    page.getByText("Some photos can't be included in packs for licensing reasons.", { exact: false }),
  ).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: label })).not.toBeChecked();

  await page.getByRole("checkbox", { name: label }).click();
  await expect(page.getByRole("checkbox", { name: label })).toBeChecked();
});
