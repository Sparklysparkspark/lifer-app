// The Collection's Add species menu downloads more animal groups for the countries in view: on a
// continent, the downloaded ones. The fixture's Canada starts without its amphibians here.
import { COUNTRY } from "../support/fixtureCatalog.js";
import { HEADERS } from "../support/library.js";
import { expect, test } from "../support/test.js";

const AMPHIBIANS = `${COUNTRY.name.toLowerCase()}-amphibia`;

test("downloads a missing group for a continent's countries from Add species", async ({ page }) => {
  test.setTimeout(90_000);
  const request = page.request;
  const status = async () => (await (await request.get("/api/offline-packs/download/status")).json()).running;
  const amphibiansDownloaded = async () => {
    const index = (await (await request.get("/api/offline-packs/index")).json()) as {
      packs: Array<{ id: string; downloaded: boolean }>;
    };
    return index.packs.find((p) => p.id === AMPHIBIANS)?.downloaded;
  };
  await expect.poll(status, { timeout: 30_000 }).toBe(false);
  expect((await request.delete(`/api/offline-packs/${AMPHIBIANS}`, { headers: HEADERS })).ok()).toBe(true);
  try {
    const regions = (await (await request.get("/api/regions")).json()) as {
      regions: Array<{ id: string; name: string }>;
    };
    const northAmerica = regions.regions.find((r) => r.name === "North America")!.id;
    await page.goto(`/?region=${northAmerica}`);

    await page.getByRole("button", { name: "+ Add species" }).click();
    await expect(page.getByRole("menuitem", { name: "Add one species by hand" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Download animal groups" }).click();
    const dialog = page.getByRole("dialog", { name: `Add animal groups for ${COUNTRY.name}` });
    const birds = dialog.getByRole("checkbox", { name: "Birds" });
    await expect(birds).toBeChecked();
    await expect(birds).toBeDisabled();
    const amphibians = dialog.getByRole("checkbox", { name: "Amphibians" });
    await expect(amphibians).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: "Download" })).toBeDisabled();

    await amphibians.check();
    await dialog.getByRole("button", { name: "Download" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(amphibiansDownloaded, { timeout: 30_000 }).toBe(true);
  } finally {
    // Later specs need every pack; a no-op when they are all there.
    await expect.poll(status, { timeout: 30_000 }).toBe(false);
    await request.post("/api/offline-packs/download-batch", {
      headers: HEADERS,
      data: { regionNames: [COUNTRY.name], taxa: "all" },
    });
    await expect.poll(status, { timeout: 30_000 }).toBe(false);
  }
});
