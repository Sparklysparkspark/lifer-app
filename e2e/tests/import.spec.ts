// Importing a photo: upload a camera JPEG on the Bulk import page, assign it a species, import,
// then find it in the Gallery and the species collected on its region checklist.
import { PHOTO_TAKEN, makeCameraJpeg } from "../support/photo.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { expect, test } from "../support/test.js";

const species = SPECIES.chickadee;

test("imports a photo, which shows in the Gallery and collects its species", async ({ page }, testInfo) => {
  const photoPath = testInfo.outputPath("chickadee.jpg");
  await makeCameraJpeg(photoPath);

  await page.goto("/import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "choose files" }).click();
  await (await chooser).setFiles(photoPath);

  // The row's species picker: search the catalog and pick the fixture species.
  await expect(page.getByText("chickadee.jpg")).toBeVisible();
  const picker = page.getByRole("combobox", { name: "Type a species…" });
  if (!(await picker.isVisible())) await page.getByRole("button", { name: "Type a species…" }).click();
  await picker.fill("chickadee");
  await page.getByRole("option", { name: new RegExp(species.commonName) }).click();
  await expect(page.getByText("1 ready to import")).toBeVisible();

  // Importing returns to the collection while the upload finishes in the background.
  await page.getByRole("button", { name: "Import 1 photo" }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByText("1 / 3 collected")).toBeVisible({ timeout: 20_000 });

  // The checklist's "Collected" view lists the species, and only it.
  await page.goto("/?show=collected");
  await expect(page.getByText(species.commonName).first()).toBeVisible();
  await expect(page.getByText(SPECIES.robin.commonName)).toHaveCount(0);

  // The Gallery shows the photo under its species' name. The collection card has an image of the
  // same name, so the image is looked for inside a photo-grid tile.
  await page.getByRole("navigation").getByRole("link", { name: "Gallery", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible();
  const tile = page.getByTestId("photo-tile").getByRole("img", { name: species.commonName });
  await expect(tile).toBeVisible();
  // The thumbnail actually loaded, rather than a broken image.
  await expect.poll(() => tile.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  // The species page dates the photo from its EXIF.
  await page.goto("/");
  await page.getByText(species.commonName).first().click();
  await expect(page.getByText(PHOTO_TAKEN.shown).first()).toBeVisible();
});
