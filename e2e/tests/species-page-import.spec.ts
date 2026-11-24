// Importing from a species page: the files go through the same review as the Import photos page,
// each already set to the page's species. A RAW is taken like any photo, and a file Lifer can't
// import is named with its reason instead of vanishing.
import { writeFileSync } from "node:fs";
import { makeCameraJpeg } from "../support/photo.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

test("a RAW imported from a species page keeps that species, and a file it can't read is named", async ({
  page,
}, testInfo) => {
  // exiftool reads by content, so a camera JPEG stands in for a CR3's bytes.
  const rawPath = testInfo.outputPath("6F9A8042.CR3");
  await makeCameraJpeg(rawPath, { tint: 140 });
  const notesPath = testInfo.outputPath("notes.txt");
  writeFileSync(notesPath, "not a photo");

  const robin = await speciesId(page.request, SPECIES.robin);
  await page.goto(`/species/${robin}`);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog");

  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose files", exact: true }).click();
  await (await chooser).setFiles([rawPath, notesPath]);

  await expect(dialog.getByRole("alert")).toHaveText(/notes\.txt/);
  await expect(dialog.getByText("6F9A8042.CR3")).toBeVisible();
  await expect(dialog.getByRole("button", { name: SPECIES.robin.commonName })).toBeVisible();

  // Every photo is going, so the window closes and the upload carries on in the background.
  await dialog.getByRole("button", { name: "Import 1 photo" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("1 photo filed under 1 species")).toBeVisible({ timeout: 20_000 });
});
