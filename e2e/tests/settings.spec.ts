// A settings change is saved on the server: it survives a reload and changes what the app shows.
// "Hide species almost nobody photographs" is on by default, and the fixture's Wood Frog has no reference photo or
// records, so it counts as obscure (apps/api/src/species/obscurity.ts).
import { SPECIES } from "../support/fixtureCatalog.js";
import { expect, test } from "../support/test.js";

const LABEL = "Hide species almost nobody photographs";
const hidden = SPECIES.woodFrog.commonName;

test("turning off the obscure-species filter persists across a reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await expect(page.getByText(hidden)).toHaveCount(0);

  await page.goto("/settings/species");
  const toggle = page.getByRole("switch", { name: LABEL });
  await expect(toggle).toBeChecked();
  // The switch only changes once the server has saved the change (settings/shared.tsx), so this
  // also keeps the reload below from racing the save.
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await page.reload();
  await expect(page.getByRole("switch", { name: LABEL })).not.toBeChecked();

  // The checklist now includes the obscure species.
  await page.goto("/");
  await expect(page.getByText(hidden).first()).toBeVisible();

  // Back to the default, so the specs after this one see the usual checklist.
  await page.goto("/settings/species");
  await page.getByRole("switch", { name: LABEL }).click();
  await expect(page.getByRole("switch", { name: LABEL })).toBeChecked();
});

// An install setting, on by default. The fixture catalog has no withheld photos, so turning it on
// never makes the server reach for iNaturalist.
test("the withheld photos setting is on by default and can be turned off", async ({ page }) => {
  const label = "Download missing reference photos";
  // It sits with the region downloads it fills in.
  await page.goto("/settings/species/downloads");
  const toggle = page.getByRole("switch", { name: label });
  await expect(toggle).toBeChecked();
  await expect(
    page.getByText("Some photos are left out of region downloads for licensing reasons.", { exact: false }),
  ).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole("switch", { name: label })).not.toBeChecked();

  await page.getByRole("switch", { name: label }).click();
  await expect(page.getByRole("switch", { name: label })).toBeChecked();
});

// File names sit in Library beside the folder layout; the example follows the chosen preset.
test("a file name preset persists and previews a name", async ({ page }) => {
  await page.goto("/settings/library");
  const select = page.getByRole("combobox", { name: "Name new photos" });
  await expect(select).toHaveValue("original");
  await select.selectOption("speciesDate");
  // Species, date, running number; the sample photo (empty library) numbers differently from a real one.
  await expect(page.getByText(/Example( with a sample photo)?:/)).toHaveText(/_\d{4}-\d{2}-\d{2}_\d{4}\.jpg$/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Name new photos" })).toHaveValue("speciesDate");
  await page.getByRole("combobox", { name: "Name new photos" }).selectOption("original");
  await expect(page.getByRole("combobox", { name: "Name new photos" })).toHaveValue("original");
});

test("sensitive species can be turned off, and the list says so", async ({ page }) => {
  const label = "Hide locations of sensitive species";
  await page.goto("/settings/metadata");
  await expect(page.getByRole("heading", { name: "Copyright and captions" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: label });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await page.getByRole("link", { name: "Sensitive species list" }).click();
  await expect(page.getByRole("heading", { name: "Sensitive species", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
});
